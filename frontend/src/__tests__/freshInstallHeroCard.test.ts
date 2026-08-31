/**
 * freshInstallHeroCard.test.ts
 *
 * Regression guard for the fresh-install startup sequence of the Diagnostics
 * hero card (computeOverallHealth / Task #74).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * On a brand-new install every AsyncStorage key is absent:
 *   • The engine log ring buffer is empty (no sdk_onHttp, no sdk_onHeartbeat).
 *   • kc_pts_http_ok (pipelineTs.http_success) has never been written.
 *   • member.last_seen is null because the /members API hasn't responded yet.
 *
 * The hero card must show 'starting' in this state — not amber or red.
 *
 * Within 2–3 minutes the Transistor SDK fires its first background upload.
 * That upload calls recordPipelineTs('http_success'), which writes kc_pts_http_ok.
 *
 * HOW THE SCREEN LEARNS ABOUT THE UPLOAD
 * ---------------------------------------
 * The Diagnostics screen reads pipeline timestamps only during reload() (called
 * at mount-time).  The 1-second nowTick interval only changes `now`; it never
 * re-reads AsyncStorage.  Therefore, without an additional mechanism, the hero
 * card would stay 'starting' indefinitely after the first upload.
 *
 * The fix (diagnostics.tsx, added alongside Task #74): a 30-second setInterval
 * effect that calls getLastHttpSuccessTs() — a single AsyncStorage key read —
 * and applies a functional update to pipelineTs state when the value changes:
 *
 *   setPipelineTs(prev =>
 *     (!prev || prev.http_success === httpSuccessMs)
 *       ? prev
 *       : { ...prev, http_success: httpSuccessMs }
 *   );
 *
 * After that state update the overallHealth useMemo re-runs with the new
 * pipelineTs.http_success, flipping the hero card from 'starting' to 'ok' —
 * without waiting for the /members API.
 *
 * The maximum latency from upload to green hero is 30 seconds (one poll
 * cycle), well within the "within 5 minutes" requirement.
 *
 * WHAT IS TESTED
 * --------------
 *  Phase 1 — Immediately after install:
 *    empty log + pipelineTs null + no lastSeenMs  →  level 'starting'
 *
 *  Phase 2 — After first upload (within 2–3 min):
 *    pipelineTs.http_success set to a recent timestamp  →  level 'ok',
 *    green theme, no /members response needed
 *
 *  Update path (the pipelineTs refresh mechanism):
 *    Verifies the functional setPipelineTs update that the 30-second effect
 *    applies when getLastHttpSuccessTs() returns a new value.
 *
 *  Timing coverage:
 *    Uploads at 1 min, 2 min, 4 min 59 s all → 'ok'.
 *    At exactly 5 min → 'warn' (honest degraded, not a false alarm).
 *
 *  Headless-path coverage:
 *    Ring buffer stays empty but pipelineTs.http_success alone drives recovery.
 *
 *  pipelineTs shape:
 *    PipelineTimestamps with http_success set and all other keys null (the
 *    state right after the very first upload from getPipelineTimestamps()).
 *
 *  nowTick sequence:
 *    10 consecutive 1-second ticks all stay green after reload.
 */

import {
  computeOverallHealth,
  heroTheme,
  OverallHealthResult,
} from '../healthCheck';
import type { EngineLogEvent } from '../locationEngine';
import type { PipelineTimestamps } from '../locationEngine';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let seq = 0;
function makeEvent(
  event: string,
  atMs: number,
  detail?: Record<string, unknown>,
): EngineLogEvent {
  seq += 1;
  return { seq, src: 'engine', at: atMs, event, detail };
}

/**
 * Simulate the useMemo call from diagnostics.tsx:
 *
 *   const overallHealth = useMemo(() => {
 *     const myLastSeenMs = memberStore.getMyLastSeenMs(user?.id ?? null);
 *     return computeOverallHealth(
 *       engineLog, nowTick, myLastSeenMs,
 *       pipelineTs?.http_success ?? null,
 *     );
 *   }, [engineLog, nowTick, user?.id, pipelineTs]);
 *
 * Returns the full OverallHealthResult so tests can access uploadAgeMs.
 */
function heroCard(
  engineLog: EngineLogEvent[],
  nowTick: number,
  lastSeenMs: number | null,
  pipelineTs: PipelineTimestamps | null,
): OverallHealthResult {
  return computeOverallHealth(
    engineLog,
    nowTick,
    lastSeenMs,
    pipelineTs?.http_success ?? null,
  );
}

/**
 * Build a PipelineTimestamps object shaped exactly as getPipelineTimestamps()
 * returns it after the very first upload — http_success is set, everything
 * else is null.
 */
function firstUploadPipelineTs(uploadTs: number): PipelineTimestamps {
  return {
    motion:             null,
    activity:           null,
    location:           null,
    heartbeat_js:       null,
    headless_invoked:   null,
    headless_heartbeat: null,
    headless_battery:   null,
    http_attempt:       null,
    http_success:       uploadTs,   // ← the only non-null field after the first upload
    listeners_attached: null,
  };
}

/**
 * The functional state update applied by the 30-second pipelineTs refresh
 * effect in diagnostics.tsx:
 *
 *   setPipelineTs(prev =>
 *     (!prev || prev.http_success === httpSuccessMs)
 *       ? prev
 *       : { ...prev, http_success: httpSuccessMs }
 *   );
 *
 * Extracted here so tests can verify the update logic directly without
 * mounting the component.
 */
function applyHttpSuccessUpdate(
  prev: PipelineTimestamps | null,
  httpSuccessMs: number | null,
): PipelineTimestamps | null {
  if (!prev || prev.http_success === httpSuccessMs) return prev;
  return { ...prev, http_success: httpSuccessMs };
}

// ─── Three-state fresh-install sequence ─────────────────────────────────────
//
// A fresh install has an intentional intermediate state between "nothing has
// happened yet" and "the first upload succeeded":
//   starting → heartbeat received → warn → upload confirmed → ok
//
// Keep this sequence separate from the broader timing and state-refresh tests
// below so a future change to the heartbeat fallback cannot silently remove
// the amber state caregivers see during startup.
describe('Fresh-install hero card three-state sequence — starting → warn → ok', () => {
  beforeEach(() => { seq = 0; });

  const T_INSTALL = 20_000_000;

  it('shows starting when a fresh install has no heartbeat and no upload', () => {
    const result = heroCard([], T_INSTALL, null, null);

    expect(result.level).toBe('starting');
  });

  it('shows warn, not starting or error, after the first heartbeat but before the first upload', () => {
    const heartbeatAt = T_INSTALL + 60_000;
    const log = [makeEvent('sdk_onHeartbeat', heartbeatAt)];
    const result = heroCard(log, heartbeatAt + 1_000, null, null);

    expect(result.level).toBe('warn');
    expect(result.level).not.toBe('starting');
    expect(result.level).not.toBe('error');
    expect(heroTheme[result.level].bg).toBe('#FFFBEB');
    // This is the prominent copy rendered by the hero card; it must not
    // regress to the red "monitoring stopped" message.
    expect(result.headline).toBe('Engine running, no upload confirmed yet');
    expect(result.subline).toContain('upload confirmation expected');
    expect(result.subline).not.toMatch(/stopped|error|permission/i);
  });

  it('shows ok after the first heartbeat is followed by the first upload', () => {
    const heartbeatAt = T_INSTALL + 60_000;
    const uploadAt = heartbeatAt + 30_000;
    const log = [
      makeEvent('sdk_onHeartbeat', heartbeatAt),
      makeEvent('sdk_onHttp', uploadAt, { success: true }),
    ];
    const result = heroCard(
      log,
      uploadAt + 1_000,
      null,
      firstUploadPipelineTs(uploadAt),
    );

    expect(result.level).toBe('ok');
    expect(result.headline).toMatch(/healthy/i);
  });
});

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('Fresh-install hero card startup — starting → ok within 5 minutes', () => {
  beforeEach(() => { seq = 0; });

  // Arbitrary "now" reference used throughout this suite.
  const T_INSTALL = 20_000_000;

  // ── Phase 1: Immediately after install ───────────────────────────────────
  //
  // All evidence streams are absent:
  //   • engineLog is empty (no sdk_onHttp, no sdk_onHeartbeat events yet)
  //   • pipelineTs is null (AsyncStorage has never been written)
  //   • lastSeenMs is null (/members API has not responded)
  //
  // Expected: level 'starting' — gray, informational, not a failure.

  it('Phase 1: hero card shows starting immediately after a fresh install', () => {
    const result = heroCard([], T_INSTALL, null, null);
    expect(result.level).toBe('starting');
    expect(result.headline).toMatch(/starting up/i);
    expect(heroTheme[result.level].bg).toBe('#F9FAFB');   // gray — not red or amber
    expect(heroTheme[result.level].icon).toBe('⏳');
  });

  it('Phase 1: starting state does not produce an error-level theme (no false alarm)', () => {
    const result = heroCard([], T_INSTALL, null, null);
    // Must be neither error (red) nor warn (amber) — it is simply "not yet seen"
    expect(result.level).not.toBe('error');
    expect(result.level).not.toBe('warn');
    // Confirm the error and warn palettes are NOT in use
    expect(heroTheme[result.level].bg).not.toBe('#FEF2F2'); // error red
    expect(heroTheme[result.level].bg).not.toBe('#FFFBEB'); // warn amber
  });

  it('Phase 1: starting state persists when only non-upload events are in the log', () => {
    // battery_listeners_attached and sdk_onPowerSaveChange may arrive before
    // the first upload — the hero card must still show starting.
    const log: EngineLogEvent[] = [
      makeEvent('battery_listeners_attached', T_INSTALL - 500),
      makeEvent('sdk_onPowerSaveChange',      T_INSTALL - 400, { isPowerSaveMode: false }),
      makeEvent('sdk_onEnabledChange',        T_INSTALL - 300, { enabled: true }),
    ];
    const result = heroCard(log, T_INSTALL, null, null);
    expect(result.level).toBe('starting');
  });

  // ── Phase 2: First upload fires (within 2–3 minutes of install) ──────────
  //
  // recordPipelineTs('http_success') is called by the onHttp handler →
  // kc_pts_http_ok is written to AsyncStorage.
  //
  // The 30-second pipelineTs refresh effect in diagnostics.tsx reads the new
  // value via getLastHttpSuccessTs() and applies a functional update to
  // pipelineTs state.  On the next nowTick the overallHealth useMemo runs.
  //
  // Key assertion: level flips to 'ok' WITHOUT /members returning (lastSeenMs
  // stays null throughout this test).

  it('Phase 2: hero card flips to ok when pipelineTs.http_success is 1 min old — no /members needed', () => {
    const uploadTs = T_INSTALL + 60_000;   // upload fired 1 min after install
    const nowTick  = uploadTs + 5_000;     // 5 s after the upload (first nowTick after state update)

    const pipelineTs = firstUploadPipelineTs(uploadTs);
    const result = heroCard([], nowTick, null /* lastSeenMs absent */, pipelineTs);

    expect(result.level).toBe('ok');
    expect(result.headline).toMatch(/healthy/i);
    expect(heroTheme[result.level].bg).toBe('#ECFDF5');   // green
    expect(heroTheme[result.level].icon).toBe('🛡️');
  });

  it('Phase 2: hero card flips to ok when pipelineTs.http_success is 2 min old', () => {
    const uploadTs = T_INSTALL + 60_000;
    const nowTick  = uploadTs + 2 * 60_000;

    const pipelineTs = firstUploadPipelineTs(uploadTs);
    const result = heroCard([], nowTick, null, pipelineTs);

    expect(result.level).toBe('ok');
    expect(result.uploadAgeMs).toBeCloseTo(2 * 60_000, -2);
  });

  it('Phase 2: hero card flips to ok when pipelineTs.http_success is 4m 59s old (< 5-min boundary)', () => {
    const uploadTs = T_INSTALL + 60_000;
    const nowTick  = uploadTs + (5 * 60_000 - 1_000);  // 4 min 59 s after upload

    const pipelineTs = firstUploadPipelineTs(uploadTs);
    const result = heroCard([], nowTick, null, pipelineTs);

    expect(result.level).toBe('ok');
  });

  it('Phase 2: subline reads "Last location confirmed: Xm ago" after the first upload', () => {
    const uploadTs = T_INSTALL + 90_000;   // 1.5 min after install
    const nowTick  = uploadTs + 10_000;    // 10 s after upload

    const pipelineTs = firstUploadPipelineTs(uploadTs);
    const result = heroCard([], nowTick, null, pipelineTs);

    expect(result.level).toBe('ok');
    expect(result.subline).toMatch(/Last location confirmed:/);
    expect(result.subline).toMatch(/ago/);
    // Must NOT fall back to the starting-up copy
    expect(result.subline).not.toMatch(/Waiting for first/i);
  });

  // ── Clock-skew tolerance ──────────────────────────────────────────────────
  //
  // A timestamp can briefly be ahead of nowTick if the device clock changes
  // between recordPipelineTs() and the Diagnostics interval tick.  Small
  // bounded skew should keep the hero green, while a larger future jump must
  // not be treated as upload evidence.

  it.each([1, 3, 5])(
    'Clock skew: keeps the hero green when pipelineTs.http_success is %i second(s) in the future',
    (secondsAhead) => {
      const nowTick = T_INSTALL + 2 * 60_000;
      const futureUploadTs = nowTick + secondsAhead * 1_000;
      const pipelineTs = firstUploadPipelineTs(futureUploadTs);

      const result = heroCard([], nowTick, null, pipelineTs);

      expect(result.level).toBe('ok');
      expect(result.uploadAgeMs).toBe(0);
      expect(heroTheme[result.level].bg).toBe('#ECFDF5');
    },
  );

  it('Clock skew: stays green when the next 1-second tick catches up with the timestamp', () => {
    const nowTick = T_INSTALL + 2 * 60_000;
    const uploadTs = nowTick + 1_000;
    const pipelineTs = firstUploadPipelineTs(uploadTs);

    const beforeCatchUp = heroCard([], nowTick, null, pipelineTs);
    expect(beforeCatchUp.level).toBe('ok');
    expect(beforeCatchUp.uploadAgeMs).toBe(0);

    const afterCatchUp = heroCard([], nowTick + 1_000, null, pipelineTs);
    expect(afterCatchUp.level).toBe('ok');
    expect(afterCatchUp.uploadAgeMs).toBe(0);
    expect(heroTheme[afterCatchUp.level].bg).toBe('#ECFDF5');
  });

  it('Clock skew: rejects a timestamp more than 5 seconds ahead and remains starting', () => {
    const nowTick = T_INSTALL + 2 * 60_000;
    const pipelineTs = firstUploadPipelineTs(nowTick + 6_000);

    const result = heroCard([], nowTick, null, pipelineTs);

    expect(result.level).toBe('starting');
    expect(result.uploadAgeMs).toBeNull();
    expect(heroTheme[result.level].bg).toBe('#F9FAFB');
  });

  // ── pipelineTs state refresh — the real update path ──────────────────────
  //
  // The 30-second setInterval effect in diagnostics.tsx keeps pipelineTs
  // current by calling getLastHttpSuccessTs() and applying a functional state
  // update.  These tests verify the update logic independently, without
  // mounting the component.
  //
  // The update function (applyHttpSuccessUpdate above) mirrors the exact
  // setPipelineTs callback used in the effect.

  it('State update: pipelineTs.http_success null → first upload timestamp flips hero to ok', () => {
    const uploadTs = T_INSTALL + 2 * 60_000;
    const nowTick  = uploadTs + 15_000;

    // Before the first upload: reload() populated pipelineTs with all-null values
    const prevPipelineTs = firstUploadPipelineTs(0); // use 0 as "null upload" sentinel
    const before = { ...prevPipelineTs, http_success: null as number | null };

    // getLastHttpSuccessTs() returns the new upload timestamp
    const after = applyHttpSuccessUpdate(before, uploadTs);

    // The update must produce a new object with the upload timestamp
    expect(after).not.toBe(before); // new object — triggers React re-render
    expect(after!.http_success).toBe(uploadTs);

    // Hero card is now ok
    const result = heroCard([], nowTick, null, after);
    expect(result.level).toBe('ok');
  });

  it('State update: returns prev unchanged when pipelineTs is null (not yet loaded)', () => {
    // Before reload() completes, pipelineTs state is null.
    // The effect must not create a partial object — it should wait.
    const prev: PipelineTimestamps | null = null;
    const after = applyHttpSuccessUpdate(prev, T_INSTALL);

    // Must return the same null reference — no new object created
    expect(after).toBeNull();
  });

  it('State update: returns prev unchanged when http_success has not changed', () => {
    const uploadTs = T_INSTALL + 60_000;
    const prev = firstUploadPipelineTs(uploadTs);

    // getLastHttpSuccessTs() returns the same value — no change
    const after = applyHttpSuccessUpdate(prev, uploadTs);

    // Must return the same object reference — no unnecessary re-renders
    expect(after).toBe(prev);
  });

  it('State update: updates http_success when a newer upload timestamp is available', () => {
    const firstUploadTs  = T_INSTALL + 60_000;
    const secondUploadTs = T_INSTALL + 3 * 60_000;
    const prev = firstUploadPipelineTs(firstUploadTs);

    const after = applyHttpSuccessUpdate(prev, secondUploadTs);

    expect(after).not.toBe(prev); // new object
    expect(after!.http_success).toBe(secondUploadTs);
    // All other fields preserved from prev
    expect(after!.motion).toBeNull();
    expect(after!.heartbeat_js).toBeNull();
  });

  it('Full sequence: starting → state update fires → ok within one 30-second poll cycle', () => {
    const uploadTs = T_INSTALL + 2 * 60_000; // upload 2 min after install

    // T=0: mount, reload() runs, pipelineTs has no http_success yet
    const initialPts = { ...firstUploadPipelineTs(0), http_success: null as number | null };
    const atMount = heroCard([], T_INSTALL, null, initialPts as unknown as PipelineTimestamps);
    expect(atMount.level).toBe('starting');

    // T+120s: first upload fires (kc_pts_http_ok written to AsyncStorage)
    // T+150s (≤30s later): the refresh effect polls getLastHttpSuccessTs() and
    //   calls setPipelineTs(prev => ({ ...prev, http_success: uploadTs }))
    const updatedPts = applyHttpSuccessUpdate(
      initialPts as unknown as PipelineTimestamps,
      uploadTs,
    );
    // T+151s: next nowTick — hero card re-evaluates with updatedPts
    const afterUpdate = heroCard([], uploadTs + 31_000, null, updatedPts);
    expect(afterUpdate.level).toBe('ok');
    expect(afterUpdate.headline).toMatch(/healthy/i);
  });

  // ── Headless-path coverage ────────────────────────────────────────────────
  //
  // The first upload may happen in a headless JS context that does NOT call
  // startEngine() or attachSdkListeners().  No sdk_onHttp entry lands in the
  // ring buffer — BUT the headless HTTP handler still calls
  // recordPipelineTs('http_success'), writing kc_pts_http_ok.
  //
  // The hero card must recover from pipelineTs.http_success alone, with no
  // ring-buffer or lastSeenMs evidence.

  it('Headless path: hero card recovers even when ring buffer has no sdk_onHttp entry', () => {
    const uploadTs = T_INSTALL + 2 * 60_000;
    const nowTick  = uploadTs + 15_000;

    const log: EngineLogEvent[] = [
      makeEvent('headless_task_invoked', uploadTs - 5_000),  // headless woke up
      // no sdk_onHttp — headless path does not log it in the ring buffer
    ];
    const pipelineTs = firstUploadPipelineTs(uploadTs);

    const result = heroCard(log, nowTick, null, pipelineTs);

    expect(result.level).toBe('ok');
    expect(result.headline).toMatch(/healthy/i);
  });

  it('Headless path: ring buffer is empty, pipelineTs.http_success drives the verdict', () => {
    const uploadTs = T_INSTALL + 3 * 60_000;
    const nowTick  = uploadTs + 30_000;

    const pipelineTs = firstUploadPipelineTs(uploadTs);
    const result = heroCard([], nowTick, null, pipelineTs);

    expect(result.level).toBe('ok');
    expect(result.uploadAgeMs).toBeCloseTo(30_000, -3);
  });

  // ── pipelineTs shape (as returned by getPipelineTimestamps()) ────────────
  //
  // getPipelineTimestamps() returns a PipelineTimestamps object with ALL keys
  // present, set to null when never written.  After the very first upload
  // only http_success is non-null.

  it('pipelineTs with only http_success non-null (sparse first-upload shape) produces ok', () => {
    const uploadTs = T_INSTALL + 2 * 60_000;
    const nowTick  = uploadTs + 20_000;

    const pipelineTs: PipelineTimestamps = firstUploadPipelineTs(uploadTs);

    // Confirm all other keys are null — as they would be on first run
    expect(pipelineTs.motion).toBeNull();
    expect(pipelineTs.activity).toBeNull();
    expect(pipelineTs.location).toBeNull();
    expect(pipelineTs.heartbeat_js).toBeNull();
    expect(pipelineTs.headless_invoked).toBeNull();
    expect(pipelineTs.headless_heartbeat).toBeNull();
    expect(pipelineTs.headless_battery).toBeNull();
    expect(pipelineTs.http_attempt).toBeNull();
    expect(pipelineTs.listeners_attached).toBeNull();

    // Only http_success is set
    expect(pipelineTs.http_success).toBe(uploadTs);

    const result = heroCard([], nowTick, null, pipelineTs);
    expect(result.level).toBe('ok');
  });

  // ── Timing boundary: 5 minutes ───────────────────────────────────────────
  //
  // The task requires the hero card to recover "within 5 minutes."
  // At exactly the 5-minute boundary the level transitions to warn.
  // That is honest degradation — not a false alarm.

  it('At exactly 5 minutes, hero card transitions to warn (honest delayed — not a false alarm)', () => {
    const uploadTs = T_INSTALL + 60_000;
    const nowTick  = uploadTs + 5 * 60_000;

    const pipelineTs = firstUploadPipelineTs(uploadTs);
    const result = heroCard([], nowTick, null, pipelineTs);

    expect(result.level).toBe('warn');
    expect(result.headline).toMatch(/delayed/i);
    expect(heroTheme[result.level].bg).toBe('#FFFBEB'); // amber, not red
  });

  it('Within 4m 59s of the upload, hero card is always ok — no premature amber', () => {
    const uploadTs = T_INSTALL + 60_000;
    const pipelineTs = firstUploadPipelineTs(uploadTs);

    const checkpoints = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 280];
    for (const secondsAfterUpload of checkpoints) {
      const nowTick = uploadTs + secondsAfterUpload * 1_000;
      const result = heroCard([], nowTick, null, pipelineTs);
      expect(result.level).toBe('ok');
    }
  });

  // ── Full nowTick sequence simulation ─────────────────────────────────────

  it('Hero card stays green across 10 consecutive 1-second nowTick ticks after state update', () => {
    const uploadTs = T_INSTALL + 2 * 60_000;
    const pipelineTs = firstUploadPipelineTs(uploadTs);

    for (let tick = 0; tick < 10; tick++) {
      const nowTick = uploadTs + tick * 1_000;
      const result = heroCard([], nowTick, null, pipelineTs);
      expect(result.level).toBe('ok');
    }
  });

  // ── No /members race condition ────────────────────────────────────────────

  it('Hero card is ok regardless of whether lastSeenMs is present', () => {
    const uploadTs = T_INSTALL + 2 * 60_000;
    const nowTick  = uploadTs + 20_000;
    const pipelineTs = firstUploadPipelineTs(uploadTs);

    const resultNoMembers = heroCard([], nowTick, null, pipelineTs);
    expect(resultNoMembers.level).toBe('ok');

    const resultWithMembers = heroCard([], nowTick, uploadTs - 10_000, pipelineTs);
    expect(resultWithMembers.level).toBe('ok');
  });

  it('Hero card reaches ok from pipelineTs before the /members API responds (race confirmed safe)', () => {
    const uploadTs = T_INSTALL + 150_000;
    const pipelineTs = firstUploadPipelineTs(uploadTs);
    const nowTick = uploadTs + 8_000; // 8 s after upload — /members not back yet

    const result = heroCard([], nowTick, null /* /members not back */, pipelineTs);

    expect(result.level).toBe('ok');
    expect(result.headline).toMatch(/healthy/i);
  });

  // ── pipelineTs?.http_success ?? null call-site contract ──────────────────
  //
  // Confirms the optional-chain + null-coalescing expression used in the
  // useMemo correctly extracts the timestamp, handles null pipelineTs, and
  // handles a null http_success key.

  it('pipelineTs?.http_success ?? null extracts the timestamp correctly', () => {
    const uploadTs = T_INSTALL + 2 * 60_000;
    const nowTick  = uploadTs + 10_000;

    const pipelineTs: PipelineTimestamps = firstUploadPipelineTs(uploadTs);
    const extracted = pipelineTs?.http_success ?? null;
    expect(extracted).toBe(uploadTs);

    const result = computeOverallHealth([], nowTick, null, extracted);
    expect(result.level).toBe('ok');
  });

  it('pipelineTs?.http_success ?? null evaluates to null when pipelineTs is null (pre-reload state)', () => {
    // Before reload() completes, pipelineTs state is null.
    // Cast to PipelineTimestamps | null to prevent TypeScript's control-flow
    // analysis from narrowing the const to the literal null type — which would
    // make pipelineTs?.http_success type to 'never'.  This mirrors how React
    // useState works at runtime (the type is always PipelineTimestamps | null).
    const pipelineTs = null as PipelineTimestamps | null;

    const extracted = pipelineTs?.http_success ?? null;
    expect(extracted).toBeNull();

    const result = computeOverallHealth([], T_INSTALL, null, extracted);
    expect(result.level).toBe('starting');
  });

  it('pipelineTs?.http_success ?? null evaluates to null when http_success has never been written', () => {
    const pipelineTs: PipelineTimestamps = { ...firstUploadPipelineTs(T_INSTALL), http_success: null };

    const extracted = pipelineTs?.http_success ?? null;
    expect(extracted).toBeNull();

    const result = computeOverallHealth([], T_INSTALL, null, extracted);
    expect(result.level).toBe('starting');
  });
});
