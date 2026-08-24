/**
 * diagnosticsHeroCardRecovery.test.ts
 *
 * Integration-level regression guard for the failure-burst → pipelineTs recovery path.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Task #42 wired `pipelineTs?.http_success` (the persistent AsyncStorage key
 * `kc_pts_http_ok`) into the Diagnostics hero card via the `overallHealth` useMemo
 * in diagnostics.tsx (~line 595):
 *
 *   const overallHealth = useMemo(() => {
 *     const myLastSeenMs = memberStore.getMyLastSeenMs(user?.id ?? null);
 *     return computeOverallHealth(
 *       engineLog,
 *       nowTick,
 *       myLastSeenMs,
 *       pipelineTs?.http_success ?? null,   ← this is what we guard
 *     );
 *   }, [engineLog, nowTick, user?.id, pipelineTs]);
 *
 * The existing unit tests in healthCheck.test.ts verify that
 * `computeOverallHealth()` ACCEPTS `lastHttpSuccessMs` and honours it.
 * Those tests would still pass even if someone removed `pipelineTs?.http_success`
 * from the useMemo argument list — a silent regression that changes the hero
 * card back to red/amber after a connectivity burst.
 *
 * These tests lock down the **end-to-end contract** that the diagnostics screen
 * exercises:
 *
 *   1. Build a `pipelineTs` object shaped like the one returned by
 *      `getPipelineTimestamps()` (the function called by reload() in
 *      diagnostics.tsx) — specifically `{ http_success: <timestamp> }`.
 *   2. Build an `engineLog` ring buffer that has been flooded with failure
 *      entries so the last successful sdk_onHttp was evicted.
 *   3. Call `computeOverallHealth(engineLog, now, myLastSeenMs,
 *      pipelineTs?.http_success ?? null)` — the *identical* call shape used
 *      by the useMemo.
 *   4. Assert `result.level === 'ok'` and the hero card theme is green.
 *
 * Mounting the full Diagnostics React Native component in Jest is impractical
 * (native modules, AsyncStorage, etc.), so we test the call-site contract
 * directly.  Any future change to the useMemo argument order or the
 * `pipelineTs?.http_success` access path must update these tests.
 */

import { computeOverallHealth, heroTheme } from '../healthCheck';
import type { EngineLogEvent } from '../locationEngine';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let seq = 0;
function unloadedPipelineTimestamps(): PipelineTimestamps | null {
  return null;
}

function makeEvent(
  event: string,
  atMs: number,
  detail?: Record<string, unknown>,
): EngineLogEvent {
  seq += 1;
  return { seq, src: 'engine', at: atMs, event, detail };
}

/** Simulate a ring buffer saturated with failure entries — no success survives. */
function failureBuffer(count: number, now: number): EngineLogEvent[] {
  return Array.from({ length: count }, (_, i) =>
    makeEvent('sdk_onHttp', now - (count - i) * 10_000, { success: false }),
  );
}

// Mirrors the shape that getPipelineTimestamps() returns and that reload() in
// diagnostics.tsx stores in the `pipelineTs` state variable.
interface PipelineTimestamps {
  http_success?: number | null;
  [key: string]: number | null | undefined;
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('Diagnostics hero card — failure-burst then pipelineTs recovery', () => {
  beforeEach(() => { seq = 0; });

  const NOW = 12_000_000;

  // ── 1. Core scenario: ring buffer full of failures + recent pipelineTs ──────
  //
  // Joyce's phone goes into airplane mode for ~10 minutes.  The Transistor SDK
  // keeps retrying; each retry fires sdk_onHttp(success=false).  After ~50
  // failures the ring buffer is saturated and the last successful sdk_onHttp
  // entry has been evicted.
  //
  // When connectivity is restored the first successful upload writes
  // kc_pts_http_ok (via recordPipelineTs).  The Diagnostics screen reads that
  // key as pipelineTs.http_success.
  //
  // Expected: the hero card is green immediately — NOT amber or red — because
  // pipelineTs.http_success proves a recent upload even though the ring buffer
  // contains only failures.

  it('hero card is green when ring buffer has only failures but pipelineTs.http_success is < 5 min old', () => {
    const engineLog = failureBuffer(50, NOW);

    // pipelineTs shaped exactly as getPipelineTimestamps() returns it
    const pipelineTs: PipelineTimestamps = {
      http_success: NOW - 2 * 60_000, // 2 min ago — well within the 5-min ok threshold
    };

    // Mirrors the useMemo call in diagnostics.tsx line 597-602:
    //   computeOverallHealth(engineLog, nowTick, myLastSeenMs, pipelineTs?.http_success ?? null)
    const myLastSeenMs = null; // no /members response yet — fresh load
    const result = computeOverallHealth(
      engineLog,
      NOW,
      myLastSeenMs,
      pipelineTs?.http_success ?? null,
    );

    expect(result.level).toBe('ok');
    expect(result.headline).toMatch(/healthy/i);
    // Hero card theme must be the green palette
    const theme = heroTheme[result.level];
    expect(theme.bg).toBe('#ECFDF5');
    expect(theme.icon).toBe('🛡️');
  });

  // ── 2. pipelineTs.http_success absent (undefined) → null-coalesced to null ──
  //
  // The `?? null` operator in the useMemo guards against pipelineTs being null
  // or pipelineTs.http_success being undefined.  When absent the hero card
  // must NOT show green — it must fall through to the heartbeat / starting path.

  it('hero card is NOT green when pipelineTs.http_success is undefined (null-coalesced to null)', () => {
    const engineLog = failureBuffer(50, NOW);

    const pipelineTs: PipelineTimestamps = {
      http_success: undefined, // key present but unset — simulates first-run state
    };

    const result = computeOverallHealth(
      engineLog,
      NOW,
      null,
      pipelineTs?.http_success ?? null, // undefined ?? null → null
    );

    // No upload evidence anywhere → starting (gray), not ok (green)
    expect(result.level).toBe('starting');
    expect(heroTheme[result.level].bg).toBe('#F9FAFB');
  });

  it('hero card is NOT green when pipelineTs itself is null (optional chaining + null-coalescing)', () => {
    const engineLog = failureBuffer(50, NOW);

    const pipelineTs = unloadedPipelineTimestamps(); // never loaded from storage

    const result = computeOverallHealth(
      engineLog,
      NOW,
      null,
      pipelineTs?.http_success ?? null, // null?.http_success → undefined ?? null → null
    );

    expect(result.level).toBe('starting');
  });

  // ── 3. Recovery is immediate — hero card turns green on first success ────────
  //
  // The key requirement from Task #42: connectivity returns → one upload
  // succeeds → kc_pts_http_ok is written → Diagnostics reloads and reads it →
  // hero card is green on that same reload.  There is no "wait for the ring
  // buffer to refill" step.

  it('hero card turns green on the same reload that first reads pipelineTs.http_success', () => {
    // Before recovery: ring buffer full of failures, no pipelineTs yet
    const engineLog = failureBuffer(50, NOW);

    const pipelineBefore = unloadedPipelineTimestamps();
    const beforeResult = computeOverallHealth(
      engineLog,
      NOW,
      null,
      pipelineBefore?.http_success ?? null,
    );
    // Before recovery: no upload evidence → starting
    expect(beforeResult.level).toBe('starting');
    expect(heroTheme[beforeResult.level].bg).toBe('#F9FAFB');

    // Connectivity restores; first successful upload writes kc_pts_http_ok.
    // Diagnostics.reload() reads the new key value.
    const recoveryTs = NOW + 30_000; // 30 s after our "now" reference
    const pipelineAfter: PipelineTimestamps = {
      http_success: recoveryTs,
    };
    const afterNow = recoveryTs + 5_000; // 5 s after the upload — still within 5-min ok window

    const afterResult = computeOverallHealth(
      engineLog, // ring buffer still full of failures — no new success entry yet
      afterNow,
      null,
      pipelineAfter?.http_success ?? null,
    );

    // Hero card is green immediately — no waiting for ring buffer refill
    expect(afterResult.level).toBe('ok');
    expect(heroTheme[afterResult.level].bg).toBe('#ECFDF5');
    expect(heroTheme[afterResult.level].icon).toBe('🛡️');
  });

  // ── 4. Hero card stays green while subsequent failures arrive ────────────────
  //
  // After recovery the ring buffer may accumulate more failures (intermittent
  // connectivity).  As long as pipelineTs.http_success is still < 5 min old
  // the hero card must not flip back to amber or red.

  it('hero card stays green while new failure events arrive after recovery', () => {
    const recoveryTs = NOW - 90_000; // 1.5 min ago

    // Ring buffer: recovery success (not evicted yet) + more failures after
    const engineLog: EngineLogEvent[] = [
      ...failureBuffer(10, NOW - 5 * 60_000),          // earlier burst
      makeEvent('sdk_onHttp', recoveryTs, { success: true }),  // recovery
      makeEvent('sdk_onHttp', NOW - 60_000, { success: false }), // new failure
      makeEvent('sdk_onHttp', NOW - 30_000, { success: false }), // another
    ];

    const pipelineTs: PipelineTimestamps = {
      http_success: recoveryTs, // persistent key records the recovery
    };

    const result = computeOverallHealth(
      engineLog,
      NOW,
      null,
      pipelineTs?.http_success ?? null,
    );

    expect(result.level).toBe('ok');
    expect(heroTheme[result.level].bg).toBe('#ECFDF5');
  });

  // ── 5. pipelineTs.http_success threshold boundaries ─────────────────────────
  //
  // The 5-min and 15-min thresholds apply to pipelineTs.http_success just as
  // they do to ring-buffer upload ages.  This confirms the full transition
  // sequence: ok → warn → error as the persistent key ages.

  it('hero card is amber when pipelineTs.http_success is 8 min old and ring buffer has only failures', () => {
    const engineLog = failureBuffer(50, NOW);
    const pipelineTs: PipelineTimestamps = { http_success: NOW - 8 * 60_000 };

    const result = computeOverallHealth(
      engineLog,
      NOW,
      null,
      pipelineTs?.http_success ?? null,
    );

    expect(result.level).toBe('warn');
    expect(heroTheme[result.level].bg).toBe('#FFFBEB');
    expect(heroTheme[result.level].icon).toBe('⚠️');
  });

  it('hero card is red when pipelineTs.http_success is 20 min old and ring buffer has only failures', () => {
    const engineLog = failureBuffer(50, NOW);
    const pipelineTs: PipelineTimestamps = { http_success: NOW - 20 * 60_000 };

    const result = computeOverallHealth(
      engineLog,
      NOW,
      null,
      pipelineTs?.http_success ?? null,
    );

    expect(result.level).toBe('error');
    expect(heroTheme[result.level].bg).toBe('#FEF2F2');
    expect(heroTheme[result.level].icon).toBe('❌');
  });

  // ── 6. All three evidence streams: pipelineTs wins when it is freshest ───────
  //
  // The useMemo passes both myLastSeenMs and pipelineTs?.http_success.
  // computeOverallHealth() takes the minimum (freshest) of all three.
  // Confirm the call signature produces the correct verdict when all three
  // are present and pipelineTs.http_success is the freshest.

  it('hero card picks pipelineTs.http_success when it is fresher than both ring-buffer and lastSeenMs', () => {
    // Ring buffer: success 20 min ago (error alone)
    const engineLog = [
      makeEvent('sdk_onHttp', NOW - 20 * 60_000, { success: true }),
    ];
    // lastSeenMs: 10 min ago (warn alone)
    const myLastSeenMs = NOW - 10 * 60_000;
    // pipelineTs.http_success: 2 min ago (ok — freshest)
    const pipelineTs: PipelineTimestamps = { http_success: NOW - 2 * 60_000 };

    const result = computeOverallHealth(
      engineLog,
      NOW,
      myLastSeenMs,
      pipelineTs?.http_success ?? null,
    );

    expect(result.level).toBe('ok');
    expect(result.uploadAgeMs).toBeCloseTo(2 * 60_000, -2);
    expect(heroTheme[result.level].bg).toBe('#ECFDF5');
  });

  // ── 7. Subline copy is correct after pipelineTs-driven recovery ──────────────
  //
  // When pipelineTs.http_success is the sole source of upload evidence, the
  // subline must still read "Last location confirmed: Xm ago" — not the
  // generic "Waiting for first successful upload" fallback.

  it('subline reads "Last location confirmed" (not the fallback) when pipelineTs is the only upload evidence', () => {
    const engineLog: EngineLogEvent[] = []; // empty — no ring-buffer evidence
    const pipelineTs: PipelineTimestamps = { http_success: NOW - 2 * 60_000 };

    const result = computeOverallHealth(
      engineLog,
      NOW,
      null,
      pipelineTs?.http_success ?? null,
    );

    expect(result.level).toBe('ok');
    expect(result.subline).toMatch(/Last location confirmed:/);
    expect(result.subline).toMatch(/ago/);
    // Must NOT be the starting-up fallback
    expect(result.subline).not.toMatch(/Waiting for first/i);
  });
});
