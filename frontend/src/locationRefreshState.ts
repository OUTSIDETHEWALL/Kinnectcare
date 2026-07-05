/**
 * Location refresh state — Build 47 compatibility wrapper.
 *
 * ============================================================
 *  HISTORY
 * ============================================================
 *  Builds 41-46 had this module owning:
 *   1. The per-member "refreshing" spinner flag pub/sub.
 *   2. The fresh-member-doc broadcast bus (`subscribeMember`).
 *   3. An active-poll loop that hit `/members/{id}` until last_seen
 *      advanced.
 *
 *  Build 47 collapses all member-data ownership into the canonical
 *  `memberStore` (see `/app/frontend/src/store/memberStore.ts`).
 *
 *  This module now exists ONLY to preserve two stable surfaces that
 *  the rest of the codebase still calls:
 *
 *   (a) `subscribeRefreshing(id, cb)` + `requestRefresh(id, baseline)`
 *       + `isRefreshing(id)` + `clearIfNewer(id, newSeenMs)` +
 *       `clearAllRefreshes()`
 *           → The "we're actively pulling this member" spinner state.
 *             Lives here because it's UI-state, NOT canonical member
 *             data — the store doesn't care about spinners.
 *
 *   (b) `subscribeMember(cb)` and `STALE_THRESHOLD_MS` / `isStale()`
 *           → Forwarded to memberStore so screens that haven't yet
 *             migrated to `useMember()` keep working unchanged.
 *
 *  Behaviour change vs Build 46:
 *   • The active-poll loop is now `memberStore.requestRefresh(id)`.
 *     This module just orchestrates the spinner + delegates the
 *     fetch/broadcast logic to the store.
 *   • Every member-doc broadcast routes through the store, so a
 *     fresh upload paints into BOTH the dashboard AND the member
 *     screen atomically — they share the exact same object reference.
 * ============================================================
 */
import * as memberStore from './store/memberStore';

// ============================================================
//  Spinner state (UI-only — not canonical data)
// ============================================================

const inflight: Record<string, number> = {};
const baselineLastSeenMs: Record<string, number | null> = {};
const subscribers: Record<string, Set<(refreshing: boolean) => void>> = {};
const HARD_TIMEOUT_MS = 30_000;

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
  try { cb(!!inflight[memberId]); } catch (_e) {}
  return () => {
    subscribers[memberId]?.delete(cb);
  };
}

/** Read the current refreshing flag synchronously (e.g. from render path). */
export function isRefreshing(memberId: string): boolean {
  return !!inflight[memberId];
}

// ============================================================
//  Canonical refresh trigger — delegates to memberStore
// ============================================================
//
//  Caller paints a spinner, we delegate the actual fetch/poll/upsert
//  to the store, and clear the spinner when the store's promise
//  resolves OR after 30 s (whichever comes first).
//
//  The store performs the active poll AND the atomic upsert, so every
//  consumer of `useMember(id)` / `useAllMembers()` repaints with the
//  same record at the same moment.
// ============================================================
export function requestRefresh(memberId: string, currentLastSeenMs?: number | null): void {
  if (inflight[memberId]) return;
  inflight[memberId] = Date.now();
  baselineLastSeenMs[memberId] = currentLastSeenMs ?? null;
  notify(memberId);

  // Delegate the actual fetch + active-poll + atomic upsert to the
  // canonical store.  The store handles dedupe, race protection, and
  // broadcasting to every subscriber.
  memberStore.requestRefresh(memberId).catch(() => {});

  // Hard timeout safety net — clears the spinner if no GPS arrives
  // within 30 s, regardless of what the store is doing.
  setTimeout(() => {
    if (inflight[memberId]) {
      delete inflight[memberId];
      delete baselineLastSeenMs[memberId];
      notify(memberId);
    }
  }, HARD_TIMEOUT_MS);
}

/**
 * Called by screens when a fresh `last_seen` lands.  If it's strictly
 * newer than the baseline we captured at refresh-start, clear the
 * spinner — the refresh worked.
 */
export function clearIfNewer(memberId: string, newLastSeenMs?: number | null): void {
  if (!inflight[memberId]) return;
  const base = baselineLastSeenMs[memberId];
  if (!newLastSeenMs) return;
  if (base === null || base === undefined) {
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

// ============================================================
//  Member broadcast bus — forwarded to the canonical store
// ============================================================
//
//  Legacy `subscribeMember(cb)` callers receive whole-member upserts
//  from the store directly.  This is identical to subscribing through
//  `memberStore.subscribeMember()` — kept here for import-path
//  backwards compat.
// ============================================================
export const subscribeMember = memberStore.subscribeMember;

// ============================================================
//  Staleness predicates (unchanged from Build 46)
// ============================================================

export const STALE_THRESHOLD_MS = 60 * 1000;

export function isStale(lastSeenMs?: number | null): boolean {
  if (!lastSeenMs) return true;
  return (Date.now() - lastSeenMs) >= STALE_THRESHOLD_MS;
}
