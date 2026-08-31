/**
 * deviceComparisonOffline.test.ts  — Task #94
 *
 * Confirms that the Device Comparison table's http_ok row turns amber within
 * 5 minutes when the test member's phone loses connectivity — not only when they recover.
 *
 * The key regression this test guards against:
 *   If `stored_at` (the server write time) were used instead of an advancing
 *   clock, or if `nowTick` were frozen, the displayed age would not grow in real
 *   time and Charles would see a permanently-green row even after 5+ minutes of
 *   silence.
 *
 * Under test:
 *   effectiveSnapshotAgeMs  — ages the row in real time as nowTick advances
 *   ageCellColor            — applies the correct green/amber/red threshold
 *   computeSnapshotElapsedMs — measures how long since the snapshot was pushed
 *
 * How the Device Comparison table works:
 *   1. Charles taps "Fetch Device Comparison" — the server returns each member's
 *      latest data, including `device_snapshot.http_ok_age_ms` (how old the last
 *      HTTP upload was AT THE MOMENT the snapshot was pushed to the server).
 *   2. The table calls `effectiveSnapshotAgeMs(ds.at, ds.stored_at, nowTick, ds.http_ok_age_ms)`.
 *      This adds the age-at-push to the time elapsed since the push, giving the
 *      CURRENT age of the last HTTP upload.
 *   3. A 1-second setInterval updates `nowTick` so the displayed age ticks in
 *      real time — no new network call needed.
 *   4. `ageCellColor` maps that age to green (<5 min), amber (5–15 min), or
 *      red (>15 min).
 *
 * Failure mode under test:
 *   The test member stops uploading.  Their `device_snapshot` is still from the last
 *   heartbeat (pushed N minutes ago with small `http_ok_age_ms`).  As nowTick
 *   advances, `effectiveSnapshotAgeMs` must grow and eventually cross 5 min,
 *   turning the cell amber — without waiting for a new server fetch.
 *
 * No React Native imports — runs in the plain Node test environment.
 */

import {
  effectiveSnapshotAgeMs,
  ageCellColor,
  computeSnapshotElapsedMs,
  httpOkCellColor,
} from '../deviceComparisonUtils';

// ─── Shared constants ─────────────────────────────────────────────────────────

const WARN_MS = 5  * 60_000;   // 300 000 ms — green → amber boundary
const CRIT_MS = 15 * 60_000;   // 900 000 ms — amber → red   boundary

// Fixed "wall clock" origin for all tests — completely arbitrary but deterministic.
const EPOCH = 1_720_000_000_000;

// ─── Scenario helpers ─────────────────────────────────────────────────────────

/**
 * Build a simulated device_snapshot as returned by the server.
 *
 * @param snapshotPushedMsAgo  How many ms ago the test member's device pushed this snapshot.
 * @param httpOkAgeAtPushMs    How old the last HTTP upload was AT push time.
 */
function makeSnapshot(snapshotPushedMsAgo: number, httpOkAgeAtPushMs: number) {
  const pushedAt = new Date(EPOCH - snapshotPushedMsAgo).toISOString();
  return {
    at:              pushedAt,
    stored_at:       pushedAt, // same for these tests; stored_at is the fallback
    http_ok_age_ms:  httpOkAgeAtPushMs,
  };
}

// ─── Suite 1: http_ok row turns amber as nowTick advances (core Task #94) ────

describe('Device Comparison — http_ok row turns amber when a test member goes offline', () => {

  // ── 1a. Snapshot is fresh → http_ok row is green ───────────────────────────
  it('shows green when the snapshot was just pushed and http_ok was healthy at push', () => {
    // Snapshot pushed 10 s ago; the test member uploaded 5 s before that → http_ok_age_ms = 5 s.
    const ds = makeSnapshot(10_000, 5_000);
    const nowTick = EPOCH; // current wall clock

    const effectiveAge = effectiveSnapshotAgeMs(ds.at, ds.stored_at, nowTick, ds.http_ok_age_ms);

    // Effective age = 10 000 (elapsed since push) + 5 000 (age at push) = 15 000 ms
    expect(effectiveAge).toBe(15_000);
    expect(ageCellColor(effectiveAge, WARN_MS, CRIT_MS)).toBe('#10B981'); // green
  });

  // ── 1b. 4 minutes of silence → still green (not yet at threshold) ───────────
  it('stays green after 4 minutes of silence (below the 5-min warn threshold)', () => {
    // Snapshot was pushed right when the test member's last upload fired:
    //   snapshotPushedMsAgo = 4 min, httpOkAgeAtPushMs = 30 s
    //   effective age = 4 min + 30 s = 4 min 30 s < 5 min → green
    const ds = makeSnapshot(4 * 60_000, 30_000);
    const nowTick = EPOCH;

    const effectiveAge = effectiveSnapshotAgeMs(ds.at, ds.stored_at, nowTick, ds.http_ok_age_ms);

    expect(effectiveAge).toBe(4 * 60_000 + 30_000); // 270 000 ms
    expect(ageCellColor(effectiveAge, WARN_MS, CRIT_MS)).toBe('#10B981'); // green
    expect(effectiveAge).toBeLessThan(WARN_MS);
  });

  // ── 1c. Exactly 5 minutes of total silence → first amber millisecond ─────────
  it('turns amber at exactly the 5-minute warn boundary', () => {
    // Snapshot pushed 4 min 30 s ago; http_ok was 30 s old at push.
    // Effective age = 4 min 30 s + 30 s = 5 min exactly = WARN_MS.
    const ds = makeSnapshot(4 * 60_000 + 30_000, 30_000);
    const nowTick = EPOCH;

    const effectiveAge = effectiveSnapshotAgeMs(ds.at, ds.stored_at, nowTick, ds.http_ok_age_ms);

    expect(effectiveAge).toBe(WARN_MS); // 300 000 ms
    expect(ageCellColor(effectiveAge, WARN_MS, CRIT_MS)).toBe('#F59E0B'); // amber
  });

  // ── 1d. 8 minutes of total silence → amber (the primary Task #94 assertion) ─
  it('shows amber after 8 minutes of no HTTP upload (between warn and crit)', () => {
    // Snapshot pushed 7 min ago; http_ok was 1 min old at push → total 8 min.
    const ds = makeSnapshot(7 * 60_000, 60_000);
    const nowTick = EPOCH;

    const effectiveAge = effectiveSnapshotAgeMs(ds.at, ds.stored_at, nowTick, ds.http_ok_age_ms);

    expect(effectiveAge).toBe(8 * 60_000); // 480 000 ms
    expect(ageCellColor(effectiveAge, WARN_MS, CRIT_MS)).toBe('#F59E0B'); // amber
    expect(effectiveAge).toBeGreaterThanOrEqual(WARN_MS);
    expect(effectiveAge).toBeLessThan(CRIT_MS);
  });

  // ── 1e. nowTick advancing drives the amber transition without a new fetch ────
  //
  // This is the key property: `effectiveSnapshotAgeMs` re-evaluates every second
  // as `nowTick` increments, so the cell ticks from green → amber automatically
  // without Charles having to tap "Fetch Device Comparison" again.
  it('transitions from green to amber as nowTick advances — no new fetch needed', () => {
    // Snapshot pushed at EPOCH - 4 min 29 s; http_ok was 30 s old at push.
    // At nowTick = EPOCH: effective age = 4 min 59 s → still green (1 ms below WARN_MS).
    const SNAPSHOT_PUSHED_AGO = 4 * 60_000 + 29_000; // 269 000 ms
    const HTTP_OK_AGE_AT_PUSH  = 30_000;              // 30 s

    const ds = makeSnapshot(SNAPSHOT_PUSHED_AGO, HTTP_OK_AGE_AT_PUSH);

    // ── T = 0: still green ────────────────────────────────────────────────────
    const effectiveAgeAtT0 = effectiveSnapshotAgeMs(ds.at, ds.stored_at, EPOCH, ds.http_ok_age_ms);
    expect(effectiveAgeAtT0).toBe(SNAPSHOT_PUSHED_AGO + HTTP_OK_AGE_AT_PUSH); // 299 000
    expect(ageCellColor(effectiveAgeAtT0, WARN_MS, CRIT_MS)).toBe('#10B981'); // green
    expect(effectiveAgeAtT0).toBeLessThan(WARN_MS);

    // ── T + 1 s: nowTick advances one second (one ticker tick) ───────────────
    const nowTick1s = EPOCH + 1_000;
    const effectiveAgeAt1s = effectiveSnapshotAgeMs(ds.at, ds.stored_at, nowTick1s, ds.http_ok_age_ms);
    expect(effectiveAgeAt1s).toBe(SNAPSHOT_PUSHED_AGO + HTTP_OK_AGE_AT_PUSH + 1_000); // 300 000
    expect(ageCellColor(effectiveAgeAt1s, WARN_MS, CRIT_MS)).toBe('#F59E0B'); // amber ← transition

    // ── T + 60 s: still amber, not red ────────────────────────────────────────
    const nowTick60s = EPOCH + 60_000;
    const effectiveAgeAt60s = effectiveSnapshotAgeMs(ds.at, ds.stored_at, nowTick60s, ds.http_ok_age_ms);
    expect(ageCellColor(effectiveAgeAt60s, WARN_MS, CRIT_MS)).toBe('#F59E0B'); // amber
    expect(effectiveAgeAt60s).toBeLessThan(CRIT_MS);
  });

  // ── 1f. Worst-case: snapshot age alone (no http_ok_age_ms) — row shows "—" ──
  it('shows no age (null) when device_snapshot is absent — table renders "—"', () => {
    // When the test member has never pushed a device_snapshot, both snapshotAt values are absent.
    const result = effectiveSnapshotAgeMs(undefined, undefined, EPOCH, 30_000);
    expect(result).toBeNull();
  });

  it('shows no age (null) when http_ok_age_ms is absent — stage not yet recorded', () => {
    // Snapshot exists but this pipeline stage has no recorded timestamp yet.
    const ds = makeSnapshot(60_000, undefined as unknown as number);
    const result = effectiveSnapshotAgeMs(ds.at, ds.stored_at, EPOCH, undefined);
    expect(result).toBeNull();
  });
});

// ─── Suite 2: nowTick is the real-time clock, not the server fetch time ───────
//
// The snapshot's `stored_at` field is the moment the server wrote the row —
// it is NOT the wall clock against which ages are measured.  If the component
// mistakenly used `stored_at` as `nowMs` instead of the `nowTick` state value,
// the elapsed time would be 0 and all ages would appear identical to the
// age-at-push values, never growing.
//
// These tests confirm that `computeSnapshotElapsedMs` returns `nowMs - pushed_at`,
// i.e. the live clock dominates.

describe('computeSnapshotElapsedMs uses the live clock (nowTick), not stored_at', () => {

  it('returns nowMs - snapshotAt regardless of stored_at value', () => {
    // Snapshot pushed at EPOCH - 6 min; stored_at coincidentally equals pushed_at.
    const pushedAt = new Date(EPOCH - 6 * 60_000).toISOString();
    const storedAt = pushedAt; // same timestamp

    // nowMs is the current wall clock (6 min after push).
    const elapsed = computeSnapshotElapsedMs(pushedAt, storedAt, EPOCH);
    expect(elapsed).toBe(6 * 60_000); // 360 000 ms
  });

  it('grows as nowMs (nowTick) advances — elapsed is dynamic, not frozen at fetch time', () => {
    const pushedAt = new Date(EPOCH - 4 * 60_000).toISOString();

    const elapsedAtFetch    = computeSnapshotElapsedMs(pushedAt, undefined, EPOCH);           // 4 min
    const elapsedOneTick    = computeSnapshotElapsedMs(pushedAt, undefined, EPOCH + 1_000);  // 4 min 1 s
    const elapsedFiveMinute = computeSnapshotElapsedMs(pushedAt, undefined, EPOCH + 60_000); // 5 min

    expect(elapsedAtFetch).toBe(4 * 60_000);
    expect(elapsedOneTick).toBe(4 * 60_000 + 1_000);
    expect(elapsedFiveMinute).toBe(5 * 60_000);

    // Confirm the growth is strictly monotonically increasing.
    expect(elapsedOneTick).toBeGreaterThan(elapsedAtFetch!);
    expect(elapsedFiveMinute).toBeGreaterThan(elapsedOneTick!);
  });
});

// ─── Suite 3: httpOkCellColor — the extracted presentation model ──────────────
//
// `httpOkCellColor(member, nowMs)` is the function `app/diagnostics.tsx` calls
// directly as `httpOkCellColor(m, nowTick)` inside the "HTTP success (device)"
// row render.  `nowTick` is the 1-second state clock.
//
// Testing this function with an advancing `nowMs` proves two things:
//   1. The colour-transition logic is correct (green → amber at 5 min).
//   2. The dependency on `nowMs` is real: passing a frozen timestamp always
//      returns the same colour regardless of elapsed time, so any regression
//      that passes a static value instead of `nowTick` would surface the same
//      way the full component test would — the colour stops changing.

describe('httpOkCellColor — the function diagnostics.tsx calls with nowTick', () => {

  // ── Helper: build a member object as returned by the family-snapshot API ───
  function makeMember(snapshotPushedMsAgo: number, httpOkAgeAtPushMs: number) {
    const pushedAt = new Date(EPOCH - snapshotPushedMsAgo).toISOString();
    return {
      device_snapshot: {
        at:             pushedAt,
        stored_at:      pushedAt,
        http_ok_age_ms: httpOkAgeAtPushMs,
      },
    };
  }

  // ── 3a. Snapshot just pushed with a healthy http_ok → green ────────────────
  it('returns green when the snapshot is fresh and http_ok was healthy at push', () => {
    const member = makeMember(10_000, 5_000); // snapshot 10s ago, upload 5s before that
    expect(httpOkCellColor(member, EPOCH)).toBe('#10B981');
  });

  // ── 3b. No device_snapshot → grey ("—" renders, not a false green) ─────────
  it('returns grey when device_snapshot is absent — renders "—" in the table', () => {
    expect(httpOkCellColor({}, EPOCH)).toBe('#9CA3AF');
    expect(httpOkCellColor(null, EPOCH)).toBe('#9CA3AF');
    expect(httpOkCellColor(undefined, EPOCH)).toBe('#9CA3AF');
  });

  // ── 3c. No http_ok_age_ms → grey ────────────────────────────────────────────
  it('returns grey when http_ok_age_ms is absent — stage not yet recorded', () => {
    const pushedAt = new Date(EPOCH - 60_000).toISOString();
    const member = { device_snapshot: { at: pushedAt, stored_at: pushedAt } }; // no http_ok_age_ms
    expect(httpOkCellColor(member, EPOCH)).toBe('#9CA3AF');
  });

  // ── 3d. Green → amber transition driven purely by nowMs (= nowTick) ─────────
  //
  // This is the core regression guard.  The snapshot is fixed — no new fetch.
  // As nowMs advances (mirroring the component's 1-second setInterval tick),
  // the effective age grows and the colour transitions from green to amber.
  //
  // A regression where the component passes a static timestamp instead of
  // `nowTick` would make this function return the same colour for all nowMs
  // values — identical to calling httpOkCellColor(member, EPOCH) repeatedly.
  it('transitions from green to amber as nowMs advances — without a new fetch', () => {
    // Snapshot pushed 4 min 29 s ago with http_ok 30 s old at push.
    // Effective age = 4m29s + 30s = 4m59s = 299 000 ms → still green.
    const SNAPSHOT_AGO = 4 * 60_000 + 29_000;
    const HTTP_OK_AT_PUSH = 30_000;
    const member = makeMember(SNAPSHOT_AGO, HTTP_OK_AT_PUSH);

    // T+0 ms: effective age = 299 000 ms < 300 000 ms (WARN_MS) → green
    expect(httpOkCellColor(member, EPOCH)).toBe('#10B981');

    // T+1 000 ms (one ticker tick): effective age = 300 000 ms = WARN_MS → amber
    expect(httpOkCellColor(member, EPOCH + 1_000)).toBe('#F59E0B');

    // T+60 000 ms (one minute later): effective age = 359 000 ms → still amber
    expect(httpOkCellColor(member, EPOCH + 60_000)).toBe('#F59E0B');
  });

  // ── 3e. 8 minutes of total silence → amber ──────────────────────────────────
  it('returns amber after 8 minutes of total silence (snapshot + stage combined)', () => {
    const member = makeMember(7 * 60_000, 60_000); // 7m elapsed + 1m at push = 8m total
    expect(httpOkCellColor(member, EPOCH)).toBe('#F59E0B');
  });

  // ── 3f. Frozen nowMs never changes colour — proves nowMs must advance ────────
  //
  // Explicitly demonstrates the regression: if the component called
  // httpOkCellColor(m, fetchedAt) instead of httpOkCellColor(m, nowTick),
  // the colour would be frozen at the fetch-time value regardless of how
  // much real time has passed.
  it('returns the same colour for all calls when nowMs is frozen — proving nowMs must advance', () => {
    // A snapshot that starts in the green zone at a frozen T.
    const member = makeMember(2 * 60_000, 30_000); // total 2m30s → green

    const frozenNowMs = EPOCH; // never increments
    expect(httpOkCellColor(member, frozenNowMs)).toBe('#10B981');
    expect(httpOkCellColor(member, frozenNowMs)).toBe('#10B981'); // still green — time is frozen
    expect(httpOkCellColor(member, frozenNowMs)).toBe('#10B981'); // never turns amber

    // Contrast: advancing nowMs crosses into amber after enough ticks.
    expect(httpOkCellColor(member, EPOCH + 3 * 60_000)).toBe('#F59E0B'); // 5m30s total → amber
  });
});

// ─── Suite 4: ageCellColor thresholds — regression guard ─────────────────────
//
// Pins the exact green / amber / red boundary values so a future change to the
// 5-min or 15-min thresholds in diagnostics.tsx surfaces immediately.

describe('ageCellColor — green/amber/red threshold regression guard', () => {
  it('green: WARN_MS - 1 ms (one ms below the boundary)', () => {
    expect(ageCellColor(WARN_MS - 1, WARN_MS, CRIT_MS)).toBe('#10B981');
  });

  it('amber: exactly WARN_MS (first ms that is NOT green)', () => {
    expect(ageCellColor(WARN_MS, WARN_MS, CRIT_MS)).toBe('#F59E0B');
  });

  it('amber: CRIT_MS - 1 ms (one ms below the red boundary)', () => {
    expect(ageCellColor(CRIT_MS - 1, WARN_MS, CRIT_MS)).toBe('#F59E0B');
  });

  it('red: exactly CRIT_MS (first ms that is NOT amber)', () => {
    expect(ageCellColor(CRIT_MS, WARN_MS, CRIT_MS)).toBe('#EF4444');
  });

  it('grey: null — no data yet (renders "—" in the table)', () => {
    expect(ageCellColor(null, WARN_MS, CRIT_MS)).toBe('#9CA3AF');
  });

  it('grey: undefined — no data yet', () => {
    expect(ageCellColor(undefined, WARN_MS, CRIT_MS)).toBe('#9CA3AF');
  });

  it('grey: NaN — non-finite value treated as no-data', () => {
    expect(ageCellColor(NaN, WARN_MS, CRIT_MS)).toBe('#9CA3AF');
  });

  // Confirm the defaults (called without explicit warn/crit) match the ageCell() helper
  // thresholds used in diagnostics.tsx: warn=5min, crit=15min.
  it('default thresholds match the ageCell() values used in diagnostics.tsx', () => {
    // default warn = 5 * 60_000
    expect(ageCellColor(5 * 60_000 - 1)).toBe('#10B981'); // still green
    expect(ageCellColor(5 * 60_000)).toBe('#F59E0B');     // amber at exactly 5 min
    // default crit = 15 * 60_000
    expect(ageCellColor(15 * 60_000 - 1)).toBe('#F59E0B'); // still amber
    expect(ageCellColor(15 * 60_000)).toBe('#EF4444');     // red at exactly 15 min
  });
});
