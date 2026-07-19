/**
 * Refresh Pipeline Log — Build XX (Stale UI Investigation)
 * =========================================================
 *
 * A shared ring buffer that instruments every point where member
 * location data flows from the network → store → UI.  Captures:
 *
 *   1. Dashboard load() invocations with their trigger reason
 *      (focus / 60-s interval / AppState active / notification)
 *
 *   2. Every store write (upsertOne / upsertMany / fetchAll) with
 *      prev vs new last_seen and location_name so we can answer:
 *      "Did fresh data actually enter the store after a successful
 *       SDK upload?"
 *
 *   3. Race-condition flags: when incoming last_seen is OLDER than
 *      what is already in the store, the entry is marked as a
 *      regression so the diagnostics screen can highlight it.
 *
 * Design principle: logging must NEVER block or throw.  Every call
 * site wraps in try-catch and the flush is fire-and-forget.
 *
 * Buffer: 60 entries, 2-hour age window (inherits diagBufferConfig).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { nextSeq } from './diagSeq';
import { pruneBuffer, DIAG_BUFFER_AGE_MS } from './diagBufferConfig';

const KEY = '@kinnship/refresh_pipeline_log_v1';
const MAX_ENTRIES = 60;

// ---------------------------------------------------------------------------
//  Types
// ---------------------------------------------------------------------------

export type PipelineStage =
  | 'dashboard-load'     // dashboard load() was invoked
  | 'store-upsert-one'   // upsertOne() atomically wrote one member
  | 'store-upsert-many'  // upsertMany() wrote a batch from dashboard
  | 'store-fetch-all';   // fetchAll() wrote a batch via the store's own network call

export type PipelineEntry = {
  /** Global monotonic seq — strict cross-stream ordering for this session. */
  seq: number;
  /** Epoch ms. */
  t: number;
  stage: PipelineStage;

  // ── Dashboard load ─────────────────────────────────────────────────────
  /**
   * What triggered this dashboard load.
   * 'focus' | 'interval-60s' | 'appstate-active' | 'notif-received' |
   * 'pull-to-refresh' | 'quick-checkin' | 'unknown'
   */
  trigger?: string;

  // ── Single-member write (store-upsert-one) ─────────────────────────────
  memberId?: string | null;
  memberName?: string | null;
  prevLastSeen?: string | null;
  newLastSeen?: string | null;
  prevLocationName?: string | null;
  newLocationName?: string | null;
  /**
   * Δ between new last_seen and old last_seen, in ms.
   *
   *   > 0   fresh data arrived (expected)
   *   = 0   timestamp identical (upload succeeded but timestamp didn't change)
   *   < 0   REGRESSION — incoming data is OLDER than what the store holds.
   *         This is the race-condition signature: a slower, older network
   *         response landed after a faster, newer one.
   *  null   first write for this member (no previous record)
   */
  lastSeenDeltaMs?: number | null;
  /**
   * True when the write was suppressed by fetchSeq race protection —
   * an older in-flight response tried to overwrite a newer committed
   * record and was dropped.  The store is correct; this is logged so
   * we know the protection is firing and how often.
   */
  droppedBySeq?: boolean;

  // ── Batch write (store-upsert-many / store-fetch-all) ──────────────────
  /** Total members in the batch. */
  batchTotal?: number;
  /** Members whose last_seen advanced (fresh data). */
  batchAdvanced?: number;
  /** Members whose last_seen was identical (no change). */
  batchUnchanged?: number;
  /**
   * Members whose last_seen WENT BACKWARD (race condition!).
   * A non-zero value here means an older /members response
   * overwrote a fresher one — the UI will display stale data.
   */
  batchRegressed?: number;
  /** Members that had no prior record (first-ever write for that id). */
  batchFirstWrite?: number;
};

// ---------------------------------------------------------------------------
//  In-memory ring buffer (avoids AsyncStorage round-trips on hot path)
// ---------------------------------------------------------------------------

let inMemory: PipelineEntry[] = [];
let flushPending = false;

function scheduleFlush(): void {
  if (flushPending) return;
  flushPending = true;
  // Defer to next event-loop tick so rapid back-to-back log calls
  // are coalesced into a single AsyncStorage write.
  setTimeout(async () => {
    flushPending = false;
    try {
      const toWrite = pruneBuffer(inMemory, (e) => e.t, MAX_ENTRIES);
      inMemory = toWrite;
      await AsyncStorage.setItem(KEY, JSON.stringify(toWrite));
    } catch (_e) { /* never let flush crash the caller */ }
  }, 0);
}

// ---------------------------------------------------------------------------
//  Public API
// ---------------------------------------------------------------------------

/**
 * Append a pipeline event.  Synchronous in-memory write; async
 * AsyncStorage flush is coalesced and fire-and-forget.
 *
 * Always call inside try-catch at the call site so a logging bug
 * can never affect production data flow.
 */
export function logPipelineEvent(entry: Omit<PipelineEntry, 'seq' | 't'>): void {
  const e: PipelineEntry = {
    seq: nextSeq(),
    t: Date.now(),
    ...entry,
  };
  inMemory.push(e);
  // Hard cap without pruning — pruning happens on flush.
  if (inMemory.length > MAX_ENTRIES * 3) {
    inMemory = inMemory.slice(-MAX_ENTRIES);
  }
  scheduleFlush();
}

/**
 * Read the pipeline log, newest-first.
 * Prefers the in-memory buffer when it is non-empty; falls back to
 * AsyncStorage on cold load (e.g. navigating to Diagnostics after
 * force-kill).
 */
export async function getRefreshPipelineLog(): Promise<PipelineEntry[]> {
  try {
    if (inMemory.length > 0) {
      return [...inMemory].reverse();
    }
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) {
      const arr: PipelineEntry[] = JSON.parse(raw);
      // Warm the in-memory buffer so subsequent reads are free.
      inMemory = pruneBuffer(arr, (e) => e.t, MAX_ENTRIES);
      return [...inMemory].reverse();
    }
    return [];
  } catch (_e) {
    return [];
  }
}

/** Clear both in-memory and persisted logs. */
export async function clearRefreshPipelineLog(): Promise<void> {
  try {
    inMemory = [];
    await AsyncStorage.removeItem(KEY);
  } catch (_e) {}
}
