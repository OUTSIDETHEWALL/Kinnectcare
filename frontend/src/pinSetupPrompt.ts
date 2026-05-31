/**
 * pinSetupPrompt.ts — tracks whether a user has acknowledged the
 * one-time "Set up a 4-digit PIN?" prompt on this device.
 *
 * Storage: a JSON object in AsyncStorage keyed by user id, recording
 * the timestamp at which the user explicitly tapped "Not now" so we
 * don't keep nagging them. Choosing AsyncStorage (not SecureStore)
 * because this is a non-sensitive UX flag — losing it would just
 * re-prompt the user once, which is harmless.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = '@kinnship/pin_setup_dismissed_v1';

type Dismissed = Record<string, number>; // userId -> dismissed_at_ms

async function readMap(): Promise<Dismissed> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_e) {
    return {};
  }
}

async function writeMap(m: Dismissed): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(m));
  } catch (_e) {}
}

export async function wasPinSetupDismissed(userId: string): Promise<boolean> {
  if (!userId) return true;
  const m = await readMap();
  return typeof m[userId] === 'number' && m[userId] > 0;
}

export async function markPinSetupDismissed(userId: string): Promise<void> {
  if (!userId) return;
  const m = await readMap();
  m[userId] = Date.now();
  await writeMap(m);
}

export async function clearPinSetupDismissed(userId: string): Promise<void> {
  if (!userId) return;
  const m = await readMap();
  if (m[userId]) {
    delete m[userId];
    await writeMap(m);
  }
}
