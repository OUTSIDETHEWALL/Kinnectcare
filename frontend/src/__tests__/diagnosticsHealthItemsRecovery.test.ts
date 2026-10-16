import { computeHealthItems, computeOverallHealth } from '../healthCheck';
import { e, testNow as now } from './backgroundEvidenceFixture';

describe('HTTP recovery row is explicitly contact evidence, not coordinate freshness', () => {
  const log = [e('sdk_onHttp', now, { success: false, status: 500 })];
  it.each([[null, 'unknown'], [now - 60_000, 'ok'], [now - 8 * 60_000, 'warn'],
    [now - 20 * 60_000, 'error']] as const)('persistent HTTP %s yields %s contact status', (http, status) => {
    const row = computeHealthItems(log, now, http).find(item => /HTTP upload/.test(item.label));
    expect(row?.status).toBe(status);
    expect(row?.label).not.toMatch(/location uploaded/);
    expect(computeOverallHealth(log, now, now, http).level).not.toBe('ok');
  });
});
