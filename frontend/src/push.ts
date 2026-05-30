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
  }),
});

// ---------- Notification Categories (action buttons) ----------
//
// Categories must be registered BEFORE the first push that references one
// arrives. We register on app startup via ensureNotificationCategories().
//
// MEDICATION_DUE → adds two action buttons: "I Took It" and "Snooze 10m"
// ROUTINE_DUE    → adds one action button: "Done"
async function ensureNotificationCategories() {
  try {
    await Notifications.setNotificationCategoryAsync('MEDICATION_DUE', [
      {
        identifier: 'TOOK_IT',
        buttonTitle: '✓  I Took It',
        options: {
          opensAppToForeground: false,  // Mark taken silently — no UI interrupt
        },
      },
      {
        identifier: 'SNOOZE_10',
        buttonTitle: 'Snooze 10m',
        options: {
          opensAppToForeground: false,
        },
      },
    ]);
    await Notifications.setNotificationCategoryAsync('ROUTINE_DUE', [
      {
        identifier: 'DONE',
        buttonTitle: '✓  Done',
        options: {
          opensAppToForeground: false,
        },
      },
    ]);
  } catch (e) {
    // Best-effort — older platforms may not support categories.
    // The notification still displays as a normal heads-up without buttons.
    // eslint-disable-next-line no-console
    console.warn('Failed to register notification categories:', e);
  }
}

// ---------- Android Notification Channels ----------
//
// Each push includes a `channelId` in its data payload; we route it via the
// top-level channelId field on the push send call (handled server-side).
//
// Critical channels (sos, meds) use IMPORTANCE_MAX with vibration so the
// notification persists in the heads-up area + tray until the user dismisses
// it. They also enable lights and bypass DND for SOS.
export async function ensureNotificationChannel() {
  if (Platform.OS !== 'android') return;
  try {
    // Default — used by anything without an explicit channel.
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Kinnship alerts',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
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
      vibrationPattern: [0, 300, 200, 300],
      lightColor: '#1B5E35',
      sound: 'default',
      enableVibrate: true,
      enableLights: true,
      showBadge: true,
    });
    // Routines — gentler nudge, still heads-up.
    await Notifications.setNotificationChannelAsync('routines', {
      name: 'Daily routines',
      description: 'Walks, hydration, meals, and other routine nudges',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 200, 100, 200],
      lightColor: '#1B5E35',
      sound: 'default',
      enableVibrate: true,
      showBadge: true,
    });
    // SOS — critical, bypass DND when allowed.
    await Notifications.setNotificationChannelAsync('sos', {
      name: 'SOS emergencies',
      description: 'Critical safety alerts — never silenced',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 500, 200, 500, 200, 500],
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
    const recv = Notifications.addNotificationReceivedListener(n => setLast(n));
    const resp = Notifications.addNotificationResponseReceivedListener(async (r) => {
      const data: any = r.notification.request.content.data || {};
      const actionId = r.actionIdentifier;

      // Action button taps — silent mark-taken / snooze. These come from
      // notification category buttons we registered above.
      if (actionId === 'TOOK_IT' || actionId === 'DONE') {
        const rid = data.reminder_id;
        if (rid) {
          try {
            await api.post(`/reminders/${rid}/mark`, { status: 'taken' });
            // Dismiss the notification from the tray so the user sees confirmation.
            try {
              await Notifications.dismissNotificationAsync(r.notification.request.identifier);
            } catch (_e) {}
          } catch (_e) {}
        }
        return;
      }
      if (actionId === 'SNOOZE_10') {
        // Schedule a local re-fire in 10 min using the same category so the
        // action buttons reappear.
        const rid = data.reminder_id;
        try {
          await Notifications.scheduleNotificationAsync({
            content: {
              title: r.notification.request.content.title || '💊 Medication reminder',
              body: r.notification.request.content.body || 'Tap "I Took It" to confirm.',
              data,
              categoryIdentifier: 'MEDICATION_DUE',
              sound: 'default',
            },
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
