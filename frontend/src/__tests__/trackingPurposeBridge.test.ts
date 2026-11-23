/* eslint-disable @typescript-eslint/no-require-imports */
describe('reason-aware acquisition stays behind native arbitration', () => {
  const now = Date.parse('2026-11-23T19:41:42Z');
  let module: any;
  let reliability: typeof import('../trackingReliability');
  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers().setSystemTime(now);
    module = {
      trackingRead: jest.fn(() => JSON.stringify({ owner: 'owner:member', generation: 13, revoked: false })),
      trackingClaimPurpose: jest.fn(() => false),
      trackingClaim: jest.fn(() => false),
      trackingClaimConfiguration: jest.fn(),
      trackingRecord: jest.fn(),
      motionRecoveryMaintain: jest.fn(() => 'requested'),
    };
    jest.doMock('expo', () => ({ requireOptionalNativeModule: () => module }));
    reliability = require('../trackingReliability');
  });
  afterEach(() => { jest.useRealTimers(); jest.dontMock('expo'); });
  it.each(['explicit', 'recovery', 'watchdog'] as const)('passes %s to the real native gate, never the configuration bypass', purpose => {
    expect(reliability.claimTrackingAcquisition('owner:member', 13, 'op', 'evidence', purpose)).toBe(false);
    expect(module.trackingClaimPurpose).toHaveBeenCalledWith('owner:member', 13, 'op', now, 'evidence', purpose);
    expect(module.trackingClaimConfiguration).not.toHaveBeenCalled();
  });
  it('retains conservative legacy admission on Build 82', () => {
    delete module.trackingClaimPurpose;
    expect(reliability.claimTrackingAcquisition('owner:member', 13, 'op', null, 'explicit')).toBe(false);
    expect(module.trackingClaim).toHaveBeenCalledWith('owner:member', 13, 'op', now);
    expect(module.trackingClaimConfiguration).not.toHaveBeenCalled();
  });
  it('maintains motion registration for a live owner without mutating moving or starting an SDK', () => {
    reliability.maintainNativeMotionRecovery();
    expect(module.motionRecoveryMaintain).toHaveBeenCalledWith('owner:member', 13);
    module.trackingRead.mockReturnValue(JSON.stringify({ owner: 'owner:member', generation: 14, revoked: true }));
    reliability.maintainNativeMotionRecovery();
    expect(module.motionRecoveryMaintain).toHaveBeenCalledTimes(1);
  });
  it('does not let failed maintenance throw or certify sustained health', () => {
    module.motionRecoveryMaintain.mockImplementation(() => { throw new Error('Play Services unavailable'); });
    expect(() => reliability.maintainNativeMotionRecovery()).not.toThrow();
    expect(module.trackingRecord).toHaveBeenCalledWith('motion_monitor_maintenance', JSON.stringify({ reason: 'failed' }));
    const report = reliability.describeOperationalRecovery('already_enabled', {
      owner: 'owner:member', generation: 13, revoked: false, moving: false,
      capturedAt: now - 43 * 60_000, outcome: 'fresh_fix_delivered',
    }, now);
    expect(report.state).toBe('LOCATION_DUE_STALE');
    expect(report.sustainedTracking).toBe('not_proven');
  });
});
