import { computeOverallHealth } from '../healthCheck';
import { backgroundEvidence, e, testNow as now } from './backgroundEvidenceFixture';

describe('fresh-install health requires GPS evidence, not first contact', () => {
  it('has no green claim before evidence exists', () => {
    expect(computeOverallHealth([], now).level).toBe('starting');
  });
  it.each(['ready_ok', 'sdk_onHeartbeat', 'sdk_onLocation', 'app_foregrounded'])(
    '%s alone never establishes background delivery', name => {
      expect(computeOverallHealth([e(name)], now).level).not.toBe('ok');
    });
  it.each([0, 1000, 3000, 5000, 6000, 299_000, 300_000, 900_001])(
    'HTTP/contact timestamp offset %d cannot create background evidence', offset => {
      expect(computeOverallHealth([], now, now + offset, now + offset).level).not.toBe('ok');
      expect(computeOverallHealth([], now, now - offset, now - offset).level).not.toBe('ok');
    });
  it('state updates and foreground polls remain separate from actual GPS proof', () => {
    const log = [e('sdk_state_observed', now, { enabled: true })];
    for (let tick = 0; tick < 10; tick++) {
      expect(computeOverallHealth(log, now + tick * 1000, now, now).level).not.toBe('ok');
    }
    expect(computeOverallHealth(backgroundEvidence(), now).level).toBe('ok');
  });
  it.each([1000, 3000, 5000])('allows bounded capture clock skew of %dms, not missing evidence', skew => {
    const log = backgroundEvidence(now + skew);
    expect(computeOverallHealth(log, now).level).toBe('ok');
    expect(computeOverallHealth([], now, now + skew, now + skew).level).not.toBe('ok');
  });
  it('rejects large future evidence and ages by capture rather than callback time', () => {
    expect(computeOverallHealth(backgroundEvidence(now + 60_000), now).level).not.toBe('ok');
    const stale = backgroundEvidence(now, 6 * 60_000);
    for (const event of stale) if (event.event === 'verified_coordinate_publication') event.at = now;
    const result = computeOverallHealth(stale, now);
    expect(result.level).not.toBe('ok');
    expect(result.uploadAgeMs).toBe(6 * 60_000);
  });
});
