import { useEffect, useState } from 'react';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { AppState, Platform } from 'react-native';
import { api } from './api';

// Hardcoded fallback in case Constants.expoConfig is unavailable (this happens
// in some standalone build configurations). Keep in sync with app.json →
// extra.eas.projectId. Without a projectId, getExpoPushTokenAsync() throws on
// FCM/APNs builds and push tokens never register.
const HARDCODED_EAS_PROJECT_ID = '11cb65a8-eab0-4745-9b4a-7b8964805381';

export type PushStatus =
  | { state: 'unknown' }
  | { state: 'unsupported'; reason: string }
  | { state: 'permission_denied' }
  | { state: 'no_project_id' }
  | { state: 'token_error'; error: string }
  | { state: 'api_error'; error: string }
  | { state: 'registered'; token: string };

let lastStatus: PushStatus = { state: 'unknown' };
const listeners = new Set<(s: PushStatus) => void>();
function setStatus(s: PushStatus) {
  lastStatus = s;
  listeners.forEach((cb) => cb(s));
}
export function getPushStatus(): PushStatus {
  return lastStatus;
}
export function subscribePushStatus(cb: (s: PushStatus) => void): () => void {
  listeners.add(cb);
  cb(lastStatus);
  return () => listeners.delete(cb);
}

// In-foreground notification display behavior. shouldShowBanner=true ensures
// the heads-up appears even when the app is open in the foreground.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    priority: Notifications.AndroidNotificationPriority.MAX,
  }),
});

// ---------- Notification Categories (action buttons) ----------
//
// Categories must be registered BEFORE the first push that references one
// arrives. We register on app startup via ensureNotificationCategories().
//
// v6.4 accessibility tuning: button labels are intentionally short,
// emoji-led, and UPPERCASE so the Android system renders them at the
// largest possible action-button typography weight.
async function ensureNotificationCategories() {
  try {
    await Notifications.setNotificationCategoryAsync('MEDICATION_DUE', [
      {
        identifier: 'TOOK_IT',
        buttonTitle: '✅  TOOK IT',
        options: {
          opensAppToForeground: false,  // Mark taken silently — no UI interrupt
        },
      },
      {
        identifier: 'SNOOZE_10',
        buttonTitle: '⏰  SNOOZE',
        options: {
          opensAppToForeground: false,
        },
      },
    ]);
    await Notifications.setNotificationCategoryAsync('ROUTINE_DUE', [
      {
        identifier: 'DONE',
        buttonTitle: '✅  DONE',
        options: {
          opensAppToForeground: false,
        },
      },
    ]);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('Failed to register notification categories:', e);
  }
}

// ---------- Android Notification Channels ----------
//
// v6.4: stronger vibration patterns + verbose body text so the OS
// auto-expands the notification (Android uses BigTextStyle when the body
// is longer than the collapsed line). Channel importance MAX guarantees
// the heads-up appears and the system keeps it in the tray.
export async function ensureNotificationChannel() {
  if (Platform.OS !== 'android') return;
  try {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Kinnship alerts',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 350, 250, 350],
      lightColor: '#1B5E35',
      sound: 'default',
      enableVibrate: true,
      showBadge: true,
    });
    // Medications — heads-up, persistent, with action buttons.
    // Channel ID is 'meds_v2' (not 'meds') to force Android to register a
    // fresh channel with the MAX importance + default sound settings below.
    // Android caches channel settings at first-creation time and ignores
    // later code-side changes; bumping the ID is the standard escape hatch.
    // Best-effort: delete the legacy 'meds' channel so users don't see a
    // dead entry in the system app-notification settings.
    try { await Notifications.deleteNotificationChannelAsync('meds'); } catch (_e) {}
    await Notifications.setNotificationChannelAsync('meds_v2', {
      name: 'Medication reminders',
      description: 'Time-to-take, family alerts, and refill reminders',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 500, 250, 500, 250, 500],
      lightColor: '#1B5E35',
      sound: 'default',
      enableVibrate: true,
      enableLights: true,
      showBadge: true,
    });
    await Notifications.setNotificationChannelAsync('routines', {
      name: 'Daily routines',
      description: 'Walks, hydration, meals, and other routine nudges',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 300, 150, 300],
      lightColor: '#1B5E35',
      sound: 'default',
      enableVibrate: true,
      showBadge: true,
    });
    await Notifications.setNotificationChannelAsync('sos', {
      name: 'SOS emergencies',
      description: 'Critical safety alerts — never silenced',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 800, 300, 800, 300, 800],
      lightColor: '#DC2626',
      sound: 'default',
      enableVibrate: true,
      enableLights: true,
      showBadge: true,
      bypassDnd: true,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('Failed to set Android notification channels:', e);
  }
}

// ---------- Public: OS-side setup that runs BEFORE auth ----------
//
// Channels, categories, and stale-queue cleanup must exist on the
// device BEFORE any push notification can arrive — otherwise FCM
// payloads carrying `channelId: "meds_v2"` (or any other modern
// channel) silently route to the low-importance fallback channel
// and the user either sees nothing or hears nothing.
//
// The legacy `registerForPushNotifications()` only ran AFTER the
// user authenticated (it needs an auth token to POST the push
// token to /auth/push-token).  That left a window — first launch
// before login, app killed for a long time then woken by a push —
// where the channels didn't exist.  Result: SOS still worked
// because the `'sos'` channel has been on every install since v1,
// but medication / check-in / fall-detected pushes were silently
// dropped.  This was the #1 pre-launch safety bug.
//
// Call this function from RootNav's outermost mount effect, before
// the auth gate runs.  It's idempotent (channel + category
// creation are upsert-style) so calling it multiple times is safe.
export async function setupNotificationsForOS(): Promise<void> {
  try {
    if (Platform.OS === 'web' || !Device.isDevice) return;
    // Phantom-queue cleanup (v6.11.5 — see notes in
    // registerForPushNotifications below for full context).
    try {
      await Notifications.cancelAllScheduledNotificationsAsync();
    } catch (_e) {}
    await ensureNotificationChannel();
    await ensureNotificationCategories();
  } catch (_e) {
    // Never crash the app on startup setup errors.
  }
}


export async function registerForPushNotifications(): Promise<string | null> {
  try {
    if (Platform.OS === 'web') {
      setStatus({ state: 'unsupported', reason: 'web preview' });
      return null;
    }
    if (!Device.isDevice) {
      setStatus({ state: 'unsupported', reason: 'simulator/emulator' });
      return null;
    }

    // OS-side setup is now also called pre-auth from RootNav, but call
    // it again here for callers that invoke registerForPushNotifications
    // directly (e.g. Settings → "Retry push registration").  Idempotent.
    await setupNotificationsForOS();

    const { status: existing } = await Notifications.getPermissionsAsync();
    let finalStatus = existing;
    if (existing !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== 'granted') {
      setStatus({ state: 'permission_denied' });
      return null;
    }

    const projectId =
      process.env.EXPO_PUBLIC_EAS_PROJECT_ID ||
      Constants?.expoConfig?.extra?.eas?.projectId ||
      (Constants as any)?.easConfig?.projectId ||
      HARDCODED_EAS_PROJECT_ID;

    if (!projectId || projectId === 'REPLACE_WITH_EAS_PROJECT_ID') {
      setStatus({ state: 'no_project_id' });
      return null;
    }

    let token: string;
    try {
      const r = await Notifications.getExpoPushTokenAsync({ projectId });
      token = r.data;
    } catch (e: any) {
      setStatus({ state: 'token_error', error: e?.message || String(e) });
      return null;
    }

    if (!token) {
      setStatus({ state: 'token_error', error: 'empty token returned' });
      return null;
    }

    try {
      await api.post('/auth/push-token', { token, platform: Platform.OS });
      setStatus({ state: 'registered', token });
      return token;
    } catch (e: any) {
      setStatus({ state: 'api_error', error: e?.message || String(e) });
      return null;
    }
  } catch (e: any) {
    setStatus({ state: 'token_error', error: e?.message || String(e) });
    return null;
  }
}

// ---------- Notification persistence + de-duplication ----------
//
// Bug 1 (v6.5): notifications were stacking — every fire created a NEW
// row in the tray instead of replacing the prior one for the same
// reminder. We now derive a STABLE identifier per reminder+stage and pass
// it as the local notification `identifier`. Android replaces any prior
// notification with the same identifier so the user sees a single,
// latest row per reminder.
//
// Identifier scheme (Option B per user spec):
//   medication self-due  → 'med_<reminder_id>_due'
//   medication family    → 'med_<reminder_id>_family'
//   medication refill    → 'med_<reminder_id>_refill'
//   routine due          → 'rt_<reminder_id>_due'
//   sos                  → 'sos_<alert_id>'    (per-alert is OK; SOSs are rare)
//   fall_detected        → 'fall_<alert_id>'
//   missed_checkin       → 'miss_<member_id>'  (per-member; auto-dedupes)
function stableNotificationId(data: any): string | null {
  const t = data?.type;
  const sub = data?.subtype;
  const stage = data?.stage;
  const rid = data?.reminder_id;
  const aid = data?.alert_id;
  const mid = data?.member_id;
  if (t === 'medication' && rid) {
    if (stage === 'refill' || sub === 'refill') return `med_${rid}_refill`;
    if (stage === 'family_alert' || sub === 'family_alert') return `med_${rid}_family`;
    return `med_${rid}_due`;
  }
  if (t === 'routine' && rid) return `rt_${rid}_due`;
  if (t === 'sos' && aid) return `sos_${aid}`;
  if (t === 'fall_detected' && aid) return `fall_${aid}`;
  if (t === 'missed_checkin' && mid) return `miss_${mid}`;
  return null;
}

async function rePresentSticky(n: Notifications.Notification) {
  if (Platform.OS !== 'android') return;
  const content = n.request.content;
  const data: any = content.data || {};
  const t = data.type;
  if (!t || !['medication', 'routine', 'sos', 'fall_detected'].includes(t)) return;

  // ============================================================
  //  CRITICAL: ONLY re-present when the app is in FOREGROUND.
  // ============================================================
  //
  // `addNotificationReceivedListener` fires when a notification is
  // received while the app's JS context is alive — that includes both
  // FOREGROUND and BACKGROUND states on Android.
  //
  // When the app is BACKGROUNDED (user pressed Home, screen off, etc.),
  // Android throttles the JS thread.  Any `dismissNotificationAsync()` +
  // `scheduleNotificationAsync()` calls we make in this throttled state
  // get QUEUED in the JS event loop — they do not execute until the OS
  // wakes JS back up (which only happens when the user re-opens the app).
  //
  // Result: the OS-displayed notification gets immediately removed by the
  // dismiss call (which IS synchronous to the OS via the native bridge),
  // BUT the replacement schedule is held until JS resumes.  The user sees
  // NOTHING in the tray, even though the push arrived.  Then when they
  // open the app, every queued scheduleNotificationAsync from every
  // missed push fires at once → "notifications flood in after login".
  //
  // SOS doesn't hit this because caregivers/recipients are typically
  // already in-app when an SOS arrives.  Meds/check-ins/family alerts
  // fire on autonomous schedules and overwhelmingly arrive when the app
  // is backgrounded — exactly the broken case.
  //
  // Fix: skip rePresentSticky unless the app is truly foreground-active.
  // In background, we trust the OS-displayed notification (delivered
  // automatically by FCM via the channel's MAX importance) and DO NOT
  // dismiss it.  The user sees the heads-up immediately, as expected.
  //
  // Defense-in-depth: also bail on notifications older than 30s — those
  // are queued replays surfaced by the OS during cold-start, not live
  // pushes that need foreground sticky treatment.
  try {
    if (AppState.currentState !== 'active') return;
    const receivedAtMs = (n as any)?.date ? Number((n as any).date) : Date.now();
    if (Number.isFinite(receivedAtMs) && Date.now() - receivedAtMs > 30000) return;
  } catch (_e) {
    // If AppState/date introspection fails, default to NOT touching the
    // OS-displayed notification — same conservative path as background.
    return;
  }

  const channelId =
    data.channelId ||
    (t === 'sos' || t === 'fall_detected' ? 'sos' : t === 'routine' ? 'routines' : 'meds_v2');
  const cat = data.categoryIdentifier;
  const stableId = stableNotificationId(data);

  // Use a longer body so Android auto-expands the notification
  // (BigTextStyle), making the "✅ TOOK IT" action buttons immediately
  // visible without the user having to swipe down.
  const body = content.body || '';
  const expanded = body.length >= 60
    ? body
    : (body + '\n\nTap to open Kinnship and acknowledge.');

  try {
    // Dismiss the auto-displayed push first so we don't have a duplicate.
    try {
      await Notifications.dismissNotificationAsync(n.request.identifier);
    } catch (_e) {}
    // Also dismiss any prior sticky notification with the same stable id —
    // this guarantees ONE row per reminder+stage at all times.
    if (stableId) {
      try {
        await Notifications.dismissNotificationAsync(stableId);
      } catch (_e) {}
    }
    await Notifications.scheduleNotificationAsync({
      identifier: stableId || undefined,  // <-- KEY: stable id makes new fires REPLACE
      content: {
        title: content.title || '',
        body: expanded,
        data,
        sound: 'default',
        categoryIdentifier: cat,
        sticky: true,        // can't be swiped away on Android
        autoDismiss: false,  // doesn't auto-dismiss on tap
        priority: Notifications.AndroidNotificationPriority.MAX,
        color: (t === 'sos' || t === 'fall_detected') ? '#DC2626' : '#1B5E35',
      } as any,
      trigger: { channelId } as any,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('Failed to re-present sticky:', e);
  }
}

// ---------- Pending deep-link queue (race-condition-free) ----------
//
// Why this exists:
//   When the user taps a notification while the app is KILLED,
//   Android cold-launches the app via the push intent. During that
//   cold-start window:
//     1) React Native takes ~600-1500ms to bootstrap.
//     2) RootNav (_layout.tsx) mounts and runs its auth + PIN gate,
//        which fires `router.replace('/pin-login')` or '/dashboard'.
//     3) useNotificationListeners mounts SLIGHTLY LATER and would
//        fire `router.push('/(modals)/acknowledge')`.
//
//   Two race outcomes were both broken:
//     a) listener mounts AFTER the OS already delivered the response
//        → the deep-link callback never fires → user lands on the
//        dashboard, never sees the acknowledge screen.
//     b) listener fires BEFORE RootNav's gate-redirect completes →
//        gate-redirect overwrites the deep-link → flicker back to
//        dashboard/PIN/home screen (Android user reported "returns
//        to phone home screen").
//
// The fix:
//   • Notification response → enqueue data in a module-level slot
//     (do NOT call router synchronously).
//   • Also synchronously check Notifications.getLastNotificationResponseAsync()
//     in useNotificationListeners' mount so cold-start responses
//     received BEFORE the JS listener was attached are recovered.
//   • RootNav, after its auth + PIN gate has fully cleared, calls
//     setAppReadyForDeepLink(true) which flushes any queued data
//     through the same onAlert callback.
//
// This guarantees notification taps ALWAYS land on the acknowledge /
// alerts screen, never flicker back, and never lose the deep-link to
// a cold-start race.

let pendingDeepLinkData: any = null;
let liveOnAlert: ((data: any) => void) | null = null;
let appReadyForDeepLink = false;

// Set of notification request IDs we have ALREADY enqueued as
// deep-links during this app launch. Used to prevent the same
// notification from getting re-deep-linked on every listener remount.
//
// Why this exists: `Notifications.getLastNotificationResponseAsync()`
// on Android keeps returning the SAME response object across
// repeated calls (the OS treats it as "the last notification
// response that launched/resumed the app"). Our useNotificationListeners
// hook re-runs its effect every time its `onAlert` dependency
// changes (which happens on every RootNav render, because the
// inline arrow function is fresh each time). So on every RootNav
// render we were re-enqueueing the same notification → router
// bounced back to /(modals)/acknowledge after the user already
// dismissed it. The medication-follow-up "acknowledge loop" bug.
const consumedNotificationIds = new Set<string>();
function markNotificationConsumed(id?: string | null): void {
  if (id) consumedNotificationIds.add(id);
}
function isNotificationConsumed(id?: string | null): boolean {
  return !!id && consumedNotificationIds.has(id);
}

function tryFlush() {
  if (!appReadyForDeepLink) return;
  const data = pendingDeepLinkData;
  if (!data || !liveOnAlert) return;
  pendingDeepLinkData = null;
  // Dispatch on next microtask so any in-flight router.replace from
  // RootNav has committed before our deep-link push runs.
  setTimeout(() => {
    try { liveOnAlert?.(data); } catch (_e) {}
  }, 0);
}

export function setAppReadyForDeepLink(ready: boolean): void {
  appReadyForDeepLink = ready;
  if (ready) tryFlush();
}

export function enqueueDeepLink(data: any): void {
  if (!data) return;
  // If the app is already ready, fire immediately — no flicker.
  // Otherwise queue until RootNav signals ready.
  pendingDeepLinkData = data;
  tryFlush();
}

// ---------- Notification response handler ----------
//
// Fires when the user interacts with a notification:
//   • Taps the body            → actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER
//   • Taps "I Took It" / "Done" → actionIdentifier matches the category action id
//
// `onAlert` is called for body-taps; action-button taps are handled here so
// we can mark the medication as taken silently without opening the app.
export function useNotificationListeners(onAlert?: (data: any) => void) {
  const [last, setLast] = useState<Notifications.Notification | null>(null);
  useEffect(() => {
    // Register the live alert callback so the pending-deep-link queue
    // can fire it whenever RootNav signals app-ready.
    liveOnAlert = onAlert || null;
    // RACE FIX: if the queue is ALREADY ready AND there's pending
    // data, attempt the flush right now.  Previously the only
    // triggers for tryFlush were setAppReadyForDeepLink(true) and
    // enqueueDeepLink(...) — but both can race with this effect's
    // cleanup→remount cycle, where the cleanup sets liveOnAlert=null
    // and the very next setAppReadyForDeepLink(true) tryFlush bails
    // out because liveOnAlert was momentarily null.  With nothing
    // later to retrigger, the deep-link data sat queued forever.
    // Net effect: user passed the PIN gate but landed on the
    // dashboard instead of the specific /alert/[id].  By calling
    // tryFlush() here whenever liveOnAlert is freshly attached,
    // we close that race — any data queued during the null window
    // gets flushed on the next mount.
    tryFlush();

    // COLD-START RECOVERY: if the OS launched the app via a notification
    // intent BEFORE our JS listener was attached, the response will be
    // available here. We enqueue it so it fires once RootNav clears the
    // auth + PIN gate.
    //
    // IMPORTANT — only fire ONCE per notification id per launch. Without
    // this guard, every re-render of RootNav (which has an inline
    // `onAlert` arrow function as the only dep on this effect) re-runs
    // the effect, which re-fires `getLastNotificationResponseAsync()` —
    // and Android keeps returning the SAME response forever, so the
    // same notification would get deep-linked again and again, bouncing
    // the user back to /(modals)/acknowledge after they already
    // dismissed it. (See "medication acknowledge loop" bug.)
    (async () => {
      try {
        const cold = await Notifications.getLastNotificationResponseAsync();
        if (cold && cold.actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER) {
          const reqId = cold.notification?.request?.identifier;
          if (isNotificationConsumed(reqId)) return;
          const data: any = cold.notification?.request?.content?.data || {};
          if (data && data.type) {
            markNotificationConsumed(reqId);
            enqueueDeepLink(data);
          }
        }
      } catch (_e) {}
    })();

    const recv = Notifications.addNotificationReceivedListener((n) => {
      setLast(n);
      // Re-present critical notifications as sticky to keep them in tray.
      rePresentSticky(n);
    });
    const resp = Notifications.addNotificationResponseReceivedListener(async (r) => {
      const data: any = r.notification.request.content.data || {};
      const actionId = r.actionIdentifier;
      const reqId = r.notification.request.identifier;

      // Action button taps — silent mark-taken / snooze.
      if (actionId === 'TOOK_IT' || actionId === 'DONE') {
        markNotificationConsumed(reqId);
        const rid = data.reminder_id;
        if (rid) {
          try {
            await api.post(`/reminders/${rid}/mark`, { status: 'taken' });
            try {
              await Notifications.dismissNotificationAsync(reqId);
            } catch (_e) {}
          } catch (_e) {}
        }
        return;
      }
      if (actionId === 'SNOOZE_10') {
        markNotificationConsumed(reqId);
        const rid = data.reminder_id;
        try {
          await Notifications.scheduleNotificationAsync({
            content: {
              title: r.notification.request.content.title || '💊 Medication reminder',
              body: r.notification.request.content.body || 'Tap "TOOK IT" to confirm.',
              data,
              categoryIdentifier: 'MEDICATION_DUE',
              sound: 'default',
              sticky: true,
              autoDismiss: false,
            } as any,
            trigger: { seconds: 600, channelId: 'meds_v2' } as any,
          });
        } catch (_e) {}
        try {
          await Notifications.dismissNotificationAsync(r.notification.request.identifier);
        } catch (_e) {}
        return;
      }

      // Default tap on body — route through the queue so RootNav's
      // auth + PIN gate has a chance to clear before we deep-link.
      // If the app is already ready, the queue fires immediately —
      // no perceptible delay. If the gate is still being evaluated
      // (cold start, PIN unlock pending), the deep-link is held
      // until ready, eliminating the flicker-back-to-home bug.
      //
      // Mark this notification id as consumed so the cold-start
      // recovery branch above doesn't re-enqueue it on the next
      // useEffect re-run. This is the core fix for the "acknowledge
      // loops back" bug — see the consumedNotificationIds doc-block
      // for the full backstory.
      markNotificationConsumed(reqId);
      enqueueDeepLink(data);
    });
    return () => {
      recv.remove();
      resp.remove();
      liveOnAlert = null;
    };
  }, [onAlert]);
  return last;
}
