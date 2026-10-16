/* eslint-disable @typescript-eslint/no-require-imports */
describe('Android one-shot publication across real independent paths', () => {
  const base = 'https://example.test';
  const originalBase = process.env.EXPO_PUBLIC_BACKEND_URL;
  const originalFetch = global.fetch;
  let storage: Map<string, string>;
  let sdk: any;
  let engine: typeof import('../locationEngine');
  let policy: typeof import('../androidTrackingRecovery');
  let token: string | null;
  let members: any[];
  let sharing: boolean;
  let permissions: { foreground: string; background: string };
  let enabled: boolean;
  let finishGps: () => void;
  let nativeWrites: number;
  let wake: (id: string) => Promise<void>;
  let replacement: Promise<unknown> | undefined;
  const position = {
    timestamp: new Date().toISOString(),
    coords: { latitude: 35, longitude: -114, accuracy: 10 },
    battery: { level: 0.8, is_charging: true },
  };

  beforeEach(async () => {
    jest.resetModules();
    position.timestamp = new Date().toISOString();
    process.env.EXPO_PUBLIC_BACKEND_URL = base;
    storage = new Map();
    token = 'current-session';
    members = [{ id: 'member', user_id: 'owner' }];
    sharing = true;
    enabled = false;
    nativeWrites = 0;
    replacement = undefined;
    permissions = { foreground: 'granted', background: 'granted' };
    jest.doMock('@react-native-async-storage/async-storage', () => ({
      getItem: jest.fn(async key => storage.get(key) ?? null),
      setItem: jest.fn(async (key, value) => { storage.set(key, value); }),
      removeItem: jest.fn(async key => { storage.delete(key); }),
    }));
    jest.doMock('react-native', () => ({
      Platform: { OS: 'android' }, AppState: { currentState: 'background' },
    }));
    jest.doMock('../permissionCoordinator', () => ({
      readPermissionSnapshot: jest.fn(async () => ({ ...permissions, notifications: 'not-inspected' })),
      serializePermissionOperation: (fn: () => Promise<unknown>) => fn(),
    }));
    jest.doMock('../api', () => ({
      getCurrentToken: jest.fn(async () => token),
      api: {
        get: jest.fn(async path => ({ data: path === '/members' ? members
          : path === '/auth/me' ? { id: 'owner' } : { location_sharing_enabled: sharing } })),
        put: jest.fn(async () => ({})),
      },
    }));
    sdk = {
      registerHeadlessTask: jest.fn(),
      getState: jest.fn(async () => ({
        enabled, url: `${base}/api/members/member/location`,
        authorization: { accessToken: token },
      })),
      setConfig: jest.fn(async () => {}),
      start: jest.fn(async () => { enabled = true; return { enabled }; }),
      stop: jest.fn(async () => { enabled = false; }),
      insertLocation: jest.fn(), sync: jest.fn(),
      getCurrentPosition: jest.fn(options => new Promise(resolve => {
        finishGps = () => {
          // Model native SQLite/HTTP side effects BEFORE JS sees the result.
          if (options.persist !== false) nativeWrites += 1;
          resolve({ ...position, extras: options.extras });
        };
      })),
    };
    jest.doMock('react-native-background-geolocation', () => ({ default: sdk }));
    jest.doMock('expo-battery', () => ({
      BatteryState: { CHARGING: 2, FULL: 5 },
      getBatteryLevelAsync: jest.fn(async () => 0.8),
      getBatteryStateAsync: jest.fn(async () => 2),
    }));
    jest.doMock('react-native-background-fetch', () => ({ default: {
      NETWORK_TYPE_ANY: 0, registerHeadlessTask: jest.fn(), finish: jest.fn(),
      configure: jest.fn(async (_options, callback) => { wake = callback; return 2; }),
    } }));
    global.fetch = jest.fn(async (url, options) => ({
      ok: true, status: 200,
      json: async () => String(url).endsWith('/auth/me') ? { id: 'owner' }
        : String(url).endsWith('/members') ? members
          : options?.method === 'PUT' ? {
              latitude: position.coords.latitude, longitude: position.coords.longitude,
              coordinate_captured_at: position.timestamp,
            } : { location_sharing_enabled: sharing },
    })) as any;
    policy = require('../androidTrackingRecovery');
    await policy.authorizeTrackingIntent(
      { ownerUserId: 'owner', memberId: 'member', backendBaseUrl: base },
      policy.trackingIntentEpoch(), () => true,
    );
    engine = require('../locationEngine');
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.EXPO_PUBLIC_BACKEND_URL = originalBase;
    jest.resetModules();
  });

  async function run(path: string): Promise<unknown> {
    if (path === 'workmanager') {
      await require('../batteryTask').configureBatteryTask();
      return wake('gps-wake');
    }
    if (path === 'silent') return engine.recoverAndRefreshFromIndependentWake('silent');
    const callback = sdk.registerHeadlessTask.mock.calls[0][0];
    return callback({
      name: path, params: path === 'heartbeat'
        ? { location: { battery: position.battery } } : { isMoving: true },
    });
  }
  async function gpsStarted() {
    for (let i = 0; i < 1500 && !sdk.getCurrentPosition.mock.calls.length; i++) await Promise.resolve();
    expect(sdk.getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(sdk.getCurrentPosition.mock.calls[0][0].persist).toBe(false);
  }
  function uploads() {
    return (global.fetch as jest.Mock).mock.calls.filter(([url, options]) =>
      String(url).endsWith('/location') && options?.method === 'PUT');
  }
  async function withdraw(boundary: string) {
    if (boundary === 'signout') { token = null; await engine.stop('signout'); }
    if (boundary === 'consent') { sharing = false; await engine.stop('consent'); }
    if (boundary === 'permission') {
      permissions.background = 'denied'; await engine.stop('permission');
    }
    if (boundary === 'ownership') {
      members = [];
      expect(await engine.recoverFromIndependentWake('ownership-check')).toBe('invalid_owner');
    }
    if (boundary === 'superseded') {
      // Actual startup invalidates the engine generation synchronously, then
      // waits behind the pending acquisition rather than racing its SDK state.
      replacement = engine.start({ memberId: 'member', jwt: token!, backendBaseUrl: base }).catch(() => {});
    }
    if (boundary === 'os-only') permissions.background = 'denied';
    if (boundary === 'ownership-only') members = [];
    if (boundary === 'sharing-only') sharing = false;
  }

  const paths = ['workmanager', 'heartbeat', 'motionchange', 'silent'];
  it.each(['onHeartbeat', 'onMotionChange'])(
    'preserves legitimately owned foreground %s acquisition after startup', async event => {
      sdk.ready = jest.fn(async () => ({ enabled: false, trackingMode: 1 }));
      for (const name of ['onLocation', 'onMotionChange', 'onActivityChange', 'onHeartbeat',
        'onProviderChange', 'onHttp', 'onEnabledChange', 'onPowerSaveChange']) {
        sdk[name] = jest.fn(() => ({ remove: jest.fn() }));
      }
      expect(await engine.start({
        ownerUserId: 'owner', memberId: 'member', jwt: token!, backendBaseUrl: base,
      })).toBe('background-ready');
      sdk[event].mock.calls[0][0]({ isMoving: true });
      await gpsStarted();
      finishGps();
      for (let i = 0; i < 1500 && !uploads().length; i++) await Promise.resolve();
      // Drain the fire-and-forget callback's bookkeeping before module reset.
      for (let i = 0; i < 200; i++) await Promise.resolve();
      expect(uploads()).toHaveLength(1);
      expect(nativeWrites).toBe(0);
      expect(sdk.stop).not.toHaveBeenCalled();
    },
  );
  it.each([{ sample: true }, { extras: { kc_guarded_one_shot: true } }])(
    'does not publish a native sampling callback before its fence: %j', async flags => {
      const before = new Map(storage);
      await sdk.registerHeadlessTask.mock.calls[0][0]({
        name: 'location', params: { ...position, ...flags },
      });
      expect(storage).toEqual(before);
      expect(uploads()).toHaveLength(0);
    },
  );
  const boundaries = ['signout', 'consent', 'permission', 'ownership', 'superseded',
    'os-only', 'ownership-only', 'sharing-only', 'unchanged'];
  it.each(paths.flatMap(path => boundaries.map(boundary => [path, boundary])))(
    '%s discards a delayed fix after %s, but publishes unchanged authorization',
    async (path, boundary) => {
      const pending = run(path).catch(error => error);
      await gpsStarted();
      await withdraw(boundary);
      finishGps();
      await pending;
      if (replacement) await replacement;
      expect(nativeWrites).toBe(0);
      expect(sdk.insertLocation).not.toHaveBeenCalled();
      expect(sdk.sync).not.toHaveBeenCalled();
      expect(uploads()).toHaveLength(boundary === 'unchanged' ? 1 : 0);
      if (boundary !== 'unchanged') {
        const log = JSON.parse(storage.get('@kinnship/location_engine_log_v1') ?? '[]');
        expect(log.filter((row: any) => row.event === 'gps_fix_received')).toHaveLength(0);
      } else {
        expect(uploads()[0][1].headers.Authorization).toBe('Bearer current-session');
        expect(JSON.parse(uploads()[0][1].body)).toMatchObject({
          latitude: 35, longitude: -114, timestamp: position.timestamp,
        });
      }
    },
  );
  it.each(paths.flatMap(path => [...boundaries.slice(0, 4), 'unchanged'].map(boundary => [path, boundary])))(
    '%s privacy shutdown bypasses never-settling GPS after %s',
    async (path, boundary) => {
      void run(path).catch(() => {});
      await gpsStarted();
      await withdraw(boundary);
      if (boundary === 'unchanged') expect(sdk.stop).not.toHaveBeenCalled();
      else expect(sdk.stop).toHaveBeenCalled();
      expect(enabled).toBe(boundary === 'unchanged');
      expect(uploads()).toHaveLength(0);
      expect(nativeWrites).toBe(0);
    },
  );
});
