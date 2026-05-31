import { useEffect, useState } from 'react';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
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
    await Notifications.setNotificationChannelAsync('meds', {
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

    await ensureNotificationChannel();
    await ensureNotificationCategories();

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

// ---------- Notification persistence layer ----------
//
// PROBLEM (Bug 3): Push notifications were vanishing from the heads-up
// banner within seconds, before elderly users could read them or tap
// the action buttons.
//
// ROOT CAUSE: Android's default heads-up display lifetime is OS-controlled
// (~5 seconds).  The Expo Push API does not expose `sticky` / `autoDismiss`
// in its payload contract — those flags only exist on LOCAL notifications.
//
// FIX: On `addNotificationReceivedListener`, immediately re-present the
// content as a LOCAL notification with `sticky: true` and
// `autoDismiss: false`.  We then dismiss the auto-displayed original.
// Result: the notification stays in the tray (and re-shows the heads-up
// with a longer body that forces Android into BigTextStyle, which keeps
// the action buttons immediately visible).
//
// Only applied to medication / routine / sos / family_alert notifications
// — informational types still behave normally.
async function rePresentSticky(n: Notifications.Notification) {
  if (Platform.OS !== 'android') return;
  const content = n.request.content;
  const data: any = content.data || {};
  const t = data.type;
  if (!t || !['medication', 'routine', 'sos'].includes(t)) return;

  const channelId =
    data.channelId ||
    (t === 'sos' ? 'sos' : t === 'routine' ? 'routines' : 'meds');
  const cat = data.categoryIdentifier;

  // Use a longer body so Android auto-expands the notification
  // (BigTextStyle), making the "✅ TOOK IT" action buttons immediately
  // visible without the user having to swipe down.
  const body = content.body || '';
  const expanded = body.length >= 60
    ? body
    : (body + '\n\nTap an action button below or open Kinnship to confirm.');

  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: content.title || '',
        body: expanded,
        data,
        sound: 'default',
        categoryIdentifier: cat,
        sticky: true,        // can't be swiped away on Android
        autoDismiss: false,  // doesn't auto-dismiss on tap
        priority: Notifications.AndroidNotificationPriority.MAX,
        color: t === 'sos' ? '#DC2626' : '#1B5E35',
      } as any,
      trigger: { channelId } as any,
    });
    // Dismiss the auto-displayed push so we don't have a duplicate.
    try {
      await Notifications.dismissNotificationAsync(n.request.identifier);
    } catch (_e) {}
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('Failed to re-present sticky:', e);
  }
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
    const recv = Notifications.addNotificationReceivedListener((n) => {
      setLast(n);
      // Re-present critical notifications as sticky to keep them in tray.
      rePresentSticky(n);
    });
    const resp = Notifications.addNotificationResponseReceivedListener(async (r) => {
      const data: any = r.notification.request.content.data || {};
      const actionId = r.actionIdentifier;

      // Action button taps — silent mark-taken / snooze.
      if (actionId === 'TOOK_IT' || actionId === 'DONE') {
        const rid = data.reminder_id;
        if (rid) {
          try {
            await api.post(`/reminders/${rid}/mark`, { status: 'taken' });
            try {
              await Notifications.dismissNotificationAsync(r.notification.request.identifier);
            } catch (_e) {}
          } catch (_e) {}
        }
        return;
      }
      if (actionId === 'SNOOZE_10') {
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
            trigger: { seconds: 600, channelId: 'meds' } as any,
          });
        } catch (_e) {}
        try {
          await Notifications.dismissNotificationAsync(r.notification.request.identifier);
        } catch (_e) {}
        return;
      }

      // Default tap on body — let the app deep-link.
      onAlert?.(data);
    });
    return () => {
      recv.remove();
      resp.remove();
    };
  }, [onAlert]);
  return last;
}
