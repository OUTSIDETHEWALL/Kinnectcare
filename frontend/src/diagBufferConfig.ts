/**
 * Diagnostic Buffer Configuration — Build 46.
 *
 * Single source of truth for every developer ring buffer's capacity
 * and freshness window.  Tuning here propagates to every buffer that
 * imports from this file without touching individual modules.
 *
 * Two-axis bounds:
 *   1. CAP (entries)   — hard max number of records kept.
 *   2. AGE (ms)        — discard anything older than this on every
 *                        write and read, even if the cap hasn't been
 *                        reached.  Keeps Diagnostics focused on
 *                        RECENT history, not a full day of stale data.
 *
 * Both bounds are applied via `pruneBuffer()` so behaviour is
 * identical across all modules.
 *
 * Per Build 46 spec (Joyce, "Diagnostics & Developer Tooling"):
 *   "The diagnostics should reflect recent history, not an entire
 *    day of activity."
 */

/**
 * Per-buffer capacity ceilings.  Smaller numbers = less scrolling on
 * the Diagnostics screen and smaller AsyncStorage payloads.
 *
 * These values are intentionally exposed as constants so we can tune
 * them after observing field data without rewriting any module.
 */
export const DIAG_BUFFER_SIZES = {
  // The six explicitly-listed buffers from the Build 46 spec
  dashboardLoad: 15,
  cardRender: 15,
  engineLog: 25,
  leonidas: 25,
  authClear: 10,
  routeLog: 10,
} as const;

/**
 * Auto-prune horizon — discard entries older than this on every
 * write and read.  Set to ~2 hours per spec.  The exact value isn't
 * critical; the goal is "recent history, not a full day of activity".
 */
export const DIAG_BUFFER_AGE_MS = 2 * 60 * 60 * 1000;

/**
 * Generic prune helper.  Returns a NEW array with:
 *   1. Entries older than DIAG_BUFFER_AGE_MS removed.
 *   2. The remaining entries capped to `maxEntries`, keeping the
 *      newest by array position (assumes oldest-first ordering,
 *      which is the convention every ring buffer in this codebase
 *      already follows: `.push()` to append, `.slice(-MAX)` to cap).
 *
 * `getTs` is supplied per buffer because each module uses a slightly
 * different timestamp field (`at`, `t`, `t_load_started`, etc.).
 *
 * Never throws — a malformed entry whose timestamp evaluates to NaN
 * is filtered out (treated as "infinitely old").
 */
export function pruneBuffer<T>(
  arr: T[],
  getTs: (e: T) => number | null | undefined,
  maxEntries: number,
  now: number = Date.now(),
): T[] {
  const cutoff = now - DIAG_BUFFER_AGE_MS;
  const fresh: T[] = [];
  for (const e of arr) {
    const ts = getTs(e);
    if (typeof ts === 'number' && Number.isFinite(ts) && ts >= cutoff) {
      fresh.push(e);
    }
  }
  if (fresh.length > maxEntries) return fresh.slice(-maxEntries);
  return fresh;
}
