/* eslint-disable @typescript-eslint/no-require-imports */
/** JS race coverage with a shared native-contract model, not native-runtime proof. */
describe('B1: async evidence belongs to its requesting authority', () => {
  const baseBefore = process.env.EXPO_PUBLIC_BACKEND_URL;
  const fetchBefore = global.fetch;
  const base = 'https://example.test';
  const configA = { ownerUserId: 'A', memberId: 'member-A', backendBaseUrl: base };
  const configB = { ownerUserId: 'B', memberId: 'member-B', backendBaseUrl: base };
  let native: any;
  let policy: typeof import('../androidTrackingRecovery');
  let store: Map<string, string>;
  let storage: any;
  let permissions: any;
  let sdk: any;
  let token: string;
  let user: any;
  let members: any[];
  let enabled: boolean;
  let sdkMember: string;
  let permissionRead: number;
  let consentRead: number;

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return { promise, resolve };
  }
  function state() { return JSON.parse(native.trackingRead()); }

  beforeEach(async () => {
    jest.resetModules();
    native = require('../__mocks__/trackingNative').trackingNative;
    jest.doMock('expo', () => ({ requireOptionalNativeModule: () => native }));
    process.env.EXPO_PUBLIC_BACKEND_URL = base;
    store = new Map();
    token = 'token-A'; user = { id: 'A' };
    members = [{ id: 'member-A', user_id: 'A' }];
    enabled = true; sdkMember = 'member-A'; permissionRead = 0; consentRead = 0;
    storage = {
      getItem: jest.fn(async (key: string) => {
        if (key === '@kinnship/location_sharing_off_v1') consentRead++;
        return store.get(key) ?? null;
      }),
      setItem: jest.fn(async (key: string, value: string) => { store.set(key, value); }),
      removeItem: jest.fn(async (key: string) => { store.delete(key); }),
    };
    permissions = { readPermissionSnapshot: jest.fn(async () => {
      permissionRead++;
      return { foreground: 'granted', background: 'granted' };
    }) };
    jest.doMock('@react-native-async-storage/async-storage', () => storage);
    jest.doMock('../permissionCoordinator', () => permissions);
    jest.doMock('../backgroundLocationDisclosure', () => ({ BACKGROUND_LOCATION_DISCLOSURE_TEXT: 'disclosure' }));
    jest.doMock('../api', () => ({
      getCurrentToken: jest.fn(async () => token),
      api: { get: jest.fn(async (path: string) => ({ data: path === '/auth/me' ? user
        : path === '/members' ? members : { location_sharing_enabled: true } })) },
    }));
    jest.doMock('react-native', () => ({
      Platform: { OS: 'android' }, AppState: { currentState: 'background' },
    }));
    sdk = {
      stop: jest.fn(async () => { enabled = false; }),
      destroyLocations: jest.fn(async () => {}),
      getState: jest.fn(async () => ({ enabled, url: `${base}/api/members/${sdkMember}/location`,
        authorization: { accessToken: token } })),
      setConfig: jest.fn(async () => {}),
      start: jest.fn(async () => ({ enabled: enabled = true })),
      ready: jest.fn(async () => ({ enabled })),
      registerHeadlessTask: jest.fn(),
      getCurrentPosition: jest.fn(async () => ({
        timestamp: new Date().toISOString(), coords: { latitude: 1, longitude: 2 },
      })),
    };
    jest.doMock('react-native-background-geolocation', () => ({ default: sdk }));
    global.fetch = jest.fn(async (url: any) => ({
      ok: true, status: 200, json: async () => String(url).endsWith('/auth/me') ? user
        : String(url).endsWith('/members') ? members : { location_sharing_enabled: true },
    })) as any;
    policy = require('../androidTrackingRecovery');
    await policy.authorizeTrackingIntent(configA, 0, () => true);
    storage.setItem.mockClear();
  });

  afterEach(() => {
    global.fetch = fetchBefore;
    if (baseBefore === undefined) delete process.env.EXPO_PUBLIC_BACKEND_URL;
    else process.env.EXPO_PUBLIC_BACKEND_URL = baseBefore;
    jest.dontMock('expo');
  });

  /** Separate JS module state, sharing the same native state and storage. */
  async function replaceFromOtherRuntime(clearVerification = false) {
    if (clearVerification) await policy.revokeTrackingIntent('stopped');
    else native.trackingRevoke('stopped');
    native.trackingShutdownComplete(state().generation);
    token = 'token-B'; user = { id: 'B' }; members = [{ id: 'member-B', user_id: 'B' }];
    sdkMember = 'member-B';
    let other!: typeof policy;
    jest.isolateModules(() => { other = require('../androidTrackingRecovery'); });
    await other.authorizeTrackingIntent(configB, state().generation, () => true);
    enabled = true;
    native.trackingObserve('B:member-B', state().generation, Date.now(), false);
    sdk.stop.mockClear(); sdk.destroyLocations.mockClear(); storage.setItem.mockClear();
    return { authority: native.trackingRead(), intent: store.get(policy.TRACKING_INTENT_KEY) };
  }
  function expectBUnchanged(before: { authority: string; intent: string | undefined }) {
    expect(native.trackingRead()).toBe(before.authority);
    expect(state()).toMatchObject({ owner: 'B:member-B', revoked: false });
    expect(enabled).toBe(true);
    expect(sdk.stop).not.toHaveBeenCalled();
    expect(sdk.destroyLocations).not.toHaveBeenCalled();
    expect(storage.setItem.mock.calls.filter(([key]: [string]) =>
      key === policy.TRACKING_INTENT_KEY)).toHaveLength(0);
    expect(store.get(policy.TRACKING_INTENT_KEY)).toBe(before.intent);
  }

  it('discards the original delayed acquisition denial without touching B', async () => {
    const gate = deferred<any>(); const entered = deferred<void>();
    permissions.readPermissionSnapshot.mockImplementationOnce(() => { entered.resolve(); return gate.promise; });
    const engine = require('../locationEngine');
    const acquisition = require('../androidLocationAcquisition').acquireAndUploadAndroidPosition;
    const pending = acquisition(sdk, { token, memberId: 'member-A', baseUrl: base,
      isCurrent: async () => true }, {}, () => true,
    (reason: any, expected: any) => engine.stop(reason, 'b1-test', expected));
    const rejection = expect(pending).rejects.toThrow('gps_authorization_unverified');
    await entered.promise;
    const before = await replaceFromOtherRuntime();
    gate.resolve({ foreground: 'granted', background: 'denied' });
    await rejection;
    expectBUnchanged(before);
    expect(sdk.getCurrentPosition).not.toHaveBeenCalled();
  });

  it.each([false, true])('recovery discards delayed denial (verification cleared=%s)', async clear => {
    const gate = deferred<any>(); const entered = deferred<void>();
    permissions.readPermissionSnapshot.mockImplementationOnce(() => { entered.resolve(); return gate.promise; });
    const pending = policy.recoverUnexpectedlyDisabledTracking(sdk, () => true);
    await entered.promise;
    const before = await replaceFromOtherRuntime(clear);
    gate.resolve({ foreground: 'granted', background: 'denied' });
    expect(await pending).toBe('obsolete_owner');
    expectBUnchanged(before);
  });

  it('acquisition discards delayed remote-consent storage evidence after B replaces A', async () => {
    const gate = deferred<string>(); const entered = deferred<void>();
    let holdConsent = false;
    const fetchOriginal = global.fetch as jest.Mock;
    fetchOriginal.mockImplementation(async (url: string) => ({
      ok: true, status: 200, json: async () => {
        if (url.endsWith('/members')) { holdConsent = true; return members; }
        return url.endsWith('/auth/me') ? user : { location_sharing_enabled: true };
      },
    }));
    storage.getItem.mockImplementation(async (key: string) => {
      if (key === '@kinnship/location_sharing_off_v1' && holdConsent) {
        holdConsent = false; entered.resolve(); return gate.promise;
      }
      return store.get(key) ?? null;
    });
    const engine = require('../locationEngine');
    const acquisition = require('../androidLocationAcquisition').acquireAndUploadAndroidPosition;
    const pending = acquisition(sdk, { token, memberId: 'member-A', baseUrl: base,
      isCurrent: async () => true }, {}, () => true,
    (reason: any, expected: any) => engine.stop(reason, 'b1-test', expected));
    const rejection = expect(pending).rejects.toThrow(/gps_authorization_(obsolete|unverified)/);
    await entered.promise;
    const before = await replaceFromOtherRuntime();
    gate.resolve('1');
    await rejection;
    expectBUnchanged(before);
    expect(sdk.getCurrentPosition).not.toHaveBeenCalled();
    expect(fetchOriginal.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(0);
  });

  it.each([2, 3, 4])('discards delayed consent read at recovery phase %s', async phase => {
    if (phase >= 3) enabled = false; // Reach setConfig/start rather than already-enabled return.
    const gate = deferred<string>(); const entered = deferred<void>();
    storage.getItem.mockImplementation(async (key: string) => {
      if (key === '@kinnship/location_sharing_off_v1' && ++consentRead === phase) {
        entered.resolve(); return gate.promise;
      }
      return store.get(key) ?? null;
    });
    const pending = policy.recoverUnexpectedlyDisabledTracking(sdk, () => true);
    await entered.promise;
    const before = await replaceFromOtherRuntime();
    gate.resolve('1');
    expect(await pending).toBe('obsolete_owner');
    expectBUnchanged(before);
  });

  it('a changed verification cache cannot supply B as the binding for A withdrawal', async () => {
    const gate = deferred<any>(); const entered = deferred<void>();
    permissions.readPermissionSnapshot.mockImplementationOnce(() => { entered.resolve(); return gate.promise; });
    const pending = policy.recoverUnexpectedlyDisabledTracking(sdk, () => true);
    await entered.promise;
    await replaceFromOtherRuntime();
    expect(await policy.recoverUnexpectedlyDisabledTracking(sdk, () => true)).toBe('already_enabled');
    sdk.stop.mockClear(); sdk.destroyLocations.mockClear(); storage.setItem.mockClear();
    const before = { authority: native.trackingRead(), intent: store.get(policy.TRACKING_INTENT_KEY) };
    gate.resolve({ foreground: 'granted', background: 'denied' });
    expect(await pending).toBe('obsolete_owner');
    expectBUnchanged(before);
  });

  it('ownedNativeSdk rejects its delayed permission callback after cross-runtime replacement', async () => {
    const gate = deferred<any>(); const entered = deferred<void>();
    permissions.readPermissionSnapshot.mockImplementation(async () => {
      if (++permissionRead === 4) { entered.resolve(); return gate.promise; }
      return { foreground: 'granted', background: 'granted' };
    });
    const engine = require('../locationEngine');
    const pending = engine.recoverFromIndependentWake('b1-owned-native-test');
    await entered.promise;
    const before = await replaceFromOtherRuntime();
    gate.resolve({ foreground: 'granted', background: 'denied' });
    await pending;
    expectBUnchanged(before);
  });

  it('native CAS refuses replacement at the last instant before destructive mutation', async () => {
    const expected = state();
    const original = native.trackingRevokeIfCurrent.bind(native);
    let before: any;
    jest.spyOn(native, 'trackingRevokeIfCurrent').mockImplementation((...args: any[]) => {
      native.trackingRevoke('stopped'); native.trackingShutdownComplete(state().generation);
      native.trackingAuthorize('B:member-B', state().generation);
      before = { authority: native.trackingRead(), intent: store.get(policy.TRACKING_INTENT_KEY) };
      return original(...args);
    });
    const shutdown = jest.fn(async () => { await sdk.stop(); await sdk.destroyLocations(); });
    expect(await policy.revokeTrackingIntentIfCurrent(expected, 'consent', shutdown)).toBe(false);
    expect(shutdown).not.toHaveBeenCalled();
    expectBUnchanged(before);
  });

  it.each(['signout', 'consent', 'permission', 'stopped'] as const)(
    'still shuts down the matching owner immediately for %s', async reason => {
      const expected = state();
      expect(await policy.revokeTrackingIntentIfCurrent(expected, reason, async () => {
        expect(state()).toMatchObject({ revoked: true, generation: expected.generation + 1, shutdownPending: true });
        // Another runtime cannot rebind between CAS and SDK completion.
        native.trackingAuthorize('B:member-B', state().generation);
        expect(state().revoked).toBe(true);
        await sdk.stop(); await sdk.destroyLocations();
      })).toBe(true);
      expect(enabled).toBe(false);
      expect(sdk.stop).toHaveBeenCalledTimes(1);
      expect(sdk.destroyLocations).toHaveBeenCalledTimes(1);
      expect(state()).toMatchObject({ owner: '', revoked: true, shutdownPending: false });
      // Native persisted state is the authority; no deferred revoked intent write.
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(await policy.trackingIsRevoked()).toBe(true);
    },
  );

  it('conditional consent stays sticky until explicit rearm', async () => {
    await policy.revokeTrackingIntentIfCurrent(state(), 'consent', async () => { await sdk.stop(); });
    expect(await policy.trackingIsRevoked(true)).toBe(true);
    native.trackingAuthorize('A:member-A', state().generation);
    expect(state().revoked).toBe(true);
    await policy.rearmTrackingConsent();
    await policy.authorizeTrackingIntent(configA, state().generation, () => true);
    expect(state()).toMatchObject({ owner: 'A:member-A', revoked: false });
  });

  it('native source places expected-authority comparison and shutdown reservation under its shared lock', () => {
    const fs = require('fs');
    const source = fs.readFileSync(require('path').join(__dirname,
      '../../modules/startup-diagnostics/android/src/main/java/expo/modules/startupdiagnostics/TrackingReliability.kt'), 'utf8');
    const cas = source.slice(source.indexOf('fun revokeIfCurrent'), source.indexOf('fun rearmConsent'));
    expect(cas).toContain('= synchronized(lock)');
    expect(cas).toContain('s.getLong("generation") != generation || s.optString("owner") != owner');
    expect(cas).toContain('revokeState(context, reason, operation)');
    expect(source).toContain('shutdowns.put(operation, processIncarnation)');
    // Static contract assertion only: compilation/threading still need native validation.
  });
});
