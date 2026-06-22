/**
 * Location refresh state coordinator (v1.3.2 — Tier 1 UX refinements).
 *
 * Why this module exists:
 *   The dashboard and member-detail screens both fire `POST /api/members/
 *   {id}/request-location-refresh` when a member's `last_seen` is stale.
 *   That endpoint sends a silent push to wake the device and trigger an
 *   upload — but the dashboard/detail screen needs to TELL the user "we're
 *   refreshing this person right now" so a 5-15 second delay doesn't look
 *   like the app is frozen / broken.
 *
 *   We track an in-flight refresh flag per member, expose a subscribe()
 *   API so any screen rendering that member can show a "Refreshing
 *   location..." indicator, and auto-clear the flag after either a new
 *   `last_seen` lands or a hard timeout (so the spinner can't get stuck
 *   if the silent push fails to reach the device).
 *
 *   Single module-level state, no React context, so this works equally
 *   well from useEffect closures in tab screens and from event handlers
 *   that don't have access to a Provider.
 */
import { api } from './api';

// In-flight refresh markers — { memberId → epoch-ms when refresh started }.
// Presence in this map means "spinner should be visible for this member".
const inflight: Record<string, number> = {};

// Last-seen timestamp snapshot taken at the moment we fired the refresh,
// so we can detect when a NEW value arrives (signal that refresh succeeded
// and we can clear the spinner immediately, even before the hard timeout).
const baselineLastSeenMs: Record<string, number | null> = {};

// Per-member subscribers — receive the latest boolean isRefreshing flag.
const subscribers: Record<string, Set<(refreshing: boolean) => void>> = {};

// Hard timeout so the spinner can never get stuck if the silent push
// never reaches the device.  15 s is enough for a Doze-asleep Android
// to wake, fix GPS, and upload.
const HARD_TIMEOUT_MS = 15_000;

function notify(memberId: string): void {
  const subs = subscribers[memberId];
  if (!subs) return;
  const refreshing = !!inflight[memberId];
  for (const cb of subs) {
    try { cb(refreshing); } catch (_e) {}
  }
}

/** Subscribe to refresh-state changes for a specific member. */
export function subscribeRefreshing(
  memberId: string,
  cb: (refreshing: boolean) => void,
): () => void {
  if (!subscribers[memberId]) subscribers[memberId] = new Set();
  subscribers[memberId].add(cb);
  // Fire current state immediately so the subscriber renders correctly.
  try { cb(!!inflight[memberId]); } catch (_e) {}
  return () => {
    subscribers[memberId]?.delete(cb);
  };
}

/** Read the current refreshing flag synchronously (e.g. from render path). */
export function isRefreshing(memberId: string): boolean {
  return !!inflight[memberId];
}

/**
 * Trigger a fresh-location pull-on-stale for the given member.
 *
 *   • Fires POST /api/members/{id}/request-location-refresh — server
 *     decides whether to send a silent push (gated by 30 s throttle).
 *   • Marks the member as refreshing locally so subscribers can paint a
 *     spinner immediately, even if the server throttles the actual push.
 *   • The hard-timeout clears the flag after 15 s no matter what.
 *
 *   `currentLastSeenMs` is optional — if provided we'll also clear the
 *   flag early as soon as `clearIfNewer()` is called with a strictly
 *   greater timestamp (e.g. when the next /members poll returns).
 */
export function requestRefresh(memberId: string, currentLastSeenMs?: number | null): void {
  // If already in flight, treat repeat taps as a no-op so the user can
  // hammer the button without resetting their own timer.
  if (inflight[memberId]) return;
  inflight[memberId] = Date.now();
  baselineLastSeenMs[memberId] = currentLastSeenMs ?? null;
  notify(memberId);

  // Fire-and-forget.  Backend handles auth + throttling.
  api.post(`/members/${memberId}/request-location-refresh`).catch(() => {});

  // Hard timeout safety net.
  setTimeout(() => {
    if (inflight[memberId] && inflight[memberId] === (inflight[memberId] || 0)) {
      delete inflight[memberId];
      delete baselineLastSeenMs[memberId];
      notify(memberId);
    }
  }, HARD_TIMEOUT_MS);
}

/**
 * Called by dashboard / member-detail every time fresh `/members` data
 * lands.  If the new last_seen is strictly newer than the baseline we
 * captured at refresh-start time, clear the spinner — the refresh
 * worked.
 */
export function clearIfNewer(memberId: string, newLastSeenMs?: number | null): void {
  if (!inflight[memberId]) return;
  const base = baselineLastSeenMs[memberId];
  if (!newLastSeenMs) return;
  if (base === null || base === undefined) {
    // No baseline — any new value clears.
    delete inflight[memberId];
    delete baselineLastSeenMs[memberId];
    notify(memberId);
    return;
  }
  if (newLastSeenMs > base) {
    delete inflight[memberId];
    delete baselineLastSeenMs[memberId];
    notify(memberId);
  }
}

/** Convenience: clear ALL in-flight refreshes (e.g. on logout). */
export function clearAllRefreshes(): void {
  const ids = Object.keys(inflight);
  for (const id of ids) {
    delete inflight[id];
    delete baselineLastSeenMs[id];
    notify(id);
  }
}

/**
 * Centralised "is this member stale enough to auto-pull?" predicate.
 *
 * v1.3.2 tightened the threshold from 2 min → 60 s based on user
 * feedback that even short delays felt broken when checking on a
 * loved one during an active phone call ("she's right there, why is
 * her dot 90 s old?").  The 60 s threshold combined with the silent-
 * push wake architecture gives a sub-30 s refresh in the steady-state.
 */
export const STALE_THRESHOLD_MS = 60 * 1000;

export function isStale(lastSeenMs?: number | null): boolean {
  if (!lastSeenMs) return true;
  return (Date.now() - lastSeenMs) >= STALE_THRESHOLD_MS;
}
