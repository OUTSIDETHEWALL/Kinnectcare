/**
 * Kinnship — Canonical Member Store (Build 47).
 * ============================================================
 *
 *  WHY THIS MODULE EXISTS
 *  ----------------------
 *  Builds 41-46 accumulated three independent location pipelines that
 *  could observably drift apart:
 *
 *    1. Dashboard               — held its own `members[]` React state
 *                                  populated by a 60 s `GET /members` poll.
 *    2. Member detail screen    — held its own `member` React state
 *                                  populated by an independent `GET
 *                                  /members/{id}` on mount.
 *    3. `locationRefreshState`  — broadcast a "fresh member doc" via
 *                                  `subscribeMember(cb)`, but each screen
 *                                  STILL kept its own local copy that the
 *                                  broadcast had to laboriously overwrite,
 *                                  and that local copy could be later
 *                                  blown away by a stale `GET /members/{id}`
 *                                  response landing AFTER the broadcast.
 *
 *  Net effect: caregiver could see "Just now" on the dashboard, navigate
 *  to the member detail screen, and see "37 minutes ago" — different
 *  React states reading different snapshots of the same backend record.
 *
 *  Build 47 collapses all three pipelines into ONE authoritative store
 *  that:
 *
 *    • owns the canonical `Record<memberId, Member>` map,
 *    • atomically replaces whole member objects (never partial updates),
 *    • dedupes in-flight network requests,
 *    • exposes React hooks via `useSyncExternalStore` so every screen
 *      receives the EXACT same record at the EXACT same time,
 *    • preserves backwards-compat with the existing `subscribeMember`
 *      broadcast bus so `locationRefreshState.ts` can remain a thin
 *      compatibility wrapper during the refactor.
 *
 *  DESIGN PRINCIPLES (do not violate)
 *  ----------------------------------
 *  1. **Atomic replacement.**  `upsertOne(m)` REPLACES the whole record
 *     at `state.members[m.id]`.  Never mutate fields in place.  The
 *     {coordinates, last_seen, location_name, accuracy} tuple must
 *     always originate from the SAME backend response.
 *
 *  2. **Single fetch path.**  No component calls `api.get('/members')`
 *     or `api.get('/members/{id}')` directly any more.  Everything goes
 *     through `fetchAll()` / `fetchOne(id)` so we get dedupe + race
 *     protection in one place.
 *
 *  3. **Race protection.**  Each fetch carries a monotonically
 *     increasing sequence number.  An older response NEVER overwrites
 *     a newer one in the store (matters when foreground-refresh races
 *     a manual refresh-button tap).
 *
 *  4. **No React context.**  Module-level state + `useSyncExternalStore`
 *     mirrors the pattern already established by
 *     `locationRefreshState.ts`, so the rest of
 *     the codebase reads naturally to any developer who knows those
 *     modules.
 *
 *  5. **No new dependencies.**  Per Build 47 spec, we use the existing
 *     React 18 primitive `useSyncExternalStore`.
 */

import { useSyncExternalStore } from 'react';
import { api, Member } from '../api';

// ============================================================
//  Module-level state
// ============================================================
//
//  `state` is the single mutable source of truth.  Hooks read from it
//  via `useSyncExternalStore`, which guarantees concurrent-safe reads
//  and tearing-free renders.
//
//  IMPORTANT: never mutate `state.members[id]` directly.  Always
//  produce a NEW member object and assign it.  The hooks compare
//  references, so partial mutation would produce stale renders.
// ============================================================
type MemberRecord = Member;

type StoreState = {
  /** Canonical member map keyed by Member.id. */
  members: Record<string, MemberRecord>;
  /** Monotonically increasing version counter — bumped on every write. */
  version: number;
  /** Last-successful fetchAll timestamp (epoch ms). */
  lastFetchAllAt: number | null;
};

let state: StoreState = {
  members: {},
  version: 0,
  lastFetchAllAt: null,
};

// Per-record fetch sequence numbers so an OLDER in-flight response
// can never overwrite a NEWER one.  This matters when foreground-refresh
// races a manual refresh-button tap on the same member.
const fetchSeq: Record<string, number> = {};
let nextSeq = 1;

// In-flight request maps so concurrent callers share the same Promise.
const inFlightOne: Map<string, Promise<MemberRecord | null>> = new Map();
let inFlightAll: Promise<MemberRecord[]> | null = null;

// ============================================================
//  Subscriber bookkeeping
// ============================================================
//
//  Three kinds of listener:
//    • Global       — fired on ANY state change (used by useAllMembers).
//    • Per-id       — fired only when that specific member changes
//                     (used by useMember(id) to avoid extra renders).
//    • Legacy bus   — fired on every upsert with the new record, for
//                     backwards compat with `locationRefreshState.ts`
//                     `subscribeMember()` callers.
// ============================================================
const globalSubs: Set<() => void> = new Set();
const idSubs: Record<string, Set<() => void>> = {};
const legacyMemberSubs: Set<(m: MemberRecord) => void> = new Set();

function notifyGlobal(): void {
  for (const cb of globalSubs) {
    try { cb(); } catch (_e) { /* never block notify chain */ }
  }
}

function notifyId(id: string): void {
  const subs = idSubs[id];
  if (!subs) return;
  for (const cb of subs) {
    try { cb(); } catch (_e) {}
  }
}

function notifyLegacy(m: MemberRecord): void {
  for (const cb of legacyMemberSubs) {
    try { cb(m); } catch (_e) {}
  }
}

// ============================================================
//  Snapshot caching (required for useSyncExternalStore stability)
// ============================================================
//
//  `useSyncExternalStore` requires getSnapshot() to return a STABLE
//  reference when the data hasn't changed — otherwise React will
//  re-render on every check and we'd burn frames.
//
//  We cache the most recent snapshot per query (the global "all
//  members" array and each individual member record) and only
//  invalidate when `version` advances.
// ============================================================
let allCache: { version: number; value: MemberRecord[] } | null = null;

function getAllSnapshot(): MemberRecord[] {
  if (allCache && allCache.version === state.version) return allCache.value;
  // Stable sort by id keeps consumers deterministic.
  const value = Object.values(state.members).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  allCache = { version: state.version, value };
  return value;
}

function getOneSnapshot(id: string): MemberRecord | undefined {
  return state.members[id];
}

// ============================================================
//  Internal writers (atomic)
// ============================================================
//
//  `setMembersMap()` is the ONLY place that reassigns the canonical
//  map.  Every public action funnels through here so we can never
//  forget to bump `version` or fire subscribers.
// ============================================================
function commit(nextMap: Record<string, MemberRecord>, touchedIds: string[]): void {
  state = {
    ...state,
    members: nextMap,
    version: state.version + 1,
  };
  // Invalidate cache lazily via version check (no work needed here).
  notifyGlobal();
  for (const id of touchedIds) notifyId(id);
}

/**
 * Replace ONE record atomically.  `incoming` must be the FULL member
 * object as returned by the backend — never a partial patch.
 *
 * Race protection: pass `seq` from a prior `nextFetchSeq(id)` call to
 * make sure an older fetch can't overwrite a newer one.  Pass `null`
 * to bypass the check (e.g. for direct upserts from realtime push).
 */
export function upsertOne(incoming: MemberRecord, seq: number | null = null): void {
  if (!incoming || !incoming.id) return;
  const id = incoming.id;
  if (seq !== null) {
    const cur = fetchSeq[id] ?? 0;
    if (seq < cur) {
      // Stale response — drop it.
      return;
    }
    fetchSeq[id] = seq;
  }
  const next = { ...state.members, [id]: incoming };
  commit(next, [id]);
  notifyLegacy(incoming);
}

/**
 * Replace MANY records atomically in a single transaction so all
 * subscribers see the new map at the same moment (no intermediate
 * partial-replace flicker).
 */
export function upsertMany(incoming: MemberRecord[]): void {
  if (!incoming || incoming.length === 0) return;
  const next: Record<string, MemberRecord> = { ...state.members };
  const touched: string[] = [];
  for (const m of incoming) {
    if (!m || !m.id) continue;
    // Bump the per-id seq so any in-flight fetchOne with an older seq
    // can't clobber this fresh data.
    fetchSeq[m.id] = nextSeq++;
    next[m.id] = m;
    touched.push(m.id);
  }
  commit(next, touched);
  for (const m of incoming) notifyLegacy(m);
}

/** Remove all records — used on sign-out. */
export function clearAll(): void {
  state = { members: {}, version: state.version + 1, lastFetchAllAt: null };
  for (const k of Object.keys(fetchSeq)) delete fetchSeq[k];
  inFlightOne.clear();
  inFlightAll = null;
  notifyGlobal();
  // Notify every previously-known id so per-id subscribers can react.
  for (const id of Object.keys(idSubs)) notifyId(id);
}

/**
 * Build #59 — drop a single member from the store synchronously so
 * the dashboard reflects a deletion on the very next paint, without
 * having to wait for the ~60s /members poll to notice the row is
 * gone.  Called from member/[id].tsx.onDelete right after the
 * DELETE /members/{id} response returns 2xx.  Idempotent — no-op if
 * the id doesn't exist.
 */
export function remove(id: string): void {
  if (!id || !state.members[id]) return;
  const next: Record<string, MemberRecord> = { ...state.members };
  delete next[id];
  delete fetchSeq[id];
  state = { members: next, version: state.version + 1, lastFetchAllAt: state.lastFetchAllAt };
  notifyGlobal();
  notifyId(id);
}

// ============================================================
//  Public actions — fetch coordination
// ============================================================

/** Allocate a fresh fetch sequence for `id`.  Use before an async fetch. */
function nextFetchSeq(id: string): number {
  const s = nextSeq++;
  // Mark the in-flight seq as our floor so it survives the race window.
  // We don't write fetchSeq[id] yet — only the eventual upsertOne will,
  // because if THIS fetch fails we shouldn't have raised the floor.
  return s;
}

/**
 * Fetch the entire family group.  Dedupes concurrent callers — the
 * second `fetchAll()` while one is in flight returns the same Promise.
 *
 * Resolves with the array of members.  Subscribers fire BEFORE this
 * resolves so the UI re-renders synchronously with the data.
 */
export function fetchAll(): Promise<MemberRecord[]> {
  if (inFlightAll) return inFlightAll;
  inFlightAll = (async () => {
    try {
      const r = await api.get('/members');
      const arr: MemberRecord[] = Array.isArray(r?.data) ? r.data : [];
      // Atomic replace of the WHOLE set.  Anything that disappeared
      // from the backend (a removed member) drops out here.
      const next: Record<string, MemberRecord> = {};
      const touched: string[] = [];
      for (const m of arr) {
        if (!m || !m.id) continue;
        fetchSeq[m.id] = nextSeq++;
        next[m.id] = m;
        touched.push(m.id);
      }
      // Also include any local ids that weren't in this response so
      // we can notify their per-id subscribers that they were dropped.
      for (const id of Object.keys(state.members)) {
        if (!next[id]) touched.push(id);
      }
      state = { members: next, version: state.version + 1, lastFetchAllAt: Date.now() };
      notifyGlobal();
      for (const id of touched) notifyId(id);
      for (const m of arr) notifyLegacy(m);
      return arr;
    } catch (_e) {
      // Network failure — keep existing state.  The next foreground
      // tick or manual refresh will retry.  Return current cached set
      // so callers awaiting fetchAll() can keep rendering something.
      return Object.values(state.members);
    } finally {
      inFlightAll = null;
    }
  })();
  return inFlightAll;
}

/**
 * Fetch a single member.  Dedupes concurrent callers for the same id.
 */
export function fetchOne(id: string): Promise<MemberRecord | null> {
  if (!id) return Promise.resolve(null);
  const existing = inFlightOne.get(id);
  if (existing) return existing;
  const seq = nextFetchSeq(id);
  const p = (async () => {
    try {
      const r = await api.get(`/members/${id}`);
      const m: MemberRecord | null = r?.data ?? null;
      if (m && m.id) {
        upsertOne(m, seq);
        return m;
      }
      return null;
    } catch (_e) {
      return null;
    } finally {
      inFlightOne.delete(id);
    }
  })();
  inFlightOne.set(id, p);
  return p;
}

/**
 * Fire a refresh request to the backend for `id`, then actively poll
 * `/members/{id}` until `last_seen` advances past the baseline (or
 * 30 s timeout).  When fresh data lands, atomically upsert it so
 * every subscriber re-renders simultaneously.
 *
 * Returns when the polling loop exits.  The caller can show its own
 * spinner via `locationRefreshState.subscribeRefreshing(id)`.
 */
export async function requestRefresh(id: string): Promise<void> {
  if (!id) return;
  const baseline = state.members[id]?.last_seen
    ? new Date(state.members[id].last_seen).getTime()
    : 0;
  // Fire the silent-push request (server may throttle — that's fine).
  try { await api.post(`/members/${id}/request-location-refresh`); } catch (_e) {}

  const startedAt = Date.now();
  const MAX_POLL_MS = 30_000;
  const POLL_INTERVAL_MS = 4_000;
  // First poll happens after one interval — the silent push needs a
  // moment to wake the senior device + transmit + persist.
  await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
  while ((Date.now() - startedAt) < MAX_POLL_MS) {
    try {
      const r = await api.get(`/members/${id}`);
      const m: MemberRecord | null = r?.data ?? null;
      if (m && m.id) {
        const seen = m.last_seen ? new Date(m.last_seen).getTime() : 0;
        if (seen > baseline) {
          // Fresh upload landed — commit atomically and exit.  Use a
          // fresh seq so we win against any racing fetchOne(id).
          upsertOne(m, nextSeq++);
          return;
        }
        // Backend record exists but hasn't advanced — store the latest
        // anyway so coordinates stay current even if timestamp is the
        // same (defensive; usually they match).
        upsertOne(m, nextSeq++);
      }
    } catch (_e) { /* keep polling */ }
    await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
  }
}

// ============================================================
//  Synchronous getters (use inside non-React code)
// ============================================================

/** Read the current member by id, or undefined if not loaded. */
export function getMemberById(id: string | null | undefined): MemberRecord | undefined {
  if (!id) return undefined;
  return state.members[id];
}

/** Read all currently-known members (sorted by id). */
export function getAllMembers(): MemberRecord[] {
  return getAllSnapshot();
}

/**
 * Read the "self" member for a given Auth user.id.  This is the
 * member row whose `user_id` matches the caregiver/senior's auth id —
 * i.e. "MY pin on the map" / "the device whose location this app is
 * uploading".  Returns undefined if no such row exists.
 */
export function getMyMember(authUserId: string | null | undefined): MemberRecord | undefined {
  if (!authUserId) return undefined;
  for (const m of Object.values(state.members)) {
    if (m.user_id === authUserId) return m;
  }
  return undefined;
}

/** Read `last_seen` for the auth user's own member row, as epoch ms. */
export function getMyLastSeenMs(authUserId: string | null | undefined): number | null {
  const m = getMyMember(authUserId);
  if (!m || !m.last_seen) return null;
  const t = new Date(m.last_seen).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Read store metadata. */
export function getStoreMeta(): { count: number; lastFetchAllAt: number | null; version: number } {
  return {
    count: Object.keys(state.members).length,
    lastFetchAllAt: state.lastFetchAllAt,
    version: state.version,
  };
}

// ============================================================
//  React hooks (the public-facing API for screens)
// ============================================================

/**
 * Subscribe to a single member.  Re-renders ONLY when this specific
 * record changes (or is removed).  Returns undefined if not yet
 * loaded — callers should render a skeleton in that state.
 */
export function useMember(id: string | null | undefined): MemberRecord | undefined {
  return useSyncExternalStore(
    (cb) => {
      if (!id) return () => {};
      if (!idSubs[id]) idSubs[id] = new Set();
      idSubs[id].add(cb);
      return () => { idSubs[id]?.delete(cb); };
    },
    () => (id ? getOneSnapshot(id) : undefined),
    () => (id ? getOneSnapshot(id) : undefined), // SSR snapshot (same on RN)
  );
}

/**
 * Subscribe to the full members list.  Re-renders when ANY member
 * changes.  The returned array reference is STABLE across renders
 * when the data hasn't changed.
 */
export function useAllMembers(): MemberRecord[] {
  return useSyncExternalStore(
    (cb) => {
      globalSubs.add(cb);
      return () => { globalSubs.delete(cb); };
    },
    getAllSnapshot,
    getAllSnapshot,
  );
}

/**
 * Subscribe to "my" member (the one whose user_id matches the auth
 * user).  Convenience wrapper for the senior device which only ever
 * needs to read its own row.
 */
export function useMyMember(authUserId: string | null | undefined): MemberRecord | undefined {
  return useSyncExternalStore(
    (cb) => {
      // Re-runs the selector on every change — efficient enough for
      // the small family sizes we expect.
      globalSubs.add(cb);
      return () => { globalSubs.delete(cb); };
    },
    () => getMyMember(authUserId),
    () => getMyMember(authUserId),
  );
}

// ============================================================
//  Backwards-compat — legacy subscribeMember bus
// ============================================================
//
//  `locationRefreshState.ts` historically exposed `subscribeMember()`
//  for screens that wanted to react to a fresh member doc broadcast.
//  We keep that bus alive here so the migration can happen
//  incrementally — components can either:
//
//    (a) migrate to `useMember(id)` / `useAllMembers()` (preferred), OR
//    (b) keep calling `subscribeMember(cb)` and we'll forward upserts.
//
//  Once every consumer is on the hooks, the legacy bus can be deleted.
// ============================================================
export function subscribeMember(cb: (m: MemberRecord) => void): () => void {
  legacyMemberSubs.add(cb);
  return () => { legacyMemberSubs.delete(cb); };
}
