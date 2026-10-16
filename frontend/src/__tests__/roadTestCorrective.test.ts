import { computeOverallHealth } from '../healthCheck';
import { verifiedDelivery } from '../verifiedDelivery';
import { beginDiagnosticsExport } from '../diagnosticsExportLock';
import type { EngineLogEvent } from '../locationEngine';

const now = 1_792_180_000_000;
const event = (name: string, at: number, detail: any = {}): EngineLogEvent =>
  ({ seq: at, src: 'engine', at, event: name, detail });
const owner = { owner: 'user:member', generation: 1, revoked: false };
const receipt = { id: 'member', user_id: 'user', location_write_accepted: true,
  location_write_rejection_reason: null, location_write_capture_uuid: 'fix',
  location_write_captured_at: new Date(now).toISOString() };

describe('road-test diagnostic truth', () => {
  it.each([{ log: [] }, { log: [event('sdk_onHttp', now, { success: true })] },
    { log: [event('verified_coordinate_publication', now, { origin: 'one-shot', capturedAt: now })] },
  ])('contact and foreground acquisition cannot establish background health: %j', ({ log }) => {
    expect(computeOverallHealth(log, now, now, now).level).not.toBe('ok');
    expect(computeOverallHealth(log, now, now, now).headline).not.toMatch(/healthy/);
  });
  it('rejects HTTP success, missing provenance, rejection and wrong owner as coordinate evidence', () => {
    expect(verifiedDelivery({ ...receipt, location_write_accepted: false }, 'background', owner)).toBeNull();
    expect(verifiedDelivery({ ...receipt, location_write_captured_at: null }, 'background', owner)).toBeNull();
    expect(verifiedDelivery({ ...receipt, user_id: 'replacement' }, 'background', owner)).toBeNull();
    expect(verifiedDelivery(receipt, 'background', { ...owner, revoked: true })).toBeNull();
    expect(verifiedDelivery(receipt, 'background', owner, now)?.origin).toBe('native-receipt');
  });
  it('callback completion in background is not background capture evidence', () => {
    const d = verifiedDelivery(receipt, 'background', owner, now)!;
    const log = [event('verified_coordinate_publication', now - 65_000,
      { ...d, capturedAt: now - 65_000 }), event('verified_coordinate_publication', now, d),
    event('sdk_state_observed', now, { ...owner, enabled: true })];
    expect(computeOverallHealth(log, now).level).not.toBe('ok');
  });
  it('requires correlated repeated captures in one current native lifetime', () => {
    const records = [65_000, 0].flatMap((ago, i) => [
      event('native_capture_observed', now - ago, {
        ...owner, origin: 'background', captureId: `fix${i}`, capturedAt: now - ago }),
      event('verified_coordinate_publication', now - ago, {
        ...owner, origin: 'native-receipt', captureId: `fix${i}`, capturedAt: now - ago }),
    ]);
    records.push(event('sdk_state_observed', now, { ...owner, enabled: true }));
    expect(computeOverallHealth(records, now).level).toBe('ok');
    records.push(event('sdk_state_observed', now, { ...owner, generation: 2, enabled: true }));
    expect(computeOverallHealth(records, now).level).not.toBe('ok');
  });
  it('cannot reuse old consent-lifetime evidence after server consent renews without a local epoch change', () => {
    const records = [65_000, 0].flatMap((ago, i) => [
      event('native_capture_observed', now - ago, { ...owner, consentGeneration: i,
        origin: 'background', captureId: `fix${i}`, capturedAt: now - ago }),
      event('verified_coordinate_publication', now - ago, { ...owner, consentGeneration: i,
        origin: 'native-receipt', captureId: `fix${i}`, capturedAt: now - ago }),
    ]);
    records.push(event('sdk_state_observed', now, { ...owner, consentGeneration: 1, enabled: true }));
    expect(computeOverallHealth(records, now).level).not.toBe('ok');
  });
  it('shows canonical accepted capture separately even if no background-origin receipt exists', () => {
    const { locationEvidenceSummary } = require('../locationEvidenceSummary');
    const summary = locationEvidenceSummary([event('sdk_onHttp', now, { success: true })], now, now - 60_000);
    expect(summary.capture).toBe(now - 60_000);
    expect(summary.background).toBeNull();
    expect(summary.foreground).toBeNull();
  });
});

describe('export exclusion covers collection and chooser', () => {
  it('rejects rapid double entry, permits cancel/failure/completion retry, and release is idempotent', () => {
    const first = beginDiagnosticsExport()!;
    expect(beginDiagnosticsExport()).toBeNull();
    first();
    const second = beginDiagnosticsExport()!;
    first();
    expect(beginDiagnosticsExport()).toBeNull();
    second();
    const third = beginDiagnosticsExport();
    expect(third).not.toBeNull();
    third!();
  });
});

describe('native configuration exclusion (contract model, not device proof)', () => {
  beforeEach(() => jest.resetModules());
  it('does not steal a GPS operation or reset its failure backoff', async () => {
    const n = require('../__mocks__/trackingNative').trackingNative;
    n.trackingAuthorize('user:member', 0);
    expect(n.trackingClaim('user:member', 0, 'gps', Date.now())).toBe(true);
    expect(n.trackingClaimConfiguration('user:member', 0, 'config', Date.now())).toBe(true);
    expect(n.trackingClaimConfiguration('user:member', 0, 'another', Date.now())).toBe(false);
    n.trackingComplete('config', 'operation_discarded', 0, false);
    expect(JSON.parse(n.trackingRead()).operation).toBe('gps');
    n.trackingComplete('gps', 'degraded', 0, false);
    const cooldown = JSON.parse(n.trackingRead()).nextEligibleAt;
    expect(n.trackingClaimConfiguration('user:member', 0, 'retry-ready', Date.now())).toBe(true);
    n.trackingComplete('retry-ready', 'operation_discarded', 0, false);
    expect(JSON.parse(n.trackingRead()).nextEligibleAt).toBe(cooldown);
    n.trackingRevoke('consent');
    expect(n.trackingClaimConfiguration('user:member', 0, 'obsolete', Date.now())).toBe(false);
  });
});
