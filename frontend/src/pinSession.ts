/**
 * pinSession.ts — Build #55.
 *
 * Persistent 24-hour rolling TTL for the PIN unlock, layered on top
 * of pinAuth's in-memory `markUnlocked` flag.  Without this file,
 * every JS process kill (Android low-memory reclaim, OS restart)
 * forces a PIN re-prompt on next launch — which caregivers rightly
 * called out as constant friction.
 *
 * Model (per Charles's spec):
 *   • Each successful PIN entry OR biometric unlock writes the
 *     current epoch-ms to AsyncStorage under a per-user key.
 *   • On app launch, if the stored timestamp is within TTL_MS of
 *     `now`, the session is still valid and no PIN prompt is
 *     required.  Otherwise the timestamp is cleared and the user
 *     must re-authenticate.
 *   • Foregrounding alone does NOT refresh the timestamp — only an
 *     actual unlock does.  This keeps the security model honest
 *     (someone can't keep a session alive forever by tapping the
 *     app icon once a day without ever unlocking).
 *   • Sign-out and "Remove PIN" clear the stamp immediately.
 *
 * Storage lives in AsyncStorage (not SecureStore).  Rationale: this
 * is a session marker, not a secret.  The PIN itself remains in the
 * hardware-backed secure store.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

// 24-hour rolling window per product spec.
export const PIN_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function keyFor(userId: string): string {
  const safe = String(userId || '').replace(/[^A-Za-z0-9_.-]/g, '');
  return `@kinnship/pin_session_v1_${safe}`;
}

/** Record a fresh unlock (called from verifyPin success + biometric unlock). */
export async function refreshUnlockTimestamp(userId: string): Promise<void> {
  if (!userId) return;
  try {
    await AsyncStorage.setItem(keyFor(userId), String(Date.now()));
  } catch (_e) {
    // Non-fatal — falls back to in-memory `markUnlocked` for this run.
  }
}

/** True iff a stored unlock timestamp exists and is within the TTL. */
export async function isSessionValid(userId: string): Promise<boolean> {
  if (!userId) return false;
  try {
    const raw = await AsyncStorage.getItem(keyFor(userId));
    if (!raw) return false;
    const ts = Number(raw);
    if (!Number.isFinite(ts) || ts <= 0) return false;
    const age = Date.now() - ts;
    if (age < 0 || age > PIN_SESSION_TTL_MS) {
      // Expired (or clock-warp) — clear so we don't keep re-checking
      // a stale value on every launch.
      await AsyncStorage.removeItem(keyFor(userId));
      return false;
    }
    return true;
  } catch (_e) {
    return false;
  }
}

/** Wipe the stored session — called on sign-out and clearPin. */
export async function clearSession(userId: string): Promise<void> {
  if (!userId) return;
  try {
    await AsyncStorage.removeItem(keyFor(userId));
  } catch (_e) {}
}

/** Peek — used by the Me tab to show "Last unlocked X hours ago". */
export async function getSessionTimestamp(userId: string): Promise<number | null> {
  if (!userId) return null;
  try {
    const raw = await AsyncStorage.getItem(keyFor(userId));
    if (!raw) return null;
    const ts = Number(raw);
    return Number.isFinite(ts) && ts > 0 ? ts : null;
  } catch (_e) {
    return null;
  }
}
