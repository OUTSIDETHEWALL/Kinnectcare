/**
 * healthCheck.test.ts
 *
 * Verifies that computeHealthItems + worstHealthStatus correctly
 * transition from healthy → warn → error as the engine log ages,
 * and that injecting a new event (power-save) into the log while
 * the Me tab is "open" causes the indicator to update on the next
 * poll cycle.
 *
 * These are pure unit tests: no React Native modules are needed
 * because healthCheck.ts only consumes the EngineLogEvent *type*
 * from locationEngine (erased at runtime).
 */

import { computeHealthItems, worstHealthStatus, computeOverallHealth, HealthItem } from '../healthCheck';
import type { EngineLogEvent } from '../locationEngine';

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

function healthyLog(now: number): EngineLogEvent[] {
  return [
    makeEvent('sdk_onEnabledChange', now - 1_000, { enabled: true }),
    makeEvent('sdk_onHeartbeat',     now - 30_000),
    makeEvent('sdk_onHttp',          now - 90_000, { success: true }),  // 1.5 min ago → ok
    makeEvent('battery_listeners_attached', now - 500),
    makeEvent('sdk_onPowerSaveChange', now - 1_000, { isPowerSaveMode: false }),
  ];
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('computeHealthItems / worstHealthStatus — polling transitions', () => {
  beforeEach(() => { seq = 0; });

  // ── 1. Baseline: fresh, healthy log ──────────────────────────────────────

  it('returns ok/unknown items and hidden indicator for a healthy log', () => {
    const now = 1_000_000;
    const log  = healthyLog(now);
    const items = computeHealthItems(log, now);

    expect(items.length).toBeGreaterThan(0);

    // worstHealthStatus returns 'ok' or 'unknown' — the indicator is hidden
    const worst = worstHealthStatus(items);
    expect(['ok', 'unknown']).toContain(worst);

    // Background service must be ok
    const bgItem = items.find((i) => i.label.includes('Background service running'));
    expect(bgItem).toBeDefined();
    expect(bgItem!.status).toBe('ok');

    // Upload item is ok (1.5 min < 5 min threshold)
    const uploadItem = items.find((i) => i.label.includes('Last location uploaded'));
    expect(uploadItem).toBeDefined();
    expect(uploadItem!.status).toBe('ok');
  });

  // ── 2. 60-second poll: upload age crosses the warn threshold ─────────────

  it('transitions upload status from ok to warn after ~6 minutes', () => {
    const t0 = 1_000_000;
    const log = healthyLog(t0);

    // The last upload was at t0 − 90 s.
    // Simulating ~6 min later (360 s after t0):
    //   upload age = 360 + 90 = 450 s ≈ 7.5 min → between 5 and 15 min → warn
    const tPoll1 = t0 + 6 * 60_000;  // 6 min later (first poll after tab focus)

    const itemsBefore = computeHealthItems(log, t0);
    const itemsAfter  = computeHealthItems(log, tPoll1);

    const uploadBefore = itemsBefore.find((i) => i.label.includes('Last location uploaded'))!;
    const uploadAfter  = itemsAfter.find((i) => i.label.includes('Last location uploaded'))!;

    expect(uploadBefore.status).toBe('ok');   // 1.5 min → ok
    expect(uploadAfter.status).toBe('warn');  // 7.5 min → warn

    // Indicator should now be visible (worst becomes warn)
    expect(worstHealthStatus(itemsAfter)).toBe('warn');
  });

  // ── 3. Second poll: upload age crosses the error threshold ───────────────

  it('transitions upload status from warn to error after ~16 minutes', () => {
    const t0  = 1_000_000;
    const log = healthyLog(t0);

    // Upload was at t0 − 90 s.  16 min later: age = 16*60 + 90 = 1050 s ≈ 17.5 min → error
    const tPoll2 = t0 + 16 * 60_000;

    const items = computeHealthItems(log, tPoll2);
    const uploadItem = items.find((i) => i.label.includes('Last location uploaded'))!;

    expect(uploadItem.status).toBe('error');
    expect(worstHealthStatus(items)).toBe('error');
  });

  // ── 4. Engine disabled event mid-session ─────────────────────────────────
  //
  // Simulates the engine stopping (sdk_onEnabledChange enabled=false) while
  // the Me tab is open.  On the next 60-second poll the indicator must
  // switch from hidden to error.

  it('shows error after sdk_onEnabledChange(enabled=false) is appended mid-session', () => {
    const t0  = 1_000_000;
    // Start with an empty log (fresh launch — nothing logged yet)
    const log: EngineLogEvent[] = [];

    // First poll: no events → all unknown, indicator hidden
    const itemsFirst = computeHealthItems(log, t0);
    expect(worstHealthStatus(itemsFirst)).toBe('unknown');

    // Engine explicitly stops mid-session
    log.push(makeEvent('sdk_onEnabledChange', t0 + 5_000, { enabled: false }));

    // Second poll (60 s later)
    const tPoll = t0 + 60_000;
    const itemsSecond = computeHealthItems(log, tPoll);

    const bgItem = itemsSecond.find((i) => i.status === 'error' && i.label.includes('Background service stopped'));
    expect(bgItem).toBeDefined();
    expect(worstHealthStatus(itemsSecond)).toBe('error');
  });

  // ── 5. Power-save event injected mid-session ──────────────────────────────
  //
  // The Me tab is open.  The log initially has no power-save entry.
  // Between polls the user's phone enters power-save mode.
  // On the next 60-second poll the indicator must turn warn.

  it('transitions to warn when a power-save event is appended between polls', () => {
    const t0  = 1_000_000;

    // Initial log: healthy, but no power-save event yet
    const log: EngineLogEvent[] = [
      makeEvent('sdk_onEnabledChange', t0 - 1_000, { enabled: true }),
      makeEvent('sdk_onHeartbeat',     t0 - 30_000),
      makeEvent('sdk_onHttp',          t0 - 60_000, { success: true }),  // 1 min ago → ok
    ];

    // First poll (on tab focus): power-save unknown, upload ok → indicator hidden
    const itemsBefore = computeHealthItems(log, t0);
    const powerBefore = itemsBefore.find((i) => i.label.includes('Power Saver'))!;
    expect(powerBefore.status).toBe('unknown');
    expect(['ok', 'unknown']).toContain(worstHealthStatus(itemsBefore));

    // Between polls: phone enters power-save mode
    log.push(makeEvent('sdk_onPowerSaveChange', t0 + 30_000, { isPowerSaveMode: true }));

    // Next poll (60 s after focus)
    const tPoll = t0 + 60_000;
    const itemsAfter = computeHealthItems(log, tPoll);
    const powerAfter = itemsAfter.find((i) => i.label.includes('Power Saver'))!;

    expect(powerAfter.status).toBe('warn');
    // Upload is now 2 min old → still ok; the worst is warn from power-saver
    expect(worstHealthStatus(itemsAfter)).toBe('warn');
  });

  // ── 6. worstHealthStatus ranking is correct ───────────────────────────────

  it('worstHealthStatus returns error > warn > unknown > ok', () => {
    const ok:      HealthItem = { icon: '✅', label: 'ok',      status: 'ok'      };
    const warn:    HealthItem = { icon: '⚠️', label: 'warn',    status: 'warn'    };
    const error:   HealthItem = { icon: '❌', label: 'error',   status: 'error'   };
    const unknown: HealthItem = { icon: 'ℹ️', label: 'unknown', status: 'unknown' };

    expect(worstHealthStatus([ok, warn, error, unknown])).toBe('error');
    expect(worstHealthStatus([ok, warn, unknown]))        .toBe('warn');
    expect(worstHealthStatus([ok, unknown]))              .toBe('unknown');
    expect(worstHealthStatus([ok]))                       .toBe('ok');
    expect(worstHealthStatus([]))                         .toBe('ok');
  });
});

// ─── computeOverallHealth — Diagnostics hero card verdict ────────────────────

describe('computeOverallHealth — hero card upload-stop scenarios', () => {
  beforeEach(() => { seq = 0; });

  const NOW = 2_000_000;

  // ── 1. Recent JS-log upload → ok ─────────────────────────────────────────

  it('returns ok when JS-log upload is < 5 min old', () => {
    const log = [
      makeEvent('sdk_onHttp', NOW - 2 * 60_000, { success: true }), // 2 min ago
    ];
    const result = computeOverallHealth(log, NOW);
    expect(result.level).toBe('ok');
    expect(result.uploadAgeMs).toBeCloseTo(2 * 60_000, -2);
    expect(result.headline).toMatch(/healthy/i);
  });

  // ── 2. Recent lastSeenMs → ok (even when log upload is absent) ────────────

  it('returns ok when lastSeenMs is < 5 min old and JS log has no upload', () => {
    const log: EngineLogEvent[] = [];
    const lastSeenMs = NOW - 3 * 60_000; // 3 min ago
    const result = computeOverallHealth(log, NOW, lastSeenMs);
    expect(result.level).toBe('ok');
    expect(result.uploadAgeMs).toBeCloseTo(3 * 60_000, -2);
  });

  // ── 3. Recent lastSeenMs beats a stale JS-log upload → ok ────────────────
  //
  // The JS log has an upload that is 20 min old (error territory), but
  // member.last_seen shows a recent backend delivery 2 min ago.
  // The function should pick the fresher signal and return ok.

  it('lastSeenMs takes precedence over a stale JS-log upload age', () => {
    const log = [
      makeEvent('sdk_onHttp', NOW - 20 * 60_000, { success: true }), // 20 min → error alone
    ];
    const lastSeenMs = NOW - 2 * 60_000; // 2 min → ok
    const result = computeOverallHealth(log, NOW, lastSeenMs);
    expect(result.level).toBe('ok');
    // uploadAgeMs should reflect the fresher source
    expect(result.uploadAgeMs).toBeCloseTo(2 * 60_000, -2);
  });

  // ── 4. Upload 5–15 min old → warn ────────────────────────────────────────

  it('returns warn when upload is between 5 and 15 min old', () => {
    const log = [
      makeEvent('sdk_onHttp', NOW - 10 * 60_000, { success: true }), // 10 min ago
    ];
    const result = computeOverallHealth(log, NOW);
    expect(result.level).toBe('warn');
    expect(result.headline).toMatch(/delayed/i);
  });

  it('returns warn when lastSeenMs is between 5 and 15 min old (no JS log upload)', () => {
    const log: EngineLogEvent[] = [];
    const lastSeenMs = NOW - 8 * 60_000; // 8 min ago
    const result = computeOverallHealth(log, NOW, lastSeenMs);
    expect(result.level).toBe('warn');
  });

  // ── 5. Upload > 15 min old → error ───────────────────────────────────────

  it('returns error when JS-log upload is > 15 min old', () => {
    const log = [
      makeEvent('sdk_onHttp', NOW - 20 * 60_000, { success: true }), // 20 min ago
    ];
    const result = computeOverallHealth(log, NOW);
    expect(result.level).toBe('error');
    expect(result.headline).toMatch(/stopped/i);
  });

  it('returns error when lastSeenMs is > 15 min old and no JS log upload', () => {
    const log: EngineLogEvent[] = [];
    const lastSeenMs = NOW - 20 * 60_000; // 20 min ago
    const result = computeOverallHealth(log, NOW, lastSeenMs);
    expect(result.level).toBe('error');
  });

  // ── 6. Engine explicitly disabled (no upload) → error ────────────────────

  it('returns error when engine is explicitly disabled and there is no upload', () => {
    const log = [
      makeEvent('sdk_onEnabledChange', NOW - 5_000, { enabled: false }),
    ];
    const result = computeOverallHealth(log, NOW);
    expect(result.level).toBe('error');
    expect(result.uploadAgeMs).toBeNull();
    expect(result.headline).toMatch(/stopped/i);
  });

  // ── 7. Heartbeat present, no upload → warn (not starting) ────────────────
  //
  // A sdk_onHeartbeat or headless_task_invoked event proves the engine is
  // alive.  Returning 'starting' here would be misleading — it should be
  // 'warn' (engine alive, upload not yet confirmed).

  it('returns warn (not starting) when a sdk_onHeartbeat is present but no upload', () => {
    const log = [
      makeEvent('sdk_onHeartbeat', NOW - 45_000), // 45 s ago
    ];
    const result = computeOverallHealth(log, NOW);
    expect(result.level).toBe('warn');
    expect(result.uploadAgeMs).toBeNull();
    expect(result.headline).toMatch(/running/i);
  });

  it('returns warn (not starting) when a headless_task_invoked is present but no upload', () => {
    const log = [
      makeEvent('headless_task_invoked', NOW - 30_000),
    ];
    const result = computeOverallHealth(log, NOW);
    expect(result.level).toBe('warn');
    expect(result.uploadAgeMs).toBeNull();
  });

  // ── 8. No upload, no heartbeat, no disable event → starting ──────────────

  it('returns starting when both upload and heartbeat evidence are absent', () => {
    const log: EngineLogEvent[] = [];
    const result = computeOverallHealth(log, NOW);
    expect(result.level).toBe('starting');
    expect(result.uploadAgeMs).toBeNull();
  });

  it('returns starting when log has unrelated events but no upload or heartbeat', () => {
    const log = [
      makeEvent('battery_listeners_attached', NOW - 1_000),
      makeEvent('sdk_onPowerSaveChange', NOW - 2_000, { isPowerSaveMode: false }),
    ];
    const result = computeOverallHealth(log, NOW);
    expect(result.level).toBe('starting');
  });

  // ── 9. lastSeenMs edge cases ──────────────────────────────────────────────

  it('ignores lastSeenMs of 0 (sentinel / unset)', () => {
    const log: EngineLogEvent[] = [];
    const result = computeOverallHealth(log, NOW, 0);
    expect(result.level).toBe('starting');
  });

  it('ignores lastSeenMs that is null', () => {
    const log: EngineLogEvent[] = [];
    const result = computeOverallHealth(log, NOW, null);
    expect(result.level).toBe('starting');
  });

  it('ignores lastSeenMs that is in the future (clock skew guard)', () => {
    const log: EngineLogEvent[] = [];
    const result = computeOverallHealth(log, NOW, NOW + 60_000); // 1 min in the future
    expect(result.level).toBe('starting');
  });

  // ── 10. Both signals present: picks the fresher of the two ───────────────

  it('uses Math.min of logUploadAge and lastSeenAge when both are present', () => {
    // JS log: 12 min old (warn territory)
    // lastSeenMs: 2 min old (ok territory)
    // Result should be ok because lastSeenMs is fresher
    const log = [
      makeEvent('sdk_onHttp', NOW - 12 * 60_000, { success: true }),
    ];
    const lastSeenMs = NOW - 2 * 60_000;
    const result = computeOverallHealth(log, NOW, lastSeenMs);
    expect(result.level).toBe('ok');
    expect(result.uploadAgeMs).toBeCloseTo(2 * 60_000, -2);
  });

  it('uses Math.min when JS log is fresher than lastSeenMs', () => {
    // JS log: 2 min old (ok territory)
    // lastSeenMs: 12 min old (warn territory)
    // Result should be ok because JS log is fresher
    const log = [
      makeEvent('sdk_onHttp', NOW - 2 * 60_000, { success: true }),
    ];
    const lastSeenMs = NOW - 12 * 60_000;
    const result = computeOverallHealth(log, NOW, lastSeenMs);
    expect(result.level).toBe('ok');
    expect(result.uploadAgeMs).toBeCloseTo(2 * 60_000, -2);
  });
});
