/**
 * Diagnostic event sequence counter — v1.2.0 (44).
 *
 * A single in-memory monotonic counter shared by every diagnostic
 * ring buffer (engine log, dashboard load log, card render log).
 *
 * Why this exists: the diagnostic timeline often has multiple events
 * fire at the same epoch ms (sub-ms precision is below JS Date.now()
 * resolution).  Without a strict ordering signal, two log entries
 * with `at: 1719432000000` could have happened in either order,
 * which masks race conditions like "broadcast fired BEFORE setMembers
 * flushed" vs "setMembers flushed BEFORE broadcast fired".
 *
 * A monotonic seq makes the ordering unambiguous within a single app
 * session.  Across sessions we rely on `at` epoch ms (seq resets on
 * cold start — acceptable because the bugs we chase happen within a
 * single session).
 *
 * The `src` tag in each entry indicates which subsystem emitted the
 * log line, so a unified timeline view can colour-code or filter by
 * subsystem.  Standard tags used in this build:
 *
 *    'engine'         — locationEngine.ts (Transistor SDK wrapper)
 *    'dashboard-load' — dashboardLoadLog.ts (each /members fetch)
 *    'card-render'    — cardRenderLog.ts (each MemberCard render)
 *    'broadcast'      — cardRenderLog.ts (each subscribeMember event)
 *
 * Note: NO AsyncStorage round-trip on increment — the counter is
 * pure in-memory.  Persisting per-increment would add latency to
 * every log call (10-30 ms) which is too expensive for a hot path
 * like MemberCard renders.
 */

let counter = 0;

/** Return the next strictly-increasing sequence number for this session. */
export function nextSeq(): number {
  counter += 1;
  return counter;
}

/** Peek without incrementing — useful for assertions, never for log writes. */
export function currentSeq(): number {
  return counter;
}
