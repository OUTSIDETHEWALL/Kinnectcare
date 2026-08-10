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

import { computeHealthItems, worstHealthStatus, HealthItem } from '../healthCheck';
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
