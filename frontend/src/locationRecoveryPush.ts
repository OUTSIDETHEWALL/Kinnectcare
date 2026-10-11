import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

const LAST_REFRESH_KEY = 'kc_location_recovery_push_attempt_v1';
const MIN_INTERVAL_MS = 30_000;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Expo SDK 54 delivers data-only tasks with dataString; listeners use content.data. */
function refreshData(payload: unknown): Record<string, unknown> | null {
  const root = record(payload);
  if (!root) return null;
  const response = record(root.response) ?? root;
  const notification = record(response.notification) ?? root;
  const request = record(notification.request);
  const content = record(request?.content) ?? record(notification.content);
  const data = record(content?.data) ?? record(root.data) ?? root;
  if (typeof data.dataString === 'string') {
    try {
      const parsed = record(JSON.parse(data.dataString));
      return parsed?.type === 'request_location_refresh' ? parsed : null;
    } catch { return null; }
  }
  return data.type === 'request_location_refresh' ? data : null;
}

/**
 * Both cold tasks and live listeners share authorization and a durable GPS gate.
 * Payload member IDs/tokens never grant authority. No notification is generated.
 * Repeated deliveries still reach privacy enforcement before deduplicating GPS.
 */
export async function handleSilentLocationRecoveryPush(payload: unknown): Promise<boolean> {
  const data = refreshData(payload);
  if (!data || Platform.OS !== 'android') return false;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const engine = require('./locationEngine') as typeof import('./locationEngine');
  const requestId = typeof data._requestId === 'string' ? data._requestId : null;
  const result = await engine.recoverAndRefreshFromIndependentWake('silent-refresh-push', async () => {
    // Called while holding the native lifecycle FIFO: two listeners cannot
    // race the read/claim. Claim before acquisition, so lost callbacks do not loop.
    const raw = await AsyncStorage.getItem(LAST_REFRESH_KEY);
    let previous: { requestId?: string | null; at?: number } | null = null;
    try { previous = raw ? JSON.parse(raw) : null; } catch { /* replace invalid gate */ }
    const now = Date.now();
    if (previous && typeof previous.at === 'number' && now >= previous.at
      && (now - previous.at < MIN_INTERVAL_MS
        || (requestId !== null && previous.requestId === requestId && now - previous.at < 5 * 60_000))) {
      return false;
    }
    await AsyncStorage.setItem(LAST_REFRESH_KEY, JSON.stringify({ requestId, at: now }));
    return true;
  });
  await engine.logEvent('silent_refresh_recovery', { result });
  return true;
}
