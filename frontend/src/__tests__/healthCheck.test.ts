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

// ─── Log-clear mid-session: indicator hides then re-surfaces ─────────────────
//
// Reproduces the scenario described in Task #23:
//   1. The Me tab has a healthy log from a previous session.
//   2. The user taps "Clear log" on Diagnostics → clearEngineLog() resets the
//      in-memory buffer so getEngineLog() returns [].
//   3. The next Me-tab poll calls computeHealthItems([], now).
//      Every item must be 'unknown' and worstHealthStatus must return
//      'unknown' so the indicator is hidden (not stuck on the last error).
//   4. On the poll after that, a new sdk_onEnabledChange or sdk_onHttp event
//      has arrived.  The indicator must re-surface with the correct status.

describe('log-clear mid-session — indicator hides then re-surfaces', () => {
  beforeEach(() => { seq = 0; });

  // ── A. Immediate clear: computeHealthItems([], now) → all unknown ─────────

  it('computeHealthItems([]) returns all-unknown items', () => {
    const now = 3_000_000;
    const items = computeHealthItems([], now);

    expect(items.length).toBeGreaterThan(0);
    items.forEach((item) => {
      expect(item.status).toBe('unknown');
    });
  });

  it('worstHealthStatus is "unknown" for an empty log (indicator hidden)', () => {
    const now = 3_000_000;
    const items = computeHealthItems([], now);
    expect(worstHealthStatus(items)).toBe('unknown');
  });

  // ── B. Full mid-session sequence: healthy → cleared → new event ───────────

  it('hides indicator after clear even when the previous log was error-level', () => {
    const t0 = 3_000_000;

    // Build a log that has a confirmed error (engine disabled + old upload)
    const errorLog: EngineLogEvent[] = [
      makeEvent('sdk_onEnabledChange', t0 - 2_000, { enabled: false }),
      makeEvent('sdk_onHttp',          t0 - 20 * 60_000, { success: true }), // 20 min → error
    ];

    // Before clear: indicator is at error level
    const itemsBefore = computeHealthItems(errorLog, t0);
    expect(worstHealthStatus(itemsBefore)).toBe('error');

    // User taps "Clear log" — buffer resets to []
    const clearedLog: EngineLogEvent[] = [];

    // Next poll: all unknown, indicator hidden
    const itemsAfterClear = computeHealthItems(clearedLog, t0 + 60_000);
    expect(worstHealthStatus(itemsAfterClear)).toBe('unknown');
    itemsAfterClear.forEach((item) => {
      expect(item.status).toBe('unknown');
    });
  });

  it('re-surfaces indicator (error) on the next poll once sdk_onEnabledChange(false) arrives', () => {
    const t0 = 3_000_000;

    // Log has been cleared
    const log: EngineLogEvent[] = [];

    // Poll 1 (immediately after clear): all unknown, indicator hidden
    const poll1 = computeHealthItems(log, t0);
    expect(worstHealthStatus(poll1)).toBe('unknown');

    // New event arrives: engine disabled
    log.push(makeEvent('sdk_onEnabledChange', t0 + 30_000, { enabled: false }));

    // Poll 2 (60 s after clear): indicator must re-surface as error
    const poll2 = computeHealthItems(log, t0 + 60_000);
    const bgItem = poll2.find((i) => i.label.includes('Background service stopped'));
    expect(bgItem).toBeDefined();
    expect(bgItem!.status).toBe('error');
    expect(worstHealthStatus(poll2)).toBe('error');
  });

  it('re-surfaces indicator (ok) on the next poll once a fresh upload event arrives', () => {
    const t0 = 3_000_000;

    // Log has been cleared
    const log: EngineLogEvent[] = [];

    // Poll 1: all unknown, indicator hidden
    const poll1 = computeHealthItems(log, t0);
    expect(worstHealthStatus(poll1)).toBe('unknown');

    // New events arrive after the clear: engine enabled + recent upload
    log.push(makeEvent('sdk_onEnabledChange',    t0 + 10_000, { enabled: true }));
    log.push(makeEvent('battery_listeners_attached', t0 + 10_000));
    log.push(makeEvent('sdk_onHttp',             t0 + 50_000, { success: true })); // 10 s before next poll

    // Poll 2 (60 s after clear): upload is 10 s old → ok; no warn/error items
    const poll2 = computeHealthItems(log, t0 + 60_000);

    const uploadItem = poll2.find((i) => i.label.includes('Last location uploaded'));
    expect(uploadItem).toBeDefined();
    expect(uploadItem!.status).toBe('ok');

    // Indicator is hidden (worst is 'ok' or 'unknown', never 'warn'/'error')
    const worst = worstHealthStatus(poll2);
    expect(['ok', 'unknown']).toContain(worst);
  });

  // ── C. HealthIndicator render contract: hidden for 'unknown', shown for error/warn

  it('indicator is hidden (unknown) → shown (error) within one poll cycle', () => {
    const t0 = 3_000_000;
    const log: EngineLogEvent[] = [];

    // Poll 1: cleared log → worst unknown → indicator HIDDEN
    const items1 = computeHealthItems(log, t0);
    const worst1 = worstHealthStatus(items1);
    // HealthIndicator returns null when worst is 'ok' or 'unknown'
    expect(worst1 === 'ok' || worst1 === 'unknown').toBe(true);

    // Engine stops mid-session
    log.push(makeEvent('sdk_onEnabledChange', t0 + 5_000, { enabled: false }));

    // Poll 2 (60 s later): worst is 'error' → indicator SHOWN
    const items2 = computeHealthItems(log, t0 + 60_000);
    expect(worstHealthStatus(items2)).toBe('error');
  });
});

// ─── computeHealthItems — lastHttpSuccessMs persistent timestamp ──────────────
//
// Verifies that the optional third parameter keeps the upload row green even
// when the ring buffer has been flooded with failure entries and the last
// successful sdk_onHttp was evicted.

describe('computeHealthItems — lastHttpSuccessMs fills the eviction gap', () => {
  beforeEach(() => { seq = 0; });

  // ── A. Ring buffer full of failures, persistent key has a recent success ──

  it('shows ok upload status from lastHttpSuccessMs when ring buffer has only failures', () => {
    const now = 5_000_000;
    // Ring buffer has three recent failure entries but zero successes.
    const log: EngineLogEvent[] = [
      makeEvent('sdk_onHttp', now - 2 * 60_000, { success: false }),
      makeEvent('sdk_onHttp', now - 90_000,     { success: false }),
      makeEvent('sdk_onHttp', now - 30_000,     { success: false }),
    ];
    // Persistent key records a success 2 min ago.
    const lastHttpSuccessMs = now - 2 * 60_000;
    const items = computeHealthItems(log, now, lastHttpSuccessMs);

    const uploadItem = items.find((i) => i.label.includes('Last location uploaded'))!;
    expect(uploadItem).toBeDefined();
    // 2 min < 5 min threshold → ok
    expect(uploadItem.status).toBe('ok');
  });

  it('shows warn from lastHttpSuccessMs when ring buffer has only failures and key is 8 min old', () => {
    const now = 5_000_000;
    const log: EngineLogEvent[] = [
      makeEvent('sdk_onHttp', now - 30_000, { success: false }),
    ];
    const lastHttpSuccessMs = now - 8 * 60_000; // 8 min → warn
    const items = computeHealthItems(log, now, lastHttpSuccessMs);

    const uploadItem = items.find((i) => i.label.includes('Last location uploaded'))!;
    expect(uploadItem).toBeDefined();
    expect(uploadItem.status).toBe('warn');
  });

  // ── B. Both sources present — picks the more recent one ───────────────────

  it('uses the ring-buffer success when it is more recent than lastHttpSuccessMs', () => {
    const now = 5_000_000;
    // Ring buffer: success 1 min ago
    const log: EngineLogEvent[] = [
      makeEvent('sdk_onHttp', now - 60_000, { success: true }),
    ];
    // Persistent key: success 10 min ago (staler)
    const lastHttpSuccessMs = now - 10 * 60_000;
    const items = computeHealthItems(log, now, lastHttpSuccessMs);

    const uploadItem = items.find((i) => i.label.includes('Last location uploaded'))!;
    expect(uploadItem).toBeDefined();
    // Ring buffer wins: 1 min → ok
    expect(uploadItem.status).toBe('ok');
  });

  it('uses lastHttpSuccessMs when it is more recent than the ring-buffer success', () => {
    const now = 5_000_000;
    // Ring buffer: success 20 min ago (error territory alone)
    const log: EngineLogEvent[] = [
      makeEvent('sdk_onHttp', now - 20 * 60_000, { success: true }),
    ];
    // Persistent key: success 2 min ago (fresher)
    const lastHttpSuccessMs = now - 2 * 60_000;
    const items = computeHealthItems(log, now, lastHttpSuccessMs);

    const uploadItem = items.find((i) => i.label.includes('Last location uploaded'))!;
    expect(uploadItem).toBeDefined();
    // Persistent key wins: 2 min → ok
    expect(uploadItem.status).toBe('ok');
  });

  // ── C. Edge cases: null / future / absent ────────────────────────────────

  it('shows unknown when both ring buffer and lastHttpSuccessMs are absent', () => {
    const now = 5_000_000;
    const log: EngineLogEvent[] = [];
    const items = computeHealthItems(log, now, null);

    const uploadItem = items.find((i) => i.label.includes('waiting for first upload'))!;
    expect(uploadItem).toBeDefined();
    expect(uploadItem.status).toBe('unknown');
  });

  it('ignores lastHttpSuccessMs of 0 (sentinel / unset)', () => {
    const now = 5_000_000;
    const log: EngineLogEvent[] = [];
    const items = computeHealthItems(log, now, 0);

    const uploadItem = items.find((i) => i.label.includes('waiting for first upload'))!;
    expect(uploadItem).toBeDefined();
    expect(uploadItem.status).toBe('unknown');
  });

  it('ignores lastHttpSuccessMs that is in the future (clock skew guard)', () => {
    const now = 5_000_000;
    const log: EngineLogEvent[] = [];
    const items = computeHealthItems(log, now, now + 60_000);

    const uploadItem = items.find((i) => i.label.includes('waiting for first upload'))!;
    expect(uploadItem).toBeDefined();
    expect(uploadItem.status).toBe('unknown');
  });

  it('existing tests pass unchanged when lastHttpSuccessMs is omitted', () => {
    const now = 5_000_000;
    const log: EngineLogEvent[] = [
      makeEvent('sdk_onHttp', now - 2 * 60_000, { success: true }),
    ];
    // No third argument — backward-compatible
    const items = computeHealthItems(log, now);
    const uploadItem = items.find((i) => i.label.includes('Last location uploaded'))!;
    expect(uploadItem).toBeDefined();
    expect(uploadItem.status).toBe('ok');
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
