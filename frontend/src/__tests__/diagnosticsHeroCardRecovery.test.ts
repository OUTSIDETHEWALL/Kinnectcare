import { computeOverallHealth } from '../healthCheck';
import { backgroundEvidence, e, testNow as now } from './backgroundEvidenceFixture';

describe('failure bursts and recovery cannot fabricate background GPS success', () => {
  const failures = Array.from({ length: 50 }, (_, i) =>
    e('sdk_onHttp', now - i * 1000, { success: false, status: 500 })).reverse();
  it.each([null, 0, now - 120_000, now, now + 5000, now + 60_000])(
    'persistent HTTP timestamp %s does not certify a failure-only history', http => {
      const result = computeOverallHealth(failures, now, null, http);
      expect(result.level).not.toBe('ok');
      expect(result.uploadAgeMs).toBeNull();
    });
  it('preserved canonical GPS evidence can survive an operational-error burst', () => {
    const log = backgroundEvidence().concat(failures);
    expect(computeOverallHealth(log, now).level).toBe('ok');
  });
  it('an explicit stop separates old and new evidence lifetimes', () => {
    const log = backgroundEvidence().concat(e('tracking_authority_boundary', now + 1));
    expect(computeOverallHealth(log, now + 2, now, now).level).not.toBe('ok');
  });
  it('one capture replayed twice is not repeated tracking', () => {
    const log = backgroundEvidence();
    for (const event of log) if (typeof event.detail?.capturedAt === 'number') {
      event.detail.capturedAt = now;
    }
    expect(computeOverallHealth(log, now).level).not.toBe('ok');
  });
  it('a capture observed in foreground cannot be reclassified by HTTP completion in background', () => {
    const log = backgroundEvidence();
    for (const event of log) if (event.event === 'native_capture_observed') {
      event.detail!.origin = 'foreground';
    }
    expect(computeOverallHealth(log, now).level).not.toBe('ok');
  });
});
