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
// never reaches the device.  v1.3.3 bumped from 15 s → 30 s so the
// active-poll path has time to actually see the new `last_seen`
// before we give up.  Anything longer than 30 s suggests Doze /
// throttling / no GPS lock and we want to release the spinner so the
// user can re-tap.
const HARD_TIMEOUT_MS = 30_000;

// ============================================================
//  v1.3.3 — Member broadcast bus.
// ============================================================
//
// After `requestRefresh()` actively polls /members/{id} and detects a
// fresh `last_seen`, we publish the new member doc to every screen
// rendering that member so the timestamp updates immediately without
// waiting for the next dashboard refetch.
//
// Subscribers receive the full member object (typed loosely as `any`
// to avoid a circular import on `Member`).
// ============================================================
const memberSubscribers: Set<(member: any) => void> = new Set();

export function subscribeMember(cb: (member: any) => void): () => void {
  memberSubscribers.add(cb);
  return () => { memberSubscribers.delete(cb); };
}

function broadcastMember(member: any): void {
  if (!member || !member.id) return;
  for (const cb of memberSubscribers) {
    try { cb(member); } catch (_e) {}
  }
}

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
 *   • v1.3.3 — actively polls `/api/members/{id}` every 4 s for up to
 *     30 s after firing the request, so a successful upload paints the
 *     new `last_seen` immediately (sub-5 s) instead of waiting for the
 *     next scheduled dashboard refetch (which could be a full minute
 *     away).  The polled member doc is broadcast via `subscribeMember()`
 *     so every screen rendering that member updates atomically.
 *   • The hard-timeout clears the spinner after 30 s no matter what.
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

  // Fire-and-forget the silent-push request.
  api.post(`/members/${memberId}/request-location-refresh`).catch(() => {});

  // v1.3.3 — active sync poll.  Every 4 s for up to 30 s after firing
  // the request, re-fetch `/members/{id}` and check whether `last_seen`
  // has advanced past the baseline.  Once it has, broadcast the fresh
  // member doc to every subscriber and clear the spinner immediately.
  //
  // This fixes the "Charles sees 17 min ago, Joyce sees just now"
  // timestamp lie: previously Charles's dashboard only refetched
  // `/members` on focus mount or on its 60 s cadence, so even though
  // Joyce's upload landed within 10 s, Charles's UI computed
  // `formatTimeAgo()` against a stale member doc still cached in his
  // device.  Now Charles's app actively polls until it SEES the
  // updated `last_seen` and pushes that into local state.
  const startedAt = Date.now();
  const MAX_POLL_MS = 30_000;
  const POLL_INTERVAL_MS = 4_000;
  let pollTimer: any = null;
  let stopped = false;
  const doPoll = async () => {
    if (stopped) return;
    if (!inflight[memberId]) return;             // spinner already cleared
    if ((Date.now() - startedAt) >= MAX_POLL_MS) return;
    try {
      const r = await api.get(`/members/${memberId}`);
      const m = r?.data;
      const seen = m?.last_seen ? new Date(m.last_seen).getTime() : 0;
      const base = baselineLastSeenMs[memberId];
      if (seen && (base === null || base === undefined || seen > (base || 0))) {
        // Broadcast the fresh member doc — dashboard + member detail
        // subscribers will rebind to it and paint the new timestamp /
        // location_name immediately.
        broadcastMember(m);
        // Clear spinner.
        delete inflight[memberId];
        delete baselineLastSeenMs[memberId];
        notify(memberId);
        return;
      }
    } catch (_e) {
      // Network blip — keep polling.
    }
    pollTimer = setTimeout(doPoll, POLL_INTERVAL_MS);
  };
  pollTimer = setTimeout(doPoll, POLL_INTERVAL_MS);

  // Hard timeout safety net — clears the spinner if no GPS arrives
  // within 30 s.  Also stops the active poller so we don't keep
  // hitting the API after the user has moved on.
  setTimeout(() => {
    stopped = true;
    try { clearTimeout(pollTimer); } catch (_e) {}
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
