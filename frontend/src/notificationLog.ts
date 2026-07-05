/**
 * Notification ring buffer (v1.3.3).
 *
 * Why this module exists:
 *   We're chasing an intermittent "silent" push sound leak — sometimes
 *   when Charles opens Kinnship, sometimes when he opens Joyce's
 *   profile, sometimes on Refresh, sometimes never.  The Android OS
 *   plays the sound but we have NO visibility into which payload /
 *   channel / priority triggered it.  Logging every received
 *   notification with full envelope detail lets us pin the offender.
 *
 *   We keep the last 20 entries in AsyncStorage so the user can
 *   reproduce the sound, open Diagnostics, and SEE which channel /
 *   sound / vibration the payload claimed.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = '@kinnship/notification_log_v1';
const MAX = 20;

export type NotificationLogEntry = {
  at: number;                      // epoch ms when the foreground handler observed the notification
  source: 'foreground-handler' | 'received-listener' | 'response-listener' | 'data-push';
  channelId?: string | null;       // Android channel id (Expo data.channelId or request.content.android.channelId)
  sound?: string | null | boolean; // Notifications content.sound — explicit "default" / "" / null
  priority?: string | null;        // expo-notifications priority enum
  title?: string | null;
  body?: string | null;
  vibrate?: boolean | null;
  type?: string | null;            // data.type — our app-level routing key
  requestId?: string | null;       // backend _requestId for correlation with refresh-trace
  raw?: any;                       // condensed JSON for "tap to inspect"
};

/** Append a notification observation.  Best-effort, async, never throws. */
export async function logNotification(entry: NotificationLogEntry): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const arr: NotificationLogEntry[] = raw ? JSON.parse(raw) : [];
    arr.unshift(entry);
    if (arr.length > MAX) arr.length = MAX;
    await AsyncStorage.setItem(KEY, JSON.stringify(arr));
  } catch (_e) { /* swallow */ }
}

/** Read the current notification log. */
export async function getNotificationLog(): Promise<NotificationLogEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/** Clear the log (Diagnostics "Clear logs" button). */
export async function clearNotificationLog(): Promise<void> {
  try { await AsyncStorage.removeItem(KEY); } catch (_e) {}
}
