/**
 * diagnosticsHeroCard.test.ts
 *
 * Component-level tests for the Diagnostics hero card.
 *
 * The hero card maps computeOverallHealth()'s `level` output to a visual
 * theme (background colour, border colour, headline colour, icon) and renders
 * the `headline` and `subline` strings.  A copy-paste mistake in that mapping
 * would silently show the wrong colour or the wrong headline to caregivers
 * even though the underlying computeOverallHealth calculation is correct.
 *
 * These tests verify both halves of the contract:
 *   A. heroTheme — the level → visual-style table used by the component.
 *   B. Integration — computeOverallHealth + heroTheme together, confirming that
 *      realistic log inputs produce the correct theme entry and headline text.
 *
 * No React Native rendering is required: the mapping is a plain JS object
 * exported from healthCheck.ts and consumed by the component.  Testing it at
 * this level is sufficient to catch the silent-wrong-colour bug class.
 */

import {
  heroTheme,
  computeOverallHealth,
  OverallHealthLevel,
} from '../healthCheck';
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

// ─── A. heroTheme: level → visual mapping ────────────────────────────────────

describe('heroTheme — level → visual-style mapping', () => {
  beforeEach(() => { seq = 0; });

  // The colour identities below are the source of truth.  If someone accidentally
  // swaps the ok and error entries, or pastes the wrong hex, these tests fail.

  it('ok → green indicator (bg #ECFDF5, border #6EE7B7, headline #065F46, icon 🛡️)', () => {
    const t = heroTheme.ok;
    expect(t.bg).toBe('#ECFDF5');
    expect(t.border).toBe('#6EE7B7');
    expect(t.headline).toBe('#065F46');
    expect(t.sub).toBe('#047857');
    expect(t.icon).toBe('🛡️');
  });

  it('warn → amber indicator (bg #FFFBEB, border #FDE68A, headline #92400E, icon ⚠️)', () => {
    const t = heroTheme.warn;
    expect(t.bg).toBe('#FFFBEB');
    expect(t.border).toBe('#FDE68A');
    expect(t.headline).toBe('#92400E');
    expect(t.sub).toBe('#B45309');
    expect(t.icon).toBe('⚠️');
  });

  it('error → red indicator (bg #FEF2F2, border #FECACA, headline #991B1B, icon ❌)', () => {
    const t = heroTheme.error;
    expect(t.bg).toBe('#FEF2F2');
    expect(t.border).toBe('#FECACA');
    expect(t.headline).toBe('#991B1B');
    expect(t.sub).toBe('#DC2626');
    expect(t.icon).toBe('❌');
  });

  it('starting → neutral indicator (bg #F9FAFB, border #E5E7EB, headline #374151, icon ⏳)', () => {
    const t = heroTheme.starting;
    expect(t.bg).toBe('#F9FAFB');
    expect(t.border).toBe('#E5E7EB');
    expect(t.headline).toBe('#374151');
    expect(t.sub).toBe('#6B7280');
    expect(t.icon).toBe('⏳');
  });

  it('all four levels are present in heroTheme (no missing entry)', () => {
    const levels: OverallHealthLevel[] = ['ok', 'warn', 'error', 'starting'];
    for (const level of levels) {
      expect(heroTheme[level]).toBeDefined();
    }
  });

  it('no two levels share the same background colour (colours are not accidentally swapped)', () => {
    const bgs = Object.values(heroTheme).map((t) => t.bg);
    const unique = new Set(bgs);
    expect(unique.size).toBe(bgs.length);
  });

  it('no two levels share the same border colour', () => {
    const borders = Object.values(heroTheme).map((t) => t.border);
    const unique = new Set(borders);
    expect(unique.size).toBe(borders.length);
  });

  it('error is visually distinct from ok (not using green palette)', () => {
    // Regression guard: error must never accidentally use the green (#ECFDF5) bg.
    expect(heroTheme.error.bg).not.toBe(heroTheme.ok.bg);
    expect(heroTheme.error.border).not.toBe(heroTheme.ok.border);
    expect(heroTheme.error.headline).not.toBe(heroTheme.ok.headline);
  });
});

// ─── B. Integration: computeOverallHealth + heroTheme ────────────────────────
//
// Exercises the full path a caregiver experiences: engine-log events arrive →
// computeOverallHealth produces a level + headline → heroTheme selects the
// colour theme.  Each test confirms both the level/headline AND the visual
// style are correct.

describe('hero card — integration of computeOverallHealth + heroTheme', () => {
  beforeEach(() => { seq = 0; });

  const NOW = 10_000_000;

  // ── level: 'ok' ───────────────────────────────────────────────────────────

  it('recent upload → ok level → green card + "Background monitoring is healthy"', () => {
    const log = [
      makeEvent('sdk_onHttp', NOW - 2 * 60_000, { success: true }), // 2 min ago
    ];
    const result = computeOverallHealth(log, NOW);
    const theme  = heroTheme[result.level];

    expect(result.level).toBe('ok');
    expect(result.headline).toBe('Background monitoring is healthy');

    // Green palette
    expect(theme.bg).toBe('#ECFDF5');
    expect(theme.border).toBe('#6EE7B7');
    expect(theme.headline).toBe('#065F46');
    expect(theme.icon).toBe('🛡️');
  });

  it('recent lastSeenMs (no JS log upload) → ok level → green card', () => {
    const log: EngineLogEvent[] = [];
    const lastSeenMs = NOW - 90_000; // 1.5 min ago
    const result = computeOverallHealth(log, NOW, lastSeenMs);
    const theme  = heroTheme[result.level];

    expect(result.level).toBe('ok');
    expect(theme.bg).toBe('#ECFDF5');
    expect(theme.icon).toBe('🛡️');
  });

  // ── level: 'warn' ─────────────────────────────────────────────────────────

  it('upload 10 min old → warn level → amber card + "Monitoring may be delayed"', () => {
    const log = [
      makeEvent('sdk_onHttp', NOW - 10 * 60_000, { success: true }), // 10 min ago
    ];
    const result = computeOverallHealth(log, NOW);
    const theme  = heroTheme[result.level];

    expect(result.level).toBe('warn');
    expect(result.headline).toBe('Monitoring may be delayed');

    // Amber palette
    expect(theme.bg).toBe('#FFFBEB');
    expect(theme.border).toBe('#FDE68A');
    expect(theme.headline).toBe('#92400E');
    expect(theme.icon).toBe('⚠️');
  });

  it('heartbeat present but no upload → warn level → amber card + "Engine running, no upload confirmed yet"', () => {
    const log = [
      makeEvent('sdk_onHeartbeat', NOW - 45_000), // 45 s ago, no upload
    ];
    const result = computeOverallHealth(log, NOW);
    const theme  = heroTheme[result.level];

    expect(result.level).toBe('warn');
    expect(result.headline).toBe('Engine running, no upload confirmed yet');

    expect(theme.bg).toBe('#FFFBEB');
    expect(theme.icon).toBe('⚠️');
  });

  it('headless task invoked but no upload → warn level → amber card', () => {
    const log = [
      makeEvent('headless_task_invoked', NOW - 30_000),
    ];
    const result = computeOverallHealth(log, NOW);
    const theme  = heroTheme[result.level];

    expect(result.level).toBe('warn');
    expect(theme.bg).toBe('#FFFBEB');
    expect(theme.icon).toBe('⚠️');
  });

  // ── level: 'error' ────────────────────────────────────────────────────────

  it('upload > 15 min old → error level → red card + "Monitoring appears to have stopped"', () => {
    const log = [
      makeEvent('sdk_onHttp', NOW - 20 * 60_000, { success: true }), // 20 min ago
    ];
    const result = computeOverallHealth(log, NOW);
    const theme  = heroTheme[result.level];

    expect(result.level).toBe('error');
    expect(result.headline).toBe('Monitoring appears to have stopped');

    // Red palette
    expect(theme.bg).toBe('#FEF2F2');
    expect(theme.border).toBe('#FECACA');
    expect(theme.headline).toBe('#991B1B');
    expect(theme.icon).toBe('❌');
  });

  it('engine explicitly disabled (no upload) → error level → red card', () => {
    const log = [
      makeEvent('sdk_onEnabledChange', NOW - 5_000, { enabled: false }),
    ];
    const result = computeOverallHealth(log, NOW);
    const theme  = heroTheme[result.level];

    expect(result.level).toBe('error');
    expect(result.headline).toBe('Monitoring appears to have stopped');

    expect(theme.bg).toBe('#FEF2F2');
    expect(theme.icon).toBe('❌');
  });

  it('lastSeenMs > 15 min old and no JS log upload → error level → red card', () => {
    const log: EngineLogEvent[] = [];
    const lastSeenMs = NOW - 20 * 60_000; // 20 min ago
    const result = computeOverallHealth(log, NOW, lastSeenMs);
    const theme  = heroTheme[result.level];

    expect(result.level).toBe('error');
    expect(theme.bg).toBe('#FEF2F2');
    expect(theme.icon).toBe('❌');
  });

  // ── level: 'starting' ─────────────────────────────────────────────────────

  it('empty log → starting level → neutral card + "Kinnship is starting up"', () => {
    const log: EngineLogEvent[] = [];
    const result = computeOverallHealth(log, NOW);
    const theme  = heroTheme[result.level];

    expect(result.level).toBe('starting');
    expect(result.headline).toBe('Kinnship is starting up');

    // Neutral palette
    expect(theme.bg).toBe('#F9FAFB');
    expect(theme.border).toBe('#E5E7EB');
    expect(theme.headline).toBe('#374151');
    expect(theme.icon).toBe('⏳');
  });

  it('unrelated events only (no upload, no heartbeat) → starting → neutral card', () => {
    const log = [
      makeEvent('battery_listeners_attached', NOW - 1_000),
      makeEvent('sdk_onPowerSaveChange', NOW - 2_000, { isPowerSaveMode: false }),
    ];
    const result = computeOverallHealth(log, NOW);
    const theme  = heroTheme[result.level];

    expect(result.level).toBe('starting');
    expect(theme.bg).toBe('#F9FAFB');
    expect(theme.icon).toBe('⏳');
  });

  // ── Transition guard: monitoring stops mid-session ─────────────────────────
  //
  // The caregiver's specific fear: they open the app and see green, then
  // monitoring silently stops.  On the next poll they must see red.

  it('card transitions from green to red as upload ages past 15 min', () => {
    const uploadAt = NOW - 1 * 60_000; // 1 min ago — ok
    const log = [makeEvent('sdk_onHttp', uploadAt, { success: true })];

    const resultOk = computeOverallHealth(log, NOW);
    expect(resultOk.level).toBe('ok');
    expect(heroTheme[resultOk.level].bg).toBe('#ECFDF5'); // green

    // Simulate time passing — no new upload
    const laterNow = NOW + 16 * 60_000; // 17 min after the upload
    const resultError = computeOverallHealth(log, laterNow);
    expect(resultError.level).toBe('error');
    expect(heroTheme[resultError.level].bg).toBe('#FEF2F2'); // red

    // Sanity: the two cards use different bg colours
    expect(heroTheme[resultOk.level].bg).not.toBe(heroTheme[resultError.level].bg);
  });

  it('card transitions from neutral (starting) to green when first upload arrives', () => {
    const log: EngineLogEvent[] = [];

    const resultStarting = computeOverallHealth(log, NOW);
    expect(resultStarting.level).toBe('starting');
    expect(heroTheme[resultStarting.level].bg).toBe('#F9FAFB'); // neutral

    // First upload arrives
    log.push(makeEvent('sdk_onHttp', NOW + 30_000, { success: true }));
    const laterNow = NOW + 60_000;
    const resultOk = computeOverallHealth(log, laterNow);
    expect(resultOk.level).toBe('ok');
    expect(heroTheme[resultOk.level].bg).toBe('#ECFDF5'); // green
  });
});
