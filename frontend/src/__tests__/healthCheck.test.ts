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

import { computeHealthItems, worstHealthStatus, computeOverallHealth, formatAgeMs, HealthItem } from '../healthCheck';
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

  // ── 7. SDK heartbeat suppression during motion ────────────────────────────
  //
  // The Transistor SDK only fires heartbeat events when the device is
  // STATIONARY.  While the device is moving, locations upload via motion
  // events (sdk_onHttp fires) but sdk_onHeartbeat does NOT fire.
  //
  // Regression guard: a device that has been driving for >10 minutes will
  // have a stale heartbeat timestamp (hbAge > 10 min → previously 'error').
  // When uploads are recent (< 5 min), the stale heartbeat must NOT produce
  // a ❌ — it must show ✅ and explain "uploading via motion events".
  //
  // This reproduces the exact inconsistency Charles observed:
  //   ✅ Background monitoring is healthy
  //   ✅ Last location confirmed: 14 seconds ago
  //   ✅ Last location uploaded: 45 seconds ago
  //   ❌ Last background heartbeat: 1 hour ago   ← was false-negative

  it('heartbeat row shows ok (not error) when heartbeat is >10 min old but uploads are recent', () => {
    const now = 1_000_000;
    const log: EngineLogEvent[] = [
      makeEvent('sdk_onEnabledChange', now - 2_000,         { enabled: true }),
      makeEvent('sdk_onHeartbeat',     now - 65 * 60_000),  // 65 min ago — device was stationary then
      makeEvent('sdk_onHttp',          now - 45_000,        { success: true }), // 45 s ago — device is moving now
    ];

    const items = computeHealthItems(log, now);

    const hbItem = items.find((i) =>
      i.label.includes('heartbeat') || i.label.includes('Heartbeat'),
    )!;
    expect(hbItem).toBeDefined();
    // Must NOT be error — uploads prove the engine is alive and moving
    expect(hbItem.status).toBe('ok');
    // Label must lead with reassurance, not a technical timestamp
    expect(hbItem.label).toContain('Background tracking active');

    // The overall worst status must not be 'error' — this is a healthy device
    expect(worstHealthStatus(items)).not.toBe('error');
  });

  it('heartbeat row shows error when heartbeat AND uploads are both stale', () => {
    const now = 1_000_000;
    const log: EngineLogEvent[] = [
      makeEvent('sdk_onEnabledChange', now - 2_000,          { enabled: true }),
      makeEvent('sdk_onHeartbeat',     now - 65 * 60_000),   // 65 min ago
      makeEvent('sdk_onHttp',          now - 20 * 60_000,    { success: true }), // 20 min ago — genuinely stale
    ];

    const items = computeHealthItems(log, now);

    const hbItem = items.find((i) =>
      i.label.includes('heartbeat') || i.label.includes('Heartbeat'),
    )!;
    expect(hbItem).toBeDefined();
    // Both heartbeat and upload are stale — this IS a genuine failure
    expect(hbItem.status).toBe('error');
    // Label must NOT say "uploading via motion events" — uploads are not recent
    expect(hbItem.label).not.toContain('uploading via motion events');
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

// ─── computeOverallHealth — lastHttpSuccessMs persistent timestamp ────────────
//
// Mirrors the lastHttpSuccessMs tests for computeHealthItems (Task #41) but
// targets the hero card function.  The scenario: the ring buffer has been
// flooded with failure entries (evicting the last sdk_onHttp success), AND
// lastSeenMs is null (fresh device / first /members poll not yet returned).
// Without lastHttpSuccessMs the hero card falls back to warn or starting.
// With a recent lastHttpSuccessMs it must return ok.

describe('computeOverallHealth — lastHttpSuccessMs fills the eviction gap', () => {
  beforeEach(() => { seq = 0; });

  const NOW = 7_000_000;

  // Helper: build a ring buffer filled with N failure entries and no successes.
  function failureBuffer(count: number): EngineLogEvent[] {
    return Array.from({ length: count }, (_, i) =>
      makeEvent('sdk_onHttp', NOW - (count - i) * 10_000, { success: false }),
    );
  }

  // ── A. Ring buffer full of failures, persistent key has a recent success ───
  //
  // This is the exact eviction scenario for the hero card.  Without
  // lastHttpSuccessMs the function finds no upload evidence and falls back to
  // the heartbeat/starting path.  With a 2-min-old key it must return ok.

  it('returns ok when ring buffer has only failures but lastHttpSuccessMs is < 5 min old', () => {
    const log = failureBuffer(50);
    const result = computeOverallHealth(log, NOW, null, NOW - 2 * 60_000);
    expect(result.level).toBe('ok');
    expect(result.uploadAgeMs).toBeCloseTo(2 * 60_000, -2);
    expect(result.headline).toMatch(/healthy/i);
  });

  it('returns warn when ring buffer has only failures and lastHttpSuccessMs is 8 min old', () => {
    const log = failureBuffer(50);
    const result = computeOverallHealth(log, NOW, null, NOW - 8 * 60_000);
    expect(result.level).toBe('warn');
    expect(result.uploadAgeMs).toBeCloseTo(8 * 60_000, -2);
  });

  it('returns error when ring buffer has only failures and lastHttpSuccessMs is 20 min old', () => {
    const log = failureBuffer(10);
    const result = computeOverallHealth(log, NOW, null, NOW - 20 * 60_000);
    expect(result.level).toBe('error');
    expect(result.uploadAgeMs).toBeCloseTo(20 * 60_000, -2);
  });

  // ── B. All three sources present — picks the freshest ─────────────────────

  it('picks lastHttpSuccessMs when it is fresher than both ring buffer and lastSeenMs', () => {
    // Ring buffer: 20 min old (error alone)
    // lastSeenMs: 10 min old (warn alone)
    // lastHttpSuccessMs: 2 min old (ok) — should win
    const log = [makeEvent('sdk_onHttp', NOW - 20 * 60_000, { success: true })];
    const result = computeOverallHealth(log, NOW, NOW - 10 * 60_000, NOW - 2 * 60_000);
    expect(result.level).toBe('ok');
    expect(result.uploadAgeMs).toBeCloseTo(2 * 60_000, -2);
  });

  it('picks lastSeenMs when it is fresher than both ring buffer and lastHttpSuccessMs', () => {
    // Ring buffer: 20 min old (error alone)
    // lastSeenMs: 2 min old (ok) — should win
    // lastHttpSuccessMs: 10 min old (warn alone)
    const log = [makeEvent('sdk_onHttp', NOW - 20 * 60_000, { success: true })];
    const result = computeOverallHealth(log, NOW, NOW - 2 * 60_000, NOW - 10 * 60_000);
    expect(result.level).toBe('ok');
    expect(result.uploadAgeMs).toBeCloseTo(2 * 60_000, -2);
  });

  it('picks ring buffer when it is fresher than both lastSeenMs and lastHttpSuccessMs', () => {
    // Ring buffer: 1 min old (ok) — should win
    // lastSeenMs: 10 min old (warn alone)
    // lastHttpSuccessMs: 12 min old (warn alone)
    const log = [makeEvent('sdk_onHttp', NOW - 60_000, { success: true })];
    const result = computeOverallHealth(log, NOW, NOW - 10 * 60_000, NOW - 12 * 60_000);
    expect(result.level).toBe('ok');
    expect(result.uploadAgeMs).toBeCloseTo(60_000, -2);
  });

  // ── C. Edge cases: null / 0 / future ──────────────────────────────────────

  it('ignores lastHttpSuccessMs of null (treated as absent)', () => {
    const log: EngineLogEvent[] = [];
    const result = computeOverallHealth(log, NOW, null, null);
    expect(result.level).toBe('starting');
    expect(result.uploadAgeMs).toBeNull();
  });

  it('ignores lastHttpSuccessMs of 0 (sentinel / unset)', () => {
    const log: EngineLogEvent[] = [];
    const result = computeOverallHealth(log, NOW, null, 0);
    expect(result.level).toBe('starting');
    expect(result.uploadAgeMs).toBeNull();
  });

  it('ignores lastHttpSuccessMs that is in the future (clock skew guard)', () => {
    const log: EngineLogEvent[] = [];
    const result = computeOverallHealth(log, NOW, null, NOW + 60_000);
    expect(result.level).toBe('starting');
    expect(result.uploadAgeMs).toBeNull();
  });

  // ── D. Backward-compatible: existing callers that pass only 3 args ─────────

  it('existing callers that omit lastHttpSuccessMs continue to work unchanged', () => {
    const log = [makeEvent('sdk_onHttp', NOW - 2 * 60_000, { success: true })];
    const result = computeOverallHealth(log, NOW);
    expect(result.level).toBe('ok');
    expect(result.uploadAgeMs).toBeCloseTo(2 * 60_000, -2);
  });

  it('existing callers that pass lastSeenMs but not lastHttpSuccessMs continue to work', () => {
    const log: EngineLogEvent[] = [];
    const result = computeOverallHealth(log, NOW, NOW - 3 * 60_000);
    expect(result.level).toBe('ok');
    expect(result.uploadAgeMs).toBeCloseTo(3 * 60_000, -2);
  });

  // ── E. Hero card stays ok after a log clear when lastHttpSuccessMs survives ─
  //
  // clearEngineLog() wipes the ring buffer (LOG_KEY) but NOT the pipeline
  // timestamp keys (kc_pts_*).  The hero card must stay green from the
  // surviving key even with an empty log and no lastSeenMs yet.

  it('returns ok after a log clear when lastHttpSuccessMs is recent and lastSeenMs is absent', () => {
    const clearedLog: EngineLogEvent[] = [];
    const result = computeOverallHealth(clearedLog, NOW, null, NOW - 3 * 60_000);
    expect(result.level).toBe('ok');
    expect(result.uploadAgeMs).toBeCloseTo(3 * 60_000, -2);
  });

  it('returns starting after a log clear when both lastSeenMs and lastHttpSuccessMs are absent', () => {
    const clearedLog: EngineLogEvent[] = [];
    const result = computeOverallHealth(clearedLog, NOW, null, null);
    expect(result.level).toBe('starting');
    expect(result.uploadAgeMs).toBeNull();
  });
});

// ─── Network-error burst recovery — upload row with lastHttpSuccessMs ─────────
//
// Confirms the field scenario described in Task #41:
//
//   Device goes into airplane mode for ~10 minutes.  The Transistor SDK keeps
//   retrying uploads; each retry fires an onHttp callback with success=false.
//   After ~50 failure entries the ring buffer is FULL and every successful
//   sdk_onHttp entry has been evicted.
//
//   When connectivity is restored and the next upload succeeds:
//     • The foreground onHttp handler writes kc_pts_http_ok (recordPipelineTs).
//     • The headless HTTP handler writes the same key for background uploads.
//     • computeHealthItems() receives the key value as lastHttpSuccessMs.
//
//   Critical sub-case: after a manual "Clear engine log", the ring buffer is
//   wiped but kc_pts_http_ok is a SEPARATE AsyncStorage key that clearEngineLog()
//   never touches.  The upload row must remain green from the persistent key
//   rather than regressing to 'unknown' (the no-evidence state).

describe('network-error burst recovery — upload row with lastHttpSuccessMs', () => {
  beforeEach(() => { seq = 0; });

  const NOW = 9_000_000;

  // Helper: build a ring buffer filled with N failure entries and no successes.
  // Used to simulate the airplane-mode burst that evicts the last success entry.
  function failureBuffer(count: number): EngineLogEvent[] {
    return Array.from({ length: count }, (_, i) =>
      makeEvent('sdk_onHttp', NOW - (count - i) * 10_000, { success: false }),
    );
  }

  // ── 1. Full 50-entry ring buffer of failures + recent persistent key → ok ──
  //
  // This is the exact eviction scenario Task #41 guards against.  The ring
  // buffer (50 entries) is saturated with failure entries; the last success was
  // evicted.  computeHealthItems() would show ❌ without lastHttpSuccessMs.
  // With the key (2 min old), it must show ✅.

  it('upload row stays ok when a 50-entry failure buffer evicts the last success but lastHttpSuccessMs is recent', () => {
    const log = failureBuffer(50); // all failures, no success entry survives
    const lastHttpSuccessMs = NOW - 2 * 60_000; // 2 min ago — ok territory

    const items = computeHealthItems(log, NOW, lastHttpSuccessMs);

    const uploadItem = items.find((i) => i.label.includes('Last location uploaded'))!;
    expect(uploadItem).toBeDefined();
    expect(uploadItem.status).toBe('ok'); // persistent key saves the row
    expect(uploadItem.icon).toBe('✅');
  });

  it('upload row is ❌ when a 50-entry failure buffer evicts the last success AND no persistent key', () => {
    // Baseline: without lastHttpSuccessMs the row would have flipped to error.
    const log = failureBuffer(50);

    const items = computeHealthItems(log, NOW); // no third arg

    const uploadItem = items.find((i) => i.label.includes('waiting for first upload'))!;
    // No success in buffer, no persistent key → 'unknown'
    // (If a prior success is present but all entries are failures, the scan
    //  finds nothing → unknown, not error.  Error requires an old success.)
    expect(uploadItem).toBeDefined();
    expect(uploadItem.status).toBe('unknown');
  });

  // ── 2. After "Clear engine log", upload row stays green from persistent key ─
  //
  // clearEngineLog() wipes the ring buffer (LOG_KEY) but NOT the pipeline
  // timestamp keys (kc_pts_*).  This sub-case confirms computeHealthItems()
  // uses the surviving key even with an empty log.

  it('upload row stays ok after a log clear if lastHttpSuccessMs is recent (< 5 min)', () => {
    // Log has been cleared — same state as immediately after "Clear engine log".
    const clearedLog: EngineLogEvent[] = [];
    const lastHttpSuccessMs = NOW - 3 * 60_000; // 3 min ago

    const items = computeHealthItems(clearedLog, NOW, lastHttpSuccessMs);

    const uploadItem = items.find((i) => i.label.includes('Last location uploaded'))!;
    expect(uploadItem).toBeDefined();
    // 3 min < 5 min threshold → ok; NOT 'unknown' despite the empty log.
    expect(uploadItem.status).toBe('ok');
  });

  it('upload row shows warn after a log clear if lastHttpSuccessMs is 8 min old', () => {
    const clearedLog: EngineLogEvent[] = [];
    const lastHttpSuccessMs = NOW - 8 * 60_000; // 8 min → warn

    const items = computeHealthItems(clearedLog, NOW, lastHttpSuccessMs);

    const uploadItem = items.find((i) => i.label.includes('Last location uploaded'))!;
    expect(uploadItem).toBeDefined();
    expect(uploadItem.status).toBe('warn'); // 5–15 min window
  });

  it('upload row shows error after a log clear if lastHttpSuccessMs is 20 min old', () => {
    const clearedLog: EngineLogEvent[] = [];
    const lastHttpSuccessMs = NOW - 20 * 60_000; // 20 min → error

    const items = computeHealthItems(clearedLog, NOW, lastHttpSuccessMs);

    const uploadItem = items.find((i) => i.label.includes('Last location uploaded'))!;
    expect(uploadItem).toBeDefined();
    expect(uploadItem.status).toBe('error'); // > 15 min threshold
  });

  it('upload row is unknown after a log clear when lastHttpSuccessMs is also absent', () => {
    // Baseline: neither ring buffer nor persistent key has evidence.
    const clearedLog: EngineLogEvent[] = [];

    const items = computeHealthItems(clearedLog, NOW, null);

    const uploadItem = items.find((i) => i.label.includes('waiting for first upload'))!;
    expect(uploadItem).toBeDefined();
    expect(uploadItem.status).toBe('unknown'); // honest — no evidence at all
  });

  // ── 3. Label text is correct when the persistent key is the sole source ─────
  //
  // The upload row label must say "Last location uploaded: Xm ago" (not the
  // "waiting for first upload" placeholder) whenever lastHttpSuccessMs provides
  // the evidence, even when the ring buffer has no success entry.

  it('upload row label reads "Last location uploaded" (not "waiting") when lastHttpSuccessMs is the only source', () => {
    const log: EngineLogEvent[] = []; // empty — no ring-buffer evidence
    const lastHttpSuccessMs = NOW - 90_000; // 1.5 min ago

    const items = computeHealthItems(log, NOW, lastHttpSuccessMs);

    const uploadItem = items.find((i) => i.label.startsWith('Last location uploaded'))!;
    expect(uploadItem).toBeDefined();
    // Must NOT fall back to the "waiting" placeholder
    const placeholder = items.find((i) => i.label.includes('waiting for first upload'));
    expect(placeholder).toBeUndefined();
  });

  // ── 4. Recovery sequence: burst then success then more failures ───────────
  //
  // Simulates the exact airplane-mode recovery: the device uploads once after
  // connectivity is restored (writing kc_pts_http_ok), then a few retries fail
  // again.  The upload row must stay green because the persistent key records
  // the recovery timestamp, not the subsequent failures.

  it('upload row stays ok after recovery even if more failures arrive after the first success', () => {
    // After recovery: one success sandwiched between failures
    const successTs = NOW - 90_000; // 1.5 min ago
    const log: EngineLogEvent[] = [
      makeEvent('sdk_onHttp', NOW - 5 * 60_000, { success: false }),
      makeEvent('sdk_onHttp', NOW - 4 * 60_000, { success: false }),
      makeEvent('sdk_onHttp', successTs,         { success: true }),  // recovery upload
      makeEvent('sdk_onHttp', NOW - 60_000,      { success: false }),
      makeEvent('sdk_onHttp', NOW - 30_000,      { success: false }),
    ];
    // The persistent key records the recovery timestamp
    const lastHttpSuccessMs = successTs;

    const items = computeHealthItems(log, NOW, lastHttpSuccessMs);

    const uploadItem = items.find((i) => i.label.includes('Last location uploaded'))!;
    expect(uploadItem).toBeDefined();
    // The ring buffer scan finds the success (it wasn't evicted in this scenario)
    // AND the persistent key confirms it — both agree on ok.
    expect(uploadItem.status).toBe('ok');
  });

  // ── 5. worstHealthStatus does not propagate error from full failure buffer ──
  //
  // When lastHttpSuccessMs is recent, the overall health banner must not show ❌
  // just because failure entries dominate the buffer.

  it('worstHealthStatus is not error when lastHttpSuccessMs is recent despite failure-only buffer', () => {
    const log = failureBuffer(50);
    const lastHttpSuccessMs = NOW - 2 * 60_000;

    const items = computeHealthItems(log, NOW, lastHttpSuccessMs);
    const worst = worstHealthStatus(items);

    // worst may be 'ok' or 'unknown' (other rows like heartbeat may be unknown)
    // — but must NOT be 'error' from the failure-filled buffer alone.
    expect(worst).not.toBe('error');
  });
});

// ─── computeOverallHealth — subline copy contains the formatted age ───────────
//
// Task #62: The subline strings caregivers actually read are assembled inside
// computeOverallHealth — e.g. "Last location confirmed: 2m ago".  No prior
// test asserted the full subline text, so a merge conflict that dropped
// "Last location confirmed:" would pass all existing tests but silently corrupt
// the copy caregivers see.
//
// These tests pin the subline wording for every branch:
//   • ok          — upload < 5 min    → "Last location confirmed: Xm ago"
//   • warn        — upload 5–15 min   → "Last location confirmed: Xm ago — usually self-correcting"
//   • error       — upload > 15 min   → "Last location confirmed: Xm ago — check background permissions"
//   • heartbeat   — heartbeat, no upload → "Last heartbeat: Xs ago — upload confirmation expected..."

describe('computeOverallHealth — subline contains the formatted age', () => {
  beforeEach(() => { seq = 0; });

  const NOW = 10_000_000;

  // ── ok branch: upload < 5 min ─────────────────────────────────────────────
  //
  // Upload 2 min ago → level 'ok'.
  // Subline must mention "Last location confirmed:" and include the age string.

  it('ok subline reads "Last location confirmed: 2m ago"', () => {
    const log = [
      makeEvent('sdk_onHttp', NOW - 2 * 60_000, { success: true }), // 2 min ago
    ];
    const result = computeOverallHealth(log, NOW);
    expect(result.level).toBe('ok');
    expect(result.subline).toMatch(/Last location confirmed:/);
    expect(result.subline).toMatch(/2m ago/);
  });

  it('ok subline contains the exact age formatted by formatAgeMs', () => {
    // 90 s = 1.5 min → formatAgeMs rounds to 2m ago
    const uploadAgeMs = 90_000;
    const log = [
      makeEvent('sdk_onHttp', NOW - uploadAgeMs, { success: true }),
    ];
    const result = computeOverallHealth(log, NOW);
    expect(result.level).toBe('ok');
    expect(result.subline).toContain(formatAgeMs(uploadAgeMs));
  });

  // ── warn branch: upload 5–15 min ─────────────────────────────────────────
  //
  // Upload 10 min ago → level 'warn'.
  // Subline must still lead with "Last location confirmed:" (not a generic
  // "upload delayed" string) and must include the qualifying rider.

  it('warn subline reads "Last location confirmed: 10m ago — usually self-correcting"', () => {
    const log = [
      makeEvent('sdk_onHttp', NOW - 10 * 60_000, { success: true }), // 10 min ago
    ];
    const result = computeOverallHealth(log, NOW);
    expect(result.level).toBe('warn');
    expect(result.subline).toMatch(/Last location confirmed:/);
    expect(result.subline).toMatch(/10m ago/);
    expect(result.subline).toMatch(/self-correcting/i);
  });

  it('warn subline contains the exact age formatted by formatAgeMs', () => {
    const uploadAgeMs = 7 * 60_000; // 7 min
    const log = [
      makeEvent('sdk_onHttp', NOW - uploadAgeMs, { success: true }),
    ];
    const result = computeOverallHealth(log, NOW);
    expect(result.level).toBe('warn');
    expect(result.subline).toContain(formatAgeMs(uploadAgeMs));
  });

  // ── error branch: upload > 15 min ────────────────────────────────────────
  //
  // Upload 20 min ago → level 'error'.
  // Subline must still report the age (not just "check permissions") so
  // caregivers know how long ago the last location was confirmed.

  it('error subline reads "Last location confirmed: 20m ago — check background permissions"', () => {
    const log = [
      makeEvent('sdk_onHttp', NOW - 20 * 60_000, { success: true }), // 20 min ago
    ];
    const result = computeOverallHealth(log, NOW);
    expect(result.level).toBe('error');
    expect(result.subline).toMatch(/Last location confirmed:/);
    expect(result.subline).toMatch(/20m ago/);
    expect(result.subline).toMatch(/background permissions/i);
  });

  it('error subline contains the exact age formatted by formatAgeMs', () => {
    const uploadAgeMs = 25 * 60_000; // 25 min → formatAgeMs: "25m ago"
    const log = [
      makeEvent('sdk_onHttp', NOW - uploadAgeMs, { success: true }),
    ];
    const result = computeOverallHealth(log, NOW);
    expect(result.level).toBe('error');
    expect(result.subline).toContain(formatAgeMs(uploadAgeMs));
  });

  // ── heartbeat-only warn: no upload, heartbeat present ────────────────────
  //
  // When no upload evidence exists but a heartbeat is present the level is
  // 'warn'.  The subline must reference the heartbeat age — not the upload
  // age — and must include the "expected within the next minute" rider so
  // caregivers understand this is transient, not an error.

  it('heartbeat-only warn subline reads "Last heartbeat: 45s ago — upload confirmation expected…"', () => {
    const log = [
      makeEvent('sdk_onHeartbeat', NOW - 45_000), // 45 s ago
    ];
    const result = computeOverallHealth(log, NOW);
    expect(result.level).toBe('warn');
    expect(result.uploadAgeMs).toBeNull();
    expect(result.subline).toMatch(/Last heartbeat:/);
    expect(result.subline).toMatch(/45s ago/);
    expect(result.subline).toMatch(/upload confirmation expected/i);
  });

  it('heartbeat-only warn subline contains the exact heartbeat age from formatAgeMs', () => {
    const hbAgeMs = 2 * 60_000; // 2 min
    const log = [
      makeEvent('headless_task_invoked', NOW - hbAgeMs),
    ];
    const result = computeOverallHealth(log, NOW);
    expect(result.level).toBe('warn');
    expect(result.uploadAgeMs).toBeNull();
    expect(result.subline).toContain(formatAgeMs(hbAgeMs));
  });

  // ── cross-check: subline never contains raw numbers without units ─────────
  //
  // A formatting regression (e.g. formatAgeMs returning "120000" instead of
  // "2m ago") would produce sublines like "Last location confirmed: 120000".
  // Guard against that by asserting the subline always contains "ago".

  it('ok subline always contains the word "ago" (not a raw millisecond count)', () => {
    const log = [makeEvent('sdk_onHttp', NOW - 90_000, { success: true })];
    const result = computeOverallHealth(log, NOW);
    expect(result.level).toBe('ok');
    expect(result.subline).toContain('ago');
  });

  it('warn subline always contains the word "ago" (not a raw millisecond count)', () => {
    const log = [makeEvent('sdk_onHttp', NOW - 8 * 60_000, { success: true })];
    const result = computeOverallHealth(log, NOW);
    expect(result.level).toBe('warn');
    expect(result.subline).toContain('ago');
  });

  it('error subline always contains the word "ago" (not a raw millisecond count)', () => {
    const log = [makeEvent('sdk_onHttp', NOW - 20 * 60_000, { success: true })];
    const result = computeOverallHealth(log, NOW);
    expect(result.level).toBe('error');
    expect(result.subline).toContain('ago');
  });

  it('heartbeat-only warn subline always contains the word "ago"', () => {
    const log = [makeEvent('sdk_onHeartbeat', NOW - 30_000)];
    const result = computeOverallHealth(log, NOW);
    expect(result.level).toBe('warn');
    expect(result.subline).toContain('ago');
  });
});

// ─── formatAgeMs — human-readable age strings shown in health sublines ────────
//
// formatAgeMs produces every timestamp shown in the Diagnostics and Me tab
// health sublines ("2m ago", "1h ago", etc.).  A regression here corrupts
// the text across the entire health UI with zero visual indication.

describe('formatAgeMs — timestamp formatting', () => {
  // ── Degenerate / invalid inputs → em-dash ────────────────────────────────

  it('returns "—" for null', () => {
    expect(formatAgeMs(null)).toBe('—');
  });

  it('returns "—" for undefined', () => {
    // Cast needed because the TypeScript signature says null, but the guard
    // also covers undefined (JavaScript callers may omit the argument).
    expect(formatAgeMs(undefined as unknown as null)).toBe('—');
  });

  it('returns "—" for NaN', () => {
    expect(formatAgeMs(NaN)).toBe('—');
  });

  it('returns "—" for +Infinity', () => {
    expect(formatAgeMs(Infinity)).toBe('—');
  });

  it('returns "—" for -Infinity', () => {
    expect(formatAgeMs(-Infinity)).toBe('—');
  });

  // ── Seconds range ─────────────────────────────────────────────────────────

  it('returns "0s ago" for 0 ms', () => {
    expect(formatAgeMs(0)).toBe('0s ago');
  });

  it('returns "45s ago" for 45 000 ms', () => {
    expect(formatAgeMs(45_000)).toBe('45s ago');
  });

  it('crosses into the minutes branch at 59 999 ms (rounds to 60 s — boundary check)', () => {
    // Math.round(59999 / 1000) = 60; 60 is not < 60 so the minutes branch fires.
    // m = Math.round(60 / 60) = 1 → "1m ago".
    // This test documents the exact rounding boundary so any change to the
    // threshold is caught immediately.
    expect(formatAgeMs(59_999)).toBe('1m ago');
  });

  it('returns "59s ago" for 59 000 ms', () => {
    expect(formatAgeMs(59_000)).toBe('59s ago');
  });

  // ── Minutes range ─────────────────────────────────────────────────────────

  it('returns "2m ago" for 90 000 ms (rounds 1.5 min → 2)', () => {
    // s = Math.round(90000 / 1000) = 90; m = Math.round(90 / 60) = 2
    expect(formatAgeMs(90_000)).toBe('2m ago');
  });

  it('returns "1m ago" for 60 000 ms', () => {
    expect(formatAgeMs(60_000)).toBe('1m ago');
  });

  it('returns "10m ago" for 600 000 ms', () => {
    expect(formatAgeMs(600_000)).toBe('10m ago');
  });

  // ── Hours range ───────────────────────────────────────────────────────────

  it('returns "1h ago" for 3 600 000 ms (exactly 60 min)', () => {
    // s = 3600; m = 60; h = Math.round(60/60) = 1
    expect(formatAgeMs(3_600_000)).toBe('1h ago');
  });

  it('returns "2h ago" for 7 200 000 ms', () => {
    expect(formatAgeMs(7_200_000)).toBe('2h ago');
  });

  // ── Negative values — clock skew guard → em-dash ─────────────────────────
  //
  // Negative ms means the recorded timestamp is in the future relative to
  // `now`, which can happen if the device clock is skewed.  formatAgeMs must
  // return '—' for any negative input (consistent with the NaN / Infinity
  // guard) so caregivers never see "-2m ago" or "-1s ago" in health sublines.

  it('does not throw for negative values', () => {
    expect(() => formatAgeMs(-1_000)).not.toThrow();
  });

  it('returns "—" for small negative values (-1 000 ms)', () => {
    expect(formatAgeMs(-1_000)).toBe('—');
  });

  it('returns "—" for large negative values (-90 000 ms)', () => {
    expect(formatAgeMs(-90_000)).toBe('—');
  });
});
