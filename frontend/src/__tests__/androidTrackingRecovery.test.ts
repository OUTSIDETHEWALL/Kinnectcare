/* eslint-disable @typescript-eslint/no-require-imports */
describe('owned Android cold tracking recovery', () => {
  let store: Map<string, string>;
  let sdk: any;
  let recovery: typeof import('../androidTrackingRecovery');
  let token: string | null;
  let permissions: { foreground: string; background: string; notifications: string };
  let user: any;
  let members: any[];
  let sharing: boolean;
  let enabled: boolean;
  const originalFetch = global.fetch;
  const originalBase = process.env.EXPO_PUBLIC_BACKEND_URL;
  const config = {
    ownerUserId: 'owner-a', memberId: 'member-a', backendBaseUrl: 'https://example.test',
  };
  beforeEach(async () => {
    jest.resetModules();
    store = new Map();
    token = 'current-app-session';
    permissions = { foreground: 'granted', background: 'granted', notifications: 'denied' };
    user = { id: 'owner-a' };
    members = [{ id: 'member-a', user_id: 'owner-a' }];
    sharing = true;
    enabled = false;
    process.env.EXPO_PUBLIC_BACKEND_URL = config.backendBaseUrl;
    jest.doMock('@react-native-async-storage/async-storage', () => ({
      getItem: jest.fn(async key => store.get(key) ?? null),
      setItem: jest.fn(async (key, value) => { store.set(key, value); }),
      removeItem: jest.fn(async key => { store.delete(key); }),
    }));
    jest.doMock('../permissionCoordinator', () => ({
      readPermissionSnapshot: jest.fn(async () => ({ ...permissions })),
      serializePermissionOperation: (operation: () => Promise<unknown>) => operation(),
    }));
    jest.doMock('../api', () => ({
      getCurrentToken: jest.fn(async () => token),
      api: { get: jest.fn(async () => ({ data: { location_sharing_enabled: sharing } })) },
    }));
    jest.doMock('../backgroundLocationDisclosure', () => ({
      BACKGROUND_LOCATION_DISCLOSURE_TEXT: 'Kinnship background location disclosure',
    }));
    global.fetch = jest.fn(async url => ({
      ok: true,
      json: async () => String(url).endsWith('/auth/me') ? user
        : String(url).endsWith('/members') ? members : { location_sharing_enabled: sharing },
    })) as any;
    sdk = {
      getState: jest.fn(async () => ({
        enabled, url: 'https://example.test/api/members/member-a/location',
        authorization: { accessToken: token },
      })),
      setConfig: jest.fn(async () => {}),
      start: jest.fn(async () => { enabled = true; return { enabled }; }),
      stop: jest.fn(async () => { enabled = false; }),
      registerHeadlessTask: jest.fn(),
      getCurrentPosition: jest.fn(async () => ({ timestamp: new Date().toISOString(), coords: { accuracy: 10 } })),
    };
    jest.doMock('react-native', () => ({
      Platform: { OS: 'android' }, AppState: {
        currentState: 'background', addEventListener: jest.fn(() => ({ remove: jest.fn() })),
      },
    }));
    jest.doMock('react-native-background-geolocation', () => ({ default: sdk }));
    recovery = require('../androidTrackingRecovery');
    await recovery.authorizeTrackingIntent(config, recovery.trackingIntentEpoch(), () => true);
  });
  afterEach(() => {
    global.fetch = originalFetch;
    if (originalBase === undefined) delete process.env.EXPO_PUBLIC_BACKEND_URL;
    else process.env.EXPO_PUBLIC_BACKEND_URL = originalBase;
  });
  const run = (current = () => true) =>
    recovery.recoverUnexpectedlyDisabledTracking(sdk, current);

  it.each(['boot', 'terminate'])('restarts from the real %s headless handler without mounting UI', async name => {
    require('../locationEngine');
    const handler = sdk.registerHeadlessTask.mock.calls[0][0];
    await handler({ name });
    expect(sdk.start).toHaveBeenCalledTimes(1);
    await handler({ name });
    expect(sdk.start).toHaveBeenCalledTimes(1);
    expect(sdk.getCurrentPosition).not.toHaveBeenCalled();
  });

  it('serialized sign-out stops a late independent start and prevents another wake', async () => {
    const engine = require('../locationEngine') as typeof import('../locationEngine');
    let finish!: (value: { enabled: boolean }) => void;
    sdk.start.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = engine.recoverFromIndependentWake('workmanager');
    for (let i = 0; i < 200 && !sdk.start.mock.calls.length; i++) await Promise.resolve();
    expect(sdk.start).toHaveBeenCalled();
    const stopped = engine.stop();
    enabled = true;
    finish({ enabled: true });
    expect(await pending).toBe('late_start_stopped');
    await stopped;
    expect(enabled).toBe(false);
    expect(await engine.recoverFromIndependentWake('boot')).toBe('no_current_intent');
  });

  it.each([false, true])('actual independent battery wake recovers safely (permission denial=%s)', async denied => {
    let handler!: (id: string) => Promise<void>;
    const finish = jest.fn();
    jest.doMock('react-native-background-fetch', () => ({ default: {
      NETWORK_TYPE_ANY: 0, registerHeadlessTask: jest.fn(), finish,
      configure: jest.fn(async (_options, callback) => { handler = callback; return 2; }),
    } }));
    jest.doMock('expo-battery', () => ({
      BatteryState: { CHARGING: 2, FULL: 5 },
      getBatteryLevelAsync: jest.fn(async () => 0.8),
      getBatteryStateAsync: jest.fn(async () => 2),
    }));
    if (denied) permissions.background = 'denied';
    const battery = require('../batteryTask') as typeof import('../batteryTask');
    await battery.configureBatteryTask();
    await handler('independent-wake');
    expect(sdk.start).toHaveBeenCalledTimes(denied ? 0 : 1);
    expect(sdk.getCurrentPosition).toHaveBeenCalledTimes(denied ? 0 : 1);
    expect(finish).toHaveBeenCalledTimes(1);
    const log = JSON.parse(store.get('@kinnship/battery_task_log_v1') || '[]');
    expect(log.some((entry: any) => entry.event === 'background_battery_ok')).toBe(true);
    expect(log.some((entry: any) => entry.event === 'background_location_persisted')).toBe(!denied);
  });

  it('recovers from an independent authenticated wake with no heartbeat', async () => {
    expect(await run()).toBe('restarted');
    expect(sdk.start).toHaveBeenCalledTimes(1);
    expect(sdk.setConfig).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://example.test/api/members/member-a/location',
      authorization: { strategy: 'JWT', accessToken: token },
    }));
    expect(global.fetch).toHaveBeenCalledWith('https://example.test/api/me/preferences',
      expect.objectContaining({ headers: { Authorization: `Bearer ${token}` } }));
  });
  it('retains intent after module/process recreation and boot', async () => {
    jest.resetModules();
    recovery = require('../androidTrackingRecovery');
    expect(await run()).toBe('restarted');
  });
  it('is idempotent: repeated successful wakes do not start or register again', async () => {
    await run();
    expect(await run()).toBe('already_enabled');
    expect(sdk.start).toHaveBeenCalledTimes(1);
  });
  it.each(['foreground', 'background'])('does not restart with %s permission denied', async key => {
    permissions[key as 'foreground' | 'background'] = 'denied';
    expect(await run()).toBe('permission_denied');
    expect(sdk.start).not.toHaveBeenCalled();
    expect(store.has(recovery.TRACKING_INTENT_KEY)).toBe(false);
  });
  it('notification denial alone does not deny valid location recovery', async () => {
    expect(await run()).toBe('restarted');
  });
  it('does not use an SDK-cached token after app sign-out', async () => {
    token = null;
    expect(await run()).toBe('no_session');
    expect(sdk.start).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it.each(['wrong session', 'wrong member', 'removed member'])('rejects %s ownership', async reason => {
    if (reason === 'wrong session') user = { id: 'owner-b' };
    if (reason === 'wrong member') members[0].user_id = 'owner-b';
    if (reason === 'removed member') members = [];
    expect(await run()).toBe('invalid_owner');
    expect(sdk.start).not.toHaveBeenCalled();
    expect(store.has(recovery.TRACKING_INTENT_KEY)).toBe(false);
  });
  it('revoked intent cannot be recovered even if the native config remains', async () => {
    await recovery.revokeTrackingIntent();
    expect(await run()).toBe('no_current_intent');
    expect(sdk.start).not.toHaveBeenCalled();
  });
  it('does not authorize a cancelled foreground owner', async () => {
    await recovery.revokeTrackingIntent();
    await recovery.authorizeTrackingIntent(config, recovery.trackingIntentEpoch(), () => false);
    expect(await run()).toBe('no_current_intent');
  });
  it('does not authorize a start whose intent epoch predates sign-out', async () => {
    const epoch = recovery.trackingIntentEpoch();
    await recovery.revokeTrackingIntent();
    await recovery.authorizeTrackingIntent(config, epoch, () => true);
    expect(await run()).toBe('no_current_intent');
  });
  it('honors a wake timeout/cancellation before starting', async () => {
    let current = true;
    sdk.setConfig.mockImplementation(async () => { current = false; });
    expect(await run(() => current)).toBe('obsolete_owner');
    expect(sdk.start).not.toHaveBeenCalled();
  });
  it('stops a late native start when sign-out occurs while it is pending', async () => {
    sdk.start.mockImplementation(async () => {
      await recovery.revokeTrackingIntent();
      token = null;
      enabled = true;
      return { enabled };
    });
    expect(await run()).toBe('late_start_stopped');
    expect(sdk.stop).toHaveBeenCalledTimes(1);
    expect(enabled).toBe(false);
  });
  it('stops a late start after permission revocation', async () => {
    sdk.start.mockImplementation(async () => {
      permissions.background = 'denied';
      return { enabled: true };
    });
    expect(await run()).toBe('late_start_stopped');
    expect(sdk.stop).toHaveBeenCalledTimes(1);
    expect(store.has(recovery.TRACKING_INTENT_KEY)).toBe(false);
  });
  it('does not restart if permission changes during native configuration', async () => {
    sdk.setConfig.mockImplementation(async () => { permissions.background = 'denied'; });
    expect(await run()).toBe('permission_denied');
    expect(sdk.start).not.toHaveBeenCalled();
  });
  it('does not restart a new/obsolete token after ownership lookup', async () => {
    sdk.setConfig.mockImplementation(async () => { token = 'replacement-session'; });
    expect(await run()).toBe('obsolete_owner');
    expect(sdk.start).not.toHaveBeenCalled();
  });
  it.each(['local', 'server'])('honors %s location-sharing opt-out', async source => {
    if (source === 'local') store.set('@kinnship/location_sharing_off_v1', '1');
    else sharing = false;
    expect(await run()).toBe('sharing_disabled');
    expect(sdk.start).not.toHaveBeenCalled();
  });
  it('caps repeated failed starts without a retry loop', async () => {
    sdk.start.mockResolvedValue({ enabled: false });
    expect(await run()).toBe('start_not_enabled');
    expect(await run()).toBe('cooldown');
    expect(sdk.start).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });
  it('fails closed when the server cannot verify ownership', async () => {
    enabled = true;
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 401 });
    await expect(run()).rejects.toThrow('ownership_http_401');
    expect(sdk.start).not.toHaveBeenCalled();
    expect(sdk.stop).toHaveBeenCalled();
    expect(store.has(recovery.TRACKING_INTENT_KEY)).toBe(false);
  });
  it('does not send session credentials to a substituted backend', async () => {
    process.env.EXPO_PUBLIC_BACKEND_URL = 'https://other.test';
    expect(await run()).toBe('invalid_backend');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each(['member removed', 'server opt-out'])('stops an already-enabled engine after %s', async reason => {
    enabled = true;
    if (reason === 'member removed') members = [];
    else sharing = false;
    expect(await run()).toBe(reason === 'member removed' ? 'invalid_owner' : 'sharing_disabled');
    expect(sdk.stop).toHaveBeenCalled();
    expect(enabled).toBe(false);
    expect(sdk.start).not.toHaveBeenCalled();
  });

  it('does not issue a battery authorization receipt to a signed-out or wrong owner', async () => {
    const proof = jest.fn();
    token = null;
    expect(await recovery.recoverUnexpectedlyDisabledTracking(sdk, () => true, proof)).toBe('no_session');
    expect(proof).not.toHaveBeenCalled();
    token = 'wrong-session';
    user = { id: 'owner-b' };
    expect(await recovery.recoverUnexpectedlyDisabledTracking(sdk, () => true, proof)).toBe('invalid_owner');
    expect(proof).not.toHaveBeenCalled();
  });

  it('a verified battery receipt becomes invalid synchronously on sign-out', async () => {
    let proof!: import('../androidTrackingRecovery').AuthorizedBatteryTransport;
    await recovery.recoverUnexpectedlyDisabledTracking(sdk, () => true, value => { proof = value; });
    expect(await proof.isCurrent()).toBe(true);
    const revoked = recovery.revokeTrackingIntent();
    expect(await proof.isCurrent()).toBe(false);
    await revoked;
  });

  it('foreground startup cannot override a server sharing opt-out', async () => {
    sharing = false;
    const engine = require('../locationEngine') as typeof import('../locationEngine');
    expect(await engine.start({ ...config, jwt: token! })).toBe('failed');
    expect(sdk.start).not.toHaveBeenCalled();
    expect(sdk.stop).toHaveBeenCalled();
    expect(store.has(recovery.TRACKING_INTENT_KEY)).toBe(false);
  });

  it.each([false, true])('local opt-out stops native tracking even if storage fails (%s)', async fails => {
    const stop = jest.fn(async () => { await recovery.revokeTrackingIntent(); });
    jest.doMock('../locationEngine', () => ({ stop }));
    jest.doMock('expo-location', () => ({}));
    jest.doMock('expo-task-manager', () => ({ isTaskDefined: () => true, defineTask: jest.fn() }));
    jest.doMock('expo-battery', () => ({}));
    const changed = jest.fn();
    recovery.subscribeToTrackingPolicy(changed);
    const storage = require('@react-native-async-storage/async-storage');
    if (fails) storage.setItem.mockRejectedValueOnce(new Error('storage unavailable'));
    const location = require('../backgroundLocation') as typeof import('../backgroundLocation');
    if (fails) await expect(location.setLocationSharingEnabled(false)).rejects.toThrow('storage unavailable');
    else await location.setLocationSharingEnabled(false);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(store.has(recovery.TRACKING_INTENT_KEY)).toBe(false);
    expect(changed).toHaveBeenCalledTimes(fails ? 0 : 1);
  });

  it('a future cooldown timestamp cannot permanently suppress recovery after clock correction', async () => {
    store.set('kc_android_tracking_recovery_attempt_v1', String(Date.now() + 86_400_000));
    expect(await run()).toBe('restarted');
  });

  it('actual token clearing stops native tracking with no React root mounted', async () => {
    enabled = true;
    jest.dontMock('../api');
    jest.dontMock('../locationEngine');
    jest.doMock('expo-secure-store', () => ({
      getItemAsync: jest.fn(async () => token),
      deleteItemAsync: jest.fn(async () => { token = null; }),
      setItemAsync: jest.fn(),
    }));
    const api = require('../api') as typeof import('../api');
    await api.clearToken();
    expect(token).toBeNull();
    expect(store.has(recovery.TRACKING_INTENT_KEY)).toBe(false);
    expect(sdk.stop).toHaveBeenCalled();
    expect(enabled).toBe(false);
    expect(sdk.start).not.toHaveBeenCalled();
  });

  it('rechecks revocation after a delayed secure-session read returns stale data', async () => {
    const api = require('../api');
    api.getCurrentToken.mockImplementationOnce(async () => token);
    api.getCurrentToken.mockImplementationOnce(async () => {
      const stale = token;
      await recovery.revokeTrackingIntent();
      return stale;
    });
    expect(await run()).toBe('obsolete_owner');
    expect(sdk.start).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
