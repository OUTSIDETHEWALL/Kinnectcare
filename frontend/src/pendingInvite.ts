/**
 * Build #60 — Pending-Invite persistence.
 *
 * Bridges the gap between "user opened the email" and "user is
 * authenticated inside the app".  Without this shim, an invited user
 * whose flow got interrupted (fresh install → app open → signup →
 * post-auth) loses the invite token entirely and becomes an orphaned
 * solo account.  With it, the token survives every possible
 * interruption:
 *
 *   • Deep link received while app was closed  (cold start)
 *   • Deep link received while app was in background  (warm start)
 *   • Deep link tapped BEFORE app was installed → Play Store →
 *     first launch (referrer path — future work)
 *   • Manual code entry on /(auth)/join-family (still writes here
 *     so post-signup auto-join is uniform across every entry path)
 *
 * On every successful sign-in or account-creation, AuthContext reads
 * this store and, if a token is present, POST /family-group/join
 * against it.  Success → clear the token so it never re-fires.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = '@kinnship/pending_invite_v1';

export type PendingInvite = {
  token: string;
  /** UTC ISO timestamp for when the invite was stashed — used to
   *  expire stale tokens (>14d) client-side without a round-trip. */
  savedAt: string;
};

const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export async function setPendingInvite(token: string): Promise<void> {
  const t = (token || '').trim().toUpperCase();
  if (!t) return;
  const payload: PendingInvite = { token: t, savedAt: new Date().toISOString() };
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(payload));
  } catch (_e) {
    /* non-fatal — worst case the user has to tap Accept in the email again */
  }
}

/** Returns the current pending invite, or null if none / expired. */
export async function getPendingInvite(): Promise<PendingInvite | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingInvite;
    if (!parsed?.token) return null;
    const age = Date.now() - new Date(parsed.savedAt).getTime();
    if (Number.isFinite(age) && age > MAX_AGE_MS) {
      await clearPendingInvite();
      return null;
    }
    return parsed;
  } catch (_e) {
    return null;
  }
}

export async function clearPendingInvite(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY);
  } catch (_e) { /* non-fatal */ }
}
