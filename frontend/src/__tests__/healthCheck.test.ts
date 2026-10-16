import { computeHealthItems, computeOverallHealth, formatAgeMs, worstHealthStatus } from '../healthCheck';
import { backgroundEvidence, e, testNow as now } from './backgroundEvidenceFixture';

describe('independent health observations', () => {
  it.each([[0, 'ok'], [299_999, 'ok'], [300_000, 'warn'], [899_999, 'warn'],
    [900_000, 'error']] as const)('HTTP age %d produces %s contact status', (age, status) => {
    const row = computeHealthItems([e('sdk_onHttp', now - age, { success: true })], now)
      .find(item => /HTTP upload/.test(item.label));
    expect(row?.status).toBe(status);
  });
  it.each([null, 0, now + 60_000])('ignores absent/invalid persisted contact time %s', time => {
    const row = computeHealthItems([], now, time).find(item => /HTTP upload/.test(item.label));
    expect(row?.status).toBe('unknown');
  });
  it('uses the fresher contact source without asserting GPS freshness', () => {
    const log = [e('sdk_onHttp', now - 8 * 60_000, { success: true })];
    expect(computeHealthItems(log, now, now - 60_000)[2].status).toBe('ok');
    expect(computeHealthItems([e('sdk_onHttp', now, { success: true })], now, now - 8 * 60_000)[2].status).toBe('ok');
    expect(computeOverallHealth(log, now, now, now).level).not.toBe('ok');
  });
  it('an arbitrary headless invocation is not a heartbeat', () => {
    const items = computeHealthItems([e('headless_task_invoked', now, { eventName: 'terminate' })], now);
    expect(items[1].status).toBe('unknown');
  });
  it('contact does not recolor an old heartbeat green; motion suppression is not proof of failure', () => {
    const log = [e('sdk_onHeartbeat', now - 20 * 60_000),
      e('sdk_onHttp', now, { success: true })];
    expect(computeHealthItems(log, now)[1].status).toBe('warn');
    expect(computeOverallHealth(log, now).level).not.toBe('ok');
  });
  it('future receipts, one-shot capture, enabled state and contact cannot certify tracking', () => {
    const cases = [[], [e('sdk_state_observed', now, { enabled: true })],
      [e('verified_coordinate_publication', now, { origin: 'one-shot', capturedAt: now })],
      backgroundEvidence(now + 60_000)];
    for (const log of cases) expect(computeOverallHealth(log, now, now, now).level).not.toBe('ok');
  });
  it('clearing evidence cannot preserve an earlier green verdict', () => {
    expect(computeOverallHealth(backgroundEvidence(), now).level).toBe('ok');
    expect(computeOverallHealth([], now).level).toBe('starting');
  });
  it('unknown metadata and malformed/large-future capture times fail closed', () => {
    for (const capturedAt of [undefined, null, 'now', NaN, now + 60_000]) {
      expect(computeOverallHealth([e('verified_coordinate_publication', now,
        { origin: 'background', capturedAt })], now).level).not.toBe('ok');
    }
  });
});

describe('health severity and age formatting helpers', () => {
  it('orders error > warning > unknown > ok without inventing missing evidence', () => {
    const item = (status: 'ok' | 'warn' | 'unknown' | 'error') => ({ status, label: '', icon: '' });
    expect(worstHealthStatus([item('ok')])).toBe('ok');
    expect(worstHealthStatus([item('ok'), item('unknown')])).toBe('unknown');
    expect(worstHealthStatus([item('unknown'), item('warn')])).toBe('warn');
    expect(worstHealthStatus([item('warn'), item('error')])).toBe('error');
  });
  it('preserves unknown ages rather than formatting them as fresh', () => {
    expect(formatAgeMs(null)).not.toMatch(/just now|0s/);
    expect(formatAgeMs(120_000)).toMatch(/2/);
  });
});
