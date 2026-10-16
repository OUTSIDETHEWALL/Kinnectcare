/* eslint-disable @typescript-eslint/no-require-imports */
describe('authorized tracker lifetime is independent of operation lifetime', () => {
  beforeEach(() => jest.resetModules());

  it.each(['obsolete', 'lookup throws'])('does not stop for %s before native entry', async reason => {
    const { fenceNativeSdk } = require('../androidNativeShutdown');
    const sdk = { stop: jest.fn(), getCurrentPosition: jest.fn() };
    const current = async () => { if (reason === 'lookup throws') throw new Error('storage'); return false; };
    await expect(fenceNativeSdk(sdk, current).getCurrentPosition()).rejects.toThrow();
    expect(sdk.stop).not.toHaveBeenCalled();
    expect(sdk.getCurrentPosition).not.toHaveBeenCalled();
  });

  it('discards a late callback without stopping an authorized replacement', async () => {
    const { fenceNativeSdk } = require('../androidNativeShutdown');
    let finish!: (value: unknown) => void;
    let current = true;
    const sdk = { stop: jest.fn(), getCurrentPosition: jest.fn(() => new Promise(resolve => { finish = resolve; })) };
    const result = fenceNativeSdk(sdk, async () => current, () => current, async () => false).getCurrentPosition();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    current = false;
    finish({ timestamp: new Date().toISOString() });
    await expect(result).rejects.toThrow('native_operation_obsolete');
    expect(sdk.stop).not.toHaveBeenCalled();
  });

  it('reissues shutdown only for a late mutating start while revocation still holds', async () => {
    const { fenceNativeSdk } = require('../androidNativeShutdown');
    let current = true;
    const sdk = { stop: jest.fn(async () => {}), start: jest.fn(async () => { current = false; }) };
    await expect(fenceNativeSdk(sdk, async () => current, () => current, async () => true).start()).rejects.toThrow();
    expect(sdk.stop).toHaveBeenCalledTimes(1);
  });

  it('holds the configuration gate through late-callback revocation cleanup', async () => {
    const { fenceNativeSdk } = require('../androidNativeShutdown');
    const { trackingNative } = require('../__mocks__/trackingNative');
    const { withTrackingConfiguration } = require('../trackingReliability');
    trackingNative.trackingAuthorize('owner:member', 0);
    let releaseStop!: () => void;
    let stopEntered!: () => void;
    const entered = new Promise<void>(resolve => { stopEntered = resolve; });
    let current = true;
    const sdk = {
      start: jest.fn(async () => { current = false; trackingNative.trackingRevoke('signout'); }),
      stop: jest.fn(() => { stopEntered(); return new Promise<void>(resolve => { releaseStop = resolve; }); }),
      destroyLocations: jest.fn(async () => {}),
    };
    const result = fenceNativeSdk(sdk, async () => current, () => current,
      async () => true, withTrackingConfiguration).start();
    const assertion = expect(result).rejects.toThrow('native_operation_obsolete');
    await entered;
    expect(JSON.parse(trackingNative.trackingRead()).pendingMutation).toBeTruthy();
    trackingNative.trackingAuthorize('replacement:member', 1);
    expect(JSON.parse(trackingNative.trackingRead()).revoked).toBe(true);
    releaseStop();
    await assertion;
    expect(sdk.destroyLocations).toHaveBeenCalledTimes(1);
    expect(JSON.parse(trackingNative.trackingRead()).pendingMutation).toBeUndefined();
    trackingNative.trackingAuthorize('replacement:member', 1);
    expect(JSON.parse(trackingNative.trackingRead()).owner).toBe('replacement:member');
  });
});

describe('tri-state authorization', () => {
  let storage: Map<string, string>;
  let permission: any;
  let policy: typeof import('../androidTrackingRecovery');
  const fetchBefore = global.fetch;
  const baseBefore = process.env.EXPO_PUBLIC_BACKEND_URL;
  beforeEach(() => {
    jest.resetModules();
    storage = new Map();
    permission = { foreground: 'granted', background: 'granted' };
    process.env.EXPO_PUBLIC_BACKEND_URL = 'https://example.test';
    jest.doMock('@react-native-async-storage/async-storage', () => ({
      getItem: jest.fn(async (key: string) => storage.get(key) ?? null),
      setItem: jest.fn(async (key: string, value: string) => { storage.set(key, value); }),
    }));
    jest.doMock('../permissionCoordinator', () => ({
      readPermissionSnapshot: jest.fn(async () => permission),
    }));
    jest.doMock('../backgroundLocationDisclosure', () => ({
      BACKGROUND_LOCATION_DISCLOSURE_TEXT: 'Test disclosure',
    }));
    jest.doMock('../api', () => ({ getCurrentToken: async () => 'token' }));
    global.fetch = jest.fn(async (url: any) => ({
      ok: true, json: async () => String(url).endsWith('/auth/me') ? { id: 'owner' }
        : String(url).endsWith('/members') ? [{ id: 'member', user_id: 'owner' }]
          : { location_sharing_enabled: true },
    })) as any;
    policy = require('../androidTrackingRecovery');
  });
  afterEach(() => {
    global.fetch = fetchBefore;
    process.env.EXPO_PUBLIC_BACKEND_URL = baseBefore;
  });

  it('authorizes only affirmative owner/permission/sharing evidence', async () => {
    expect((await policy.evaluateWakeAuthorization(() => true)).state).toBe('AUTHORIZED');
  });
  it.each(['storage', 'network', 'malformed'])('returns UNKNOWN for %s failures', async kind => {
    if (kind === 'storage') {
      require('@react-native-async-storage/async-storage').getItem.mockRejectedValue(new Error('storage'));
    } else if (kind === 'network') {
      (global.fetch as jest.Mock).mockRejectedValue(new Error('network'));
    } else {
      (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({}) });
    }
    expect((await policy.evaluateWakeAuthorization(() => true)).state).toBe('UNKNOWN');
  });
  it('undetermined OS state is UNKNOWN, not withdrawal', async () => {
    permission.background = 'undetermined';
    expect((await policy.evaluateWakeAuthorization(() => true)).state).toBe('UNKNOWN');
  });
  it('confirmed denied permission is REVOKED', async () => {
    permission.background = 'denied';
    expect(await policy.evaluateWakeAuthorization(() => true)).toMatchObject({ state: 'REVOKED', reason: 'permission' });
  });
  it('generic endpoint 403 is UNKNOWN, not sign-out', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 403 });
    expect((await policy.evaluateWakeAuthorization(() => true)).state).toBe('UNKNOWN');
  });
  it('only the session endpoint 401 confirms session revocation', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 401 });
    expect(await policy.evaluateWakeAuthorization(() => true)).toMatchObject({ state: 'REVOKED', reason: 'signout' });
  });
  it('obsolete reconciliation is UNKNOWN', async () => {
    expect((await policy.evaluateWakeAuthorization(() => false)).state).toBe('UNKNOWN');
  });
});

describe('native contract model: owner-scoped acquisition and bounded backoff', () => {
  let native: typeof import('../__mocks__/trackingNative').trackingNative;
  const now = new Date('2026-10-14T12:00:00Z').getTime();
  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers().setSystemTime(now);
    native = require('../__mocks__/trackingNative').trackingNative;
    native.trackingAuthorize('owner:member', 0);
  });
  afterEach(() => jest.useRealTimers());
  it('coalesces concurrent push, WorkManager and SDK wakes', () => {
    expect(native.trackingClaim('owner:member', 0, 'push', now)).toBe(true);
    expect(native.trackingClaim('owner:member', 0, 'work', now)).toBe(false);
    expect(native.trackingClaim('owner:member', 0, 'sdk', now)).toBe(false);
    expect(native.trackingClaimConfiguration('owner:member', 0, 'foreground', now)).toBe(true);
    expect(JSON.parse(native.trackingRead()).operation).toBe('push');
    native.trackingComplete('foreground', 'operation_discarded', 0, false);
    expect(JSON.parse(native.trackingRead()).operation).toBe('push');
  });
  it('caps consecutive failures at 5, 15, then 30 minutes', () => {
    for (const [index, minutes] of [5, 15, 30, 30].entries()) {
      expect(native.trackingClaim('owner:member', 0, `op${index}`, Date.now())).toBe(true);
      native.trackingComplete(`op${index}`, 'degraded', 0, false);
      expect(JSON.parse(native.trackingRead()).nextEligibleAt - Date.now()).toBe(minutes * 60_000);
      jest.advanceTimersByTime(minutes * 60_000);
    }
  });
  it('records a one-shot separately from ordinary subsequent delivery', () => {
    native.trackingClaim('owner:member', 0, 'push', now);
    native.trackingComplete('push', 'fresh_fix_delivered', now, false);
    expect(JSON.parse(native.trackingRead())).toMatchObject({ outcome: 'fresh_fix_delivered', failures: 0 });
    expect(JSON.parse(native.trackingRead()).ordinaryDeliveryAt).toBeUndefined();
    native.trackingObserve('owner:member', 0, now + 10_000, false);
    expect(JSON.parse(native.trackingRead()).ordinaryDeliveryAt).toBe(now + 10_000);
    const report = require('../trackingReliability').describeOperationalRecovery(
      'already_enabled', JSON.parse(native.trackingRead()), now + 10_000,
    );
    expect(report.state).toBe('RECENT_LOCATION_VERIFIED');
    expect(report.sustainedTracking).toBe('not_proven');
  });
  it.each([
    ['obsolete generation', 1, 'owner', 0],
    ['different owner', 0, 'other-owner', 0],
    ['future capture', 0, 'owner', 6000],
  ])('does not adopt accepted tuple evidence from %s', (_reason, generation, userId, offset) => {
    require('../trackingReliability').observeAcceptedTrackingLocation({
      id: 'member', user_id: userId,
      coordinate_captured_at: new Date(now + Number(offset)).toISOString(),
    }, 'owner:member', generation);
    expect(JSON.parse(native.trackingRead()).capturedAt).toBeUndefined();
  });
  it('revocation fences late completion and wrong-owner claims', () => {
    native.trackingClaim('owner:member', 0, 'old', now);
    native.trackingRevoke('signout');
    native.trackingComplete('old', 'fresh_fix_delivered', now, false);
    expect(JSON.parse(native.trackingRead()).revoked).toBe(true);
    expect(native.trackingClaim('other:member', 0, 'new', now)).toBe(false);
  });
  it('preserves authorized state after FGS denial', () => {
    native.trackingClaim('owner:member', 0, 'blocked', now);
    native.trackingComplete('blocked', 'background_start_blocked', 0, false);
    expect(JSON.parse(native.trackingRead())).toMatchObject({ revoked: false, outcome: 'background_start_blocked' });
  });
  it('does not allow owner replacement without prior revocation', () => {
    native.trackingAuthorize('other:member', 0);
    expect(JSON.parse(native.trackingRead()).owner).toBe('owner:member');
  });
  it('does not interpret configured/enabled as capture evidence', () => {
    expect(JSON.parse(native.trackingRead()).capturedAt).toBeUndefined();
    expect(native.trackingClaim('owner:member', 0, 'verify', now)).toBe(true);
  });
  it('reports absent binary support explicitly instead of creating fake authority', () => {
    jest.doMock('expo', () => ({ requireOptionalNativeModule: () => null }));
    const reliability = require('../trackingReliability');
    expect(reliability.readTrackingAuthority()).toBeNull();
    expect(() => reliability.claimTrackingAcquisition('owner:member', 0, 'missing')).toThrow('tracking_native_extension_required');
  });
  it('stationary/unknown fresh delivery avoids repeated GPS until due', () => {
    native.trackingClaim('owner:member', 0, 'one', now);
    native.trackingComplete('one', 'fresh_fix_delivered', now, false);
    expect(native.trackingClaim('owner:member', 0, 'early', now + 59 * 60_000)).toBe(false);
    expect(native.trackingClaim('owner:member', 0, 'due', now + 60 * 60_000)).toBe(true);
  });
  it('recent movement evidence uses the earlier ten-minute window', () => {
    native.trackingObserve('owner:member', 0, now - 11 * 60_000, false);
    native.trackingMovement('owner:member', 0, true);
    expect(native.trackingClaim('owner:member', 0, 'moving', now)).toBe(true);
  });
  it('does not rebind until confirmed shutdown has completed', () => {
    native.trackingRevoke('replacement');
    native.trackingAuthorize('other:member', 1);
    expect(JSON.parse(native.trackingRead()).revoked).toBe(true);
    native.trackingShutdownComplete(1);
    native.trackingAuthorize('other:member', 1);
    expect(JSON.parse(native.trackingRead())).toMatchObject({ owner: 'other:member', generation: 1, revoked: false });
  });
  it('waits for all overlapping destructive shutdown groups before rebinding', () => {
    native.trackingRevoke('replacement');
    expect(native.trackingShutdownBegin(1, 'stop')).toBe(true);
    expect(native.trackingShutdownBegin(1, 'purge')).toBe(true);
    native.trackingShutdownEnd('stop', true);
    native.trackingShutdownComplete(1);
    native.trackingAuthorize('other:member', 1);
    expect(JSON.parse(native.trackingRead()).revoked).toBe(true);
    native.trackingShutdownEnd('purge', true);
    native.trackingAuthorize('other:member', 1);
    expect(JSON.parse(native.trackingRead()).owner).toBe('other:member');
  });
  it('an obsolete operation cannot apply failure backoff to a newer claim', () => {
    native.trackingClaim('owner:member', 0, 'old', now);
    native.trackingClaim('owner:member', 0, 'new', now + 60_000);
    native.trackingComplete('old', 'degraded', 0, false);
    expect(JSON.parse(native.trackingRead()).failures).toBeUndefined();
  });
  it('quarantines a lost mutating callback across revocation and lease expiry', () => {
    expect(native.trackingClaimConfiguration('owner:member', 0, 'old-ready', now)).toBe(true);
    native.trackingRevoke('replacement');
    native.trackingShutdownComplete(1);
    jest.advanceTimersByTime(120_000);
    native.trackingAuthorize('new:member', 1);
    expect(JSON.parse(native.trackingRead()).revoked).toBe(true);
    native.trackingComplete('old-ready', 'operation_discarded', 0, false);
    native.trackingAuthorize('new:member', 1);
    expect(JSON.parse(native.trackingRead()).owner).toBe('new:member');
  });
});

describe('explicit operational recovery report', () => {
  const now = new Date('2026-10-14T12:00:00Z').getTime();
  const describeRecovery = (result: string, data: any) =>
    require('../trackingReliability').describeOperationalRecovery(result, data, now);
  const authority = { generation: 1, owner: 'owner:member', revoked: false };

  it('enabled with no delivery is configured, not healthy', () => {
    expect(describeRecovery('already_enabled', authority)).toMatchObject({
      authorization: 'AUTHORIZED', state: 'CONFIGURED_UNVERIFIED',
      upload: 'unverified', sustainedTracking: 'not_proven',
    });
  });
  it('missing native support cannot authorize recovery', () => {
    expect(describeRecovery('already_enabled', null).authorization).toBe('UNKNOWN');
  });
  it('enabled with old capture is due despite continued device communication', () => {
    expect(describeRecovery('already_enabled', { ...authority, capturedAt: now - 61 * 60_000 }).state)
      .toBe('LOCATION_DUE_STALE');
  });
  it('one-shot delivery remains distinct from sustained tracking', () => {
    expect(describeRecovery('already_enabled', { ...authority, capturedAt: now, outcome: 'fresh_fix_delivered' }))
      .toMatchObject({ state: 'FRESH_FIX_DELIVERED', sustainedTracking: 'not_proven' });
  });
  it('FGS denial preserves authorization and reports bounded next eligibility', () => {
    expect(describeRecovery('already_enabled', {
      ...authority, outcome: 'background_start_blocked', nextEligibleAt: now + 300_000,
    })).toMatchObject({
      authorization: 'AUTHORIZED', state: 'BACKGROUND_START_BLOCKED',
      androidRestriction: 'background_start_blocked', nextEligibleAt: now + 300_000,
    });
  });
});
