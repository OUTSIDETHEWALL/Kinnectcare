import { computeOverallHealth, heroTheme } from '../healthCheck';
import { backgroundEvidence, e, testNow as now } from './backgroundEvidenceFixture';

describe('hero theme keeps claim and palette consistent', () => {
  it.each([
    ['ok', '#ECFDF5', '#6EE7B7', '#065F46', '#047857', '🛡️'],
    ['warn', '#FFFBEB', '#FDE68A', '#92400E', '#B45309', '⚠️'],
    ['error', '#FEF2F2', '#FECACA', '#991B1B', '#DC2626', '❌'],
    ['starting', '#F9FAFB', '#E5E7EB', '#374151', '#6B7280', '⏳'],
  ] as const)('%s maps to its intended palette', (level, bg, border, headline, sub, icon) => {
    expect(heroTheme[level]).toEqual({ bg, border, headline, sub, icon });
  });
  it.each([
    [e('sdk_onHttp', now, { success: true })],
    [e('sdk_onHeartbeat')],
    [e('verified_coordinate_publication', now, { origin: 'one-shot', capturedAt: now })],
  ])('does not turn contact/heartbeat/foreground-only evidence green: %j', event => {
    const result = computeOverallHealth([event], now, now, now);
    expect(result.level).not.toBe('ok');
    expect(result.headline).not.toMatch(/is healthy|^Repeated background delivery verified/i);
    expect(heroTheme[result.level].bg).not.toBe(heroTheme.ok.bg);
  });
  it('only repeated, correlated background captures can establish a green claim', () => {
    const log = backgroundEvidence();
    const result = computeOverallHealth(log, now);
    expect(result.level).toBe('ok');
    expect(result.headline).toBe('Repeated background delivery verified');
    expect(heroTheme[result.level]).toBe(heroTheme.ok);
    expect(computeOverallHealth(log, now + 6 * 60_000).level).not.toBe('ok');
  });
  it('a new owner/generation and current disabled native state invalidate old green evidence', () => {
    for (const state of [{ owner: 'other:member', generation: 1, enabled: true },
      { owner: 'user:member', generation: 2, enabled: true }, { enabled: false }]) {
      const log = backgroundEvidence().concat(e('sdk_state_observed', now + 1, state));
      expect(computeOverallHealth(log, now + 1).level).not.toBe('ok');
    }
  });
});
