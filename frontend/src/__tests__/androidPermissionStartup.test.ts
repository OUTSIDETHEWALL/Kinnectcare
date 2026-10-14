/** Native APIs are mocked; permission policy and SDK startup are real. */
describe('Android permission/startup policy', () => {
  let storage: Map<string, string>;
  let location: any;
  let notifications: any;
  let sdk: any;
  let alert: jest.Mock;
  let coordinator: typeof import('../permissionCoordinator');
  let store: typeof import('../permissionsStore');
  let engine: typeof import('../locationEngine');
  let platform: { OS: string };
  let sessionToken: string | null;
  const fetchBefore = global.fetch;
  const backendBefore = process.env.EXPO_PUBLIC_BACKEND_URL;

  const config = { memberId: 'member', ownerUserId: 'owner', jwt: 'test-jwt', backendBaseUrl: 'https://example.test' };
  const grant = (status: string) => ({ status, granted: status === 'granted' });

  beforeEach(() => {
    jest.resetModules();
    storage = new Map();
    sessionToken = config.jwt;
    process.env.EXPO_PUBLIC_BACKEND_URL = config.backendBaseUrl;
    global.fetch = jest.fn(async (url: any) => ({
      ok: true, json: async () => String(url).endsWith('/auth/me') ? { id: 'owner' }
        : String(url).endsWith('/members') ? ['member', 'replacement'].map(id => ({ id, user_id: 'owner' }))
          : { location_sharing_enabled: true },
    })) as any;
    jest.doMock('../api', () => ({
      getCurrentToken: jest.fn(async () => sessionToken),
      api: {
        get: jest.fn(async (path: string) => ({ data: path === '/auth/me' ? { id: 'owner' }
          : path === '/members' ? ['member', 'replacement'].map(id => ({ id, user_id: 'owner' }))
            : { location_sharing_enabled: true } })),
        put: jest.fn(async () => ({})),
      },
    }));
    location = {
      getForegroundPermissionsAsync: jest.fn().mockResolvedValue(grant('granted')),
      getBackgroundPermissionsAsync: jest.fn().mockResolvedValue(grant('granted')),
      requestForegroundPermissionsAsync: jest.fn().mockResolvedValue(grant('granted')),
      requestBackgroundPermissionsAsync: jest.fn().mockResolvedValue(grant('granted')),
    };
    notifications = {
      getPermissionsAsync: jest.fn().mockResolvedValue(grant('granted')),
      requestPermissionsAsync: jest.fn().mockResolvedValue(grant('granted')),
    };
    alert = jest.fn((_title, _message, buttons) => buttons[0].onPress());
    sdk = {
      ready: jest.fn().mockResolvedValue({ enabled: false, trackingMode: 1 }),
      setConfig: jest.fn().mockResolvedValue({ enabled: true }),
      requestPermission: jest.fn(),
      getState: jest.fn().mockResolvedValue({ enabled: true, trackingMode: 1, isMoving: false }),
      start: jest.fn().mockResolvedValue({ enabled: true, trackingMode: 1 }),
      stop: jest.fn().mockResolvedValue({ enabled: false }),
      removeListeners: jest.fn(),
    };
    for (const name of ['onLocation', 'onMotionChange', 'onActivityChange', 'onHeartbeat',
      'onProviderChange', 'onHttp', 'onEnabledChange', 'onPowerSaveChange',
      'onConnectivityChange', 'onGeofence', 'onSchedule']) {
      sdk[name] = jest.fn(() => ({ remove: jest.fn() }));
    }
    platform = { OS: 'android' };
    jest.doMock('react-native', () => ({
      Platform: platform, Alert: { alert },
      AppState: { currentState: 'active', addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
    }));
    jest.doMock('@react-native-async-storage/async-storage', () => ({
      getItem: jest.fn(async key => storage.get(key) ?? null),
      setItem: jest.fn(async (key, value) => { storage.set(key, value); }),
      removeItem: jest.fn(async key => { storage.delete(key); }),
    }));
    jest.doMock('expo-location', () => location);
    jest.doMock('expo-notifications', () => notifications);
    jest.doMock('expo-battery', () => ({
      getBatteryLevelAsync: jest.fn().mockResolvedValue(-1),
      getBatteryStateAsync: jest.fn().mockResolvedValue(0),
      addBatteryLevelListener: jest.fn(() => ({ remove: jest.fn() })),
      addBatteryStateListener: jest.fn(() => ({ remove: jest.fn() })),
    }));
    jest.doMock('react-native-background-geolocation', () => ({ default: sdk }));
    coordinator = require('../permissionCoordinator');
    store = require('../permissionsStore');
    engine = require('../locationEngine');
  });
  afterEach(() => {
    global.fetch = fetchBefore;
    if (backendBefore === undefined) delete process.env.EXPO_PUBLIC_BACKEND_URL;
    else process.env.EXPO_PUBLIC_BACKEND_URL = backendBefore;
  });

  it('requires setup for a clean install', async () => {
    expect(await store.isPermissionsHandled()).toBe(false);
  });
  it.each([{ sample: true }, { extras: { kc_guarded_one_shot: true } }])(
    'foreground observer ignores uncommitted one-shot sampling: %j', async flags => {
      expect(await engine.start(config)).toBe('background-ready');
      sdk.onLocation.mock.calls[0][0]({
        coords: { latitude: 35, longitude: -114 }, ...flags,
      });
      for (let i = 0; i < 30; i++) await Promise.resolve();
      const log = JSON.parse(storage.get('@kinnship/location_engine_log_v1') ?? '[]');
      expect(log.filter((row: any) => row.event === 'sdk_onLocation')).toHaveLength(0);
    },
  );

  it.each(['normal', 'rejects', 'never'])(
    'foreground repair ignores notification permission that %s', async behavior => {
      sdk.getState.mockResolvedValue({ enabled: false, trackingMode: 1 });
      if (behavior === 'rejects') notifications.getPermissionsAsync.mockRejectedValue(new Error('bridge failed'));
      if (behavior === 'never') notifications.getPermissionsAsync.mockImplementation(() => new Promise(() => {}));
      void coordinator.notificationPermission(false).catch(() => {});
      expect(await engine.start(config)).toBe('background-ready');
      expect(sdk.start).toHaveBeenCalledTimes(1);
      expect(notifications.getPermissionsAsync).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['normal', 'rejects', 'never'].flatMap(behavior =>
    ['no-session', 'denied-location', 'lost-member'].map(boundary => [behavior, boundary])))(
    '%s notification inspection cannot authorize foreground startup after %s',
    async (behavior, boundary) => {
      if (behavior === 'rejects') notifications.getPermissionsAsync.mockRejectedValue(new Error('bridge failed'));
      if (behavior === 'never') notifications.getPermissionsAsync.mockImplementation(() => new Promise(() => {}));
      void coordinator.notificationPermission(false).catch(() => {});
      const cfg = { ...config };
      if (boundary === 'no-session') sessionToken = null;
      if (boundary === 'denied-location') location.getForegroundPermissionsAsync.mockResolvedValue(grant('denied'));
      if (boundary === 'lost-member') {
        Object.assign(cfg, { ownerUserId: 'owner' });
        require('../api').api.get.mockImplementation(async (path: string) => ({
          data: path === '/auth/me' ? { id: 'owner' }
            : path === '/members' ? [] : { location_sharing_enabled: true },
        }));
      }
      expect(['failed', 'denied']).toContain(await engine.start(cfg));
      expect(sdk.start).not.toHaveBeenCalled();
      expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    },
  );
  it.each(['normal', 'rejects', 'never'])(
    'revoked/unauthorized foreground remains stopped with notification query %s', async behavior => {
      await engine.stop('consent');
      if (behavior === 'rejects') notifications.getPermissionsAsync.mockRejectedValue(new Error('bridge failed'));
      if (behavior === 'never') notifications.getPermissionsAsync.mockImplementation(() => new Promise(() => {}));
      void coordinator.notificationPermission(false).catch(() => {});
      expect(await engine.start(config)).toBe('failed');
      expect(sdk.start).not.toHaveBeenCalled();
      expect(notifications.getPermissionsAsync).toHaveBeenCalledTimes(1);
    },
  );

  it('location-only permission inspection does not wait for notification permission', async () => {
    notifications.getPermissionsAsync.mockImplementation(() => new Promise(() => {}));
    expect(await coordinator.readPermissionSnapshot({ includeNotifications: false })).toMatchObject({
      foreground: 'granted', background: 'granted', notifications: 'not-inspected',
    });
    expect(notifications.getPermissionsAsync).not.toHaveBeenCalled();
  });

  it.each([0, 1, null])('sends native tracking mode %s using the deployed snapshot string contract', async mode => {
    await engine.start(config);
    sdk.getState.mockResolvedValue({ enabled: true, trackingMode: mode });
    const api = require('../api').api;
    api.put.mockClear();
    expect(await engine.triggerDeviceSnapshotNow()).toEqual({ ok: true });
    expect(api.put).toHaveBeenCalledWith(
      '/members/member/device-snapshot',
      expect.objectContaining({ sdk_tracking_mode: mode === null ? null : String(mode) }),
      expect.anything(),
    );
  });

  it('preserves best-effort iOS setup persistence', async () => {
    platform.OS = 'ios';
    const nativeStorage = require('@react-native-async-storage/async-storage');
    nativeStorage.setItem.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(store.markPermissionsHandled()).resolves.toBeUndefined();
    expect(location.getForegroundPermissionsAsync).not.toHaveBeenCalled();
  });

  async function untilCalled(mock: jest.Mock) {
    for (let i = 0; i < 300 && mock.mock.calls.length === 0; i++) await Promise.resolve();
    expect(mock).toHaveBeenCalled();
  }

  it.each(['cancelled bootstrap', 'sign-out', 'session replacement', 'member removal'])(
    'stops a late native start after %s, before any replacement starts', async reason => {
      let current = true;
      let resolveStart!: (value: any) => void;
      sdk.start.mockImplementationOnce(() => new Promise(resolve => { resolveStart = resolve; }));
      const pending = engine.start({ ...config, isCurrent: () => current, isOwnerCurrent: () => current });
      await untilCalled(sdk.start);
      current = false;
      const stopped = reason === 'cancelled bootstrap' ? Promise.resolve() : engine.stop();
      const replacement = reason === 'session replacement'
        ? engine.start({ ...config, memberId: 'replacement', isOwnerCurrent: () => true }) : null;
      resolveStart({ enabled: true });
      expect(await pending).toBe('failed');
      await stopped;
      if (reason === 'cancelled bootstrap') expect(sdk.stop).not.toHaveBeenCalled();
      else expect(sdk.stop).toHaveBeenCalled();
      if (replacement) {
        expect(await replacement).toBe('background-ready');
        expect(sdk.stop.mock.invocationCallOrder[0]).toBeLessThan(sdk.start.mock.invocationCallOrder[1]);
        expect(sdk.setConfig).toHaveBeenLastCalledWith(expect.objectContaining({
          url: expect.stringContaining('/members/replacement/location'),
        }));
      } else {
        await expect(engine.restart()).rejects.toThrow('no current session/member owner');
      }
      expect((await engine.getEngineLog()).some(e =>
        e.event === 'startup_outcome' && e.detail?.outcome === 'failed')).toBe(true);
    },
  );

  it.each(['ready', 'setConfig'])('discards cancellation during native %s without stopping shared tracking', async method => {
    if (method === 'setConfig') await engine.start(config);
    sdk.start.mockClear();
    let current = true;
    let resolveConfig!: (value: any) => void;
    sdk[method].mockImplementationOnce(() => new Promise(resolve => { resolveConfig = resolve; }));
    const pending = engine.start({ ...config, isCurrent: () => current });
    await untilCalled(sdk[method]);
    current = false;
    resolveConfig({ enabled: true });
    expect(await pending).toBe('failed');
    expect(sdk.start).not.toHaveBeenCalled();
    expect(sdk.stop).not.toHaveBeenCalled();
  });

  it('recovery retains live session ownership after bootstrap effect cleanup', async () => {
    let effectCurrent = true;
    let ownerCurrent = true;
    await engine.start({ ...config, isCurrent: () => effectCurrent, isOwnerCurrent: () => ownerCurrent });
    effectCurrent = false;
    await engine.restart();
    expect(sdk.start).toHaveBeenCalledTimes(2);
    ownerCurrent = false;
    await expect(engine.restart()).rejects.toThrow('no current session/member owner');
    expect(sdk.start).toHaveBeenCalledTimes(2);
  });

  it.each(['failed', 'denied', 'foreground-only'])(
    'never logs restart_completed for a %s restart outcome', async outcome => {
      await engine.start(config);
      await engine.clearEngineLog();
      if (outcome === 'failed') sdk.start.mockResolvedValue({ enabled: false });
      if (outcome === 'denied') location.getForegroundPermissionsAsync.mockResolvedValue(grant('denied'));
      if (outcome === 'foreground-only') location.getBackgroundPermissionsAsync.mockResolvedValue(grant('undetermined'));
      await expect(engine.restart()).rejects.toThrow(`not background-ready: ${outcome}`);
      const log = await engine.getEngineLog();
      expect(log.some(e => e.event === 'restart_completed')).toBe(false);
      expect(log.some(e => e.event === 'restart_failed' && e.detail?.outcome === outcome)).toBe(true);
    },
  );

  it('serializes token refresh with session revocation and replacement configuration', async () => {
    let current = true;
    await engine.start({ ...config, isOwnerCurrent: () => current });
    let resolveRefresh!: (value: any) => void;
    sdk.setConfig.mockImplementationOnce(() => new Promise(resolve => { resolveRefresh = resolve; }));
    sessionToken = 'refreshed-test-jwt';
    const refresh = engine.setAuthToken(sessionToken);
    await untilCalled(sdk.setConfig);
    current = false;
    const stopped = engine.stop();
    sessionToken = 'replacement-test-jwt';
    const replacement = engine.start({ ...config, memberId: 'replacement', jwt: sessionToken });
    resolveRefresh({ enabled: true });
    await refresh;
    await stopped;
    expect(await replacement).toBe('background-ready');
    expect(sdk.setConfig).toHaveBeenLastCalledWith(expect.objectContaining({
      url: expect.stringContaining('/members/replacement/location'),
      authorization: expect.objectContaining({ accessToken: 'replacement-test-jwt' }),
    }));
    expect(sdk.stop).toHaveBeenCalled();
  });
  it('does not rebind a new token when server ownership is UNKNOWN', async () => {
    await engine.start(config);
    sdk.setConfig.mockClear();
    (global.fetch as jest.Mock).mockRejectedValue(new Error('offline'));
    sessionToken = 'unverified-token';
    await engine.setAuthToken(sessionToken);
    expect(sdk.setConfig).not.toHaveBeenCalled();
    expect(sdk.stop).not.toHaveBeenCalled();
  });

  it('preserves a native start when post-start permission lookup is UNKNOWN', async () => {
    location.getForegroundPermissionsAsync
      .mockResolvedValueOnce(grant('granted'))
      .mockRejectedValueOnce(new Error('permission lookup unavailable'));
    expect(await engine.start(config)).toBe('failed');
    expect(sdk.stop).not.toHaveBeenCalled();
    await expect(engine.restart()).rejects.toThrow('no current session/member owner');
  });

  it.each(['denied', 'throws', 'foreground-only'])(
    'preserves iOS start-after-request behavior when permission %s', async permission => {
      platform.OS = 'ios';
      if (permission === 'throws') sdk.requestPermission.mockRejectedValue(new Error('native request error'));
      else sdk.requestPermission.mockResolvedValue(permission === 'denied' ? 1 : 2);
      expect(await engine.start(config)).toBe('background-ready');
      expect(sdk.start).toHaveBeenCalledTimes(1);
      expect(sdk.stop).not.toHaveBeenCalled();
      expect(location.getForegroundPermissionsAsync).not.toHaveBeenCalled();
    },
  );

  it.each(['undetermined', 'denied'])('rejects an Android-restored legacy flag with background %s', async status => {
    storage.set('@kinnship/permissions_handled_v1', 'true');
    location.getBackgroundPermissionsAsync.mockResolvedValue(grant(status));
    expect(await store.isPermissionsHandled()).toBe(false);
    expect(location.requestBackgroundPermissionsAsync).not.toHaveBeenCalled();
  });

  it('retains a fully authorized legacy installation without extra prompts', async () => {
    storage.set('@kinnship/permissions_handled_v1', 'true');
    expect(await store.isPermissionsHandled()).toBe(true);
    expect(alert).not.toHaveBeenCalled();
  });

  it('Continue Anyway persists a denial without a startup loop', async () => {
    location.getForegroundPermissionsAsync.mockResolvedValue(grant('denied'));
    location.getBackgroundPermissionsAsync.mockResolvedValue(grant('undetermined'));
    notifications.getPermissionsAsync.mockResolvedValue(grant('denied'));
    await store.markPermissionsHandled();
    expect(await store.isPermissionsHandled()).toBe(true);
    expect(await store.isPermissionsHandled()).toBe(true);
    expect(alert).not.toHaveBeenCalled();
  });

  it('detects a permission lost after a granted decision was restored', async () => {
    await store.markPermissionsHandled();
    location.getBackgroundPermissionsAsync.mockResolvedValue(grant('undetermined'));
    expect(await store.isPermissionsHandled()).toBe(false);
  });

  it('serializes disclosure, foreground, background, and notifications', async () => {
    const order: string[] = [];
    let acknowledge!: () => void;
    alert.mockImplementation((_title, _body, buttons) => {
      order.push('disclosure');
      acknowledge = buttons[0].onPress;
    });
    location.getBackgroundPermissionsAsync.mockResolvedValue(grant('undetermined'));
    notifications.getPermissionsAsync.mockResolvedValue(grant('undetermined'));
    location.requestForegroundPermissionsAsync.mockImplementation(async () => { order.push('foreground'); return grant('granted'); });
    location.requestBackgroundPermissionsAsync.mockImplementation(async () => { order.push('background'); return grant('granted'); });
    notifications.requestPermissionsAsync.mockImplementation(async () => { order.push('notifications'); return grant('granted'); });
    const setup = coordinator.requestOnboardingLocation();
    const push = coordinator.notificationPermission(true);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(order).toEqual(['disclosure']);
    acknowledge();
    await Promise.all([setup, push]);
    expect(order).toEqual(['disclosure', 'foreground', 'background', 'notifications']);
  });

  it('automatic dashboard/push callers never prompt on Android', async () => {
    location.getForegroundPermissionsAsync.mockResolvedValue(grant('undetermined'));
    notifications.getPermissionsAsync.mockResolvedValue(grant('undetermined'));
    await coordinator.foregroundLocationForAutomaticCaller();
    await coordinator.notificationPermission();
    expect(location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('cancelled onboarding cannot request permissions after disclosure', async () => {
    let current = true;
    alert.mockImplementation((_title, _body, buttons) => {
      current = false;
      buttons[0].onPress();
    });
    expect(await coordinator.requestOnboardingLocation(() => current)).toBeNull();
    expect(location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });

  it.each([
    ['granted', 'granted', 'background-ready'],
    ['granted', 'undetermined', 'foreground-only'],
    ['denied', 'undetermined', 'denied'],
  ])('reports foreground=%s background=%s as %s', async (fg, bg, expected) => {
    location.getForegroundPermissionsAsync.mockResolvedValue(grant(fg));
    location.getBackgroundPermissionsAsync.mockResolvedValue(grant(bg));
    expect(await engine.start(config)).toBe(expected);
    expect(sdk.requestPermission).not.toHaveBeenCalled();
    expect(location.requestBackgroundPermissionsAsync).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
    if (expected !== 'background-ready') expect(sdk.start).not.toHaveBeenCalled();
    else {
      const nativeConfig = sdk.ready.mock.calls[0][0];
      expect(nativeConfig.foregroundService).toBe(true);
      expect(nativeConfig.notification.smallIcon).toBe('drawable/notification_icon');
      expect(nativeConfig.notification.sticky).toBe(true);
      expect(nativeConfig.backgroundPermissionRationale.message).toContain('even when the app is closed or not in use');
      expect(JSON.stringify(nativeConfig.backgroundPermissionRationale)).not.toMatch(/CHANGEME|FEATURE X|FEATURE Y/);
      expect(nativeConfig.locationAuthorizationRequest).toBe(bg === 'granted' ? 'Always' : 'WhenInUse');
    }
  });

  it('a ready failure cannot be reported as a successful bootstrap', async () => {
    sdk.ready.mockRejectedValue(new Error('native ready failed'));
    expect(await engine.start(config)).toBe('failed');
    expect(sdk.start).not.toHaveBeenCalled();
  });

  it('reconciles a Settings grant without asking again', async () => {
    location.getBackgroundPermissionsAsync.mockResolvedValue(grant('denied'));
    expect(await engine.start(config)).toBe('foreground-only');
    location.getBackgroundPermissionsAsync.mockResolvedValue(grant('granted'));
    expect(await engine.start(config)).toBe('background-ready');
    expect(sdk.ready).toHaveBeenCalledWith(expect.objectContaining({ locationAuthorizationRequest: 'Always' }));
    expect(sdk.requestPermission).not.toHaveBeenCalled();
  });

  it('separates SDK tracking mode from OS authorization', async () => {
    location.getBackgroundPermissionsAsync.mockResolvedValue(grant('denied'));
    expect(await engine.getState()).toMatchObject({
      trackingMode: 'location-and-geofences', authorization: 'foreground-only',
    });
    sdk.getState.mockResolvedValue({ enabled: true, trackingMode: 0 });
    expect(await engine.getState()).toMatchObject({ trackingMode: 'geofences-only' });
  });

  it('does not start a disposed session', async () => {
    expect(await engine.start({ ...config, isCurrent: () => false })).toBe('failed');
    expect(sdk.ready).not.toHaveBeenCalled();
    expect(sdk.start).not.toHaveBeenCalled();
  });
});
