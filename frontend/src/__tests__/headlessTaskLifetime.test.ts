/* eslint-disable @typescript-eslint/no-require-imports */
import type { RequestOrigin } from '../requestOrigin';

const flush = async () => { for (let i = 0; i < 2000; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { resolve, promise };
}

describe('SDK native lifetime → real headless handler → real ownership/acquisition', () => {
  const originalFetch = global.fetch;
  const originalBase = process.env.EXPO_PUBLIC_BACKEND_URL;
  let headless: (event: any) => Promise<void>;
  let engine: typeof import('../locationEngine');
  let recovery: typeof import('../androidTrackingRecovery');
  let native: any;
  let sdk: any;
  let store: Map<string, string>;
  let token: string | null;
  let now: number;
  let executions: Map<string, { deadline: number; running: boolean }>;
  let hold: (phase: string) => boolean;
  let responses: { phase: string; release: () => void }[];
  let calls: { url: string; phase: string; wake?: string | null; method: string }[];
  let bound: RequestOrigin | undefined;
  const intentKey = 'kc_android_tracking_intent_v1';
  const nativeKey = 'kcTaskLifetime';
  const event = (id: string, name = 'heartbeat') => ({
    [nativeKey]: id, kcEvidenceWakeId: id, name,
    params: name === 'heartbeat'
      ? { location: { battery: { level: .7, is_charging: true } } }
      : { activity: 'in_vehicle', isMoving: true },
  });
  const begin = (id: string) => { executions.set(id, { deadline: now + 120000, running: true }); return event(id); };
  const release = (phase: string) => responses.filter(r => r.phase === phase).splice(0).forEach(r => r.release());
  const secondCount = () => calls.filter(c => c.phase === 'second-ownership').length;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.resetModules();
    now = 1000; token = 'session-a'; executions = new Map(); responses = []; calls = []; bound = undefined;
    hold = () => false;
    store = new Map([[intentKey, JSON.stringify({
      version: 1, ownerUserId: 'owner', memberId: 'member',
      backendBaseUrl: 'https://example.test', nonce: 'intent-a',
    })]]);
    process.env.EXPO_PUBLIC_BACKEND_URL = 'https://example.test';
    jest.doMock('react-native', () => ({
      Platform: { OS: 'android' }, AppState: { currentState: 'background' },
    }));
    jest.doMock('@react-native-async-storage/async-storage', () => ({
      getItem: jest.fn(async (key: string) => store.get(key) ?? null),
      setItem: jest.fn(async (key: string, value: string) => { store.set(key, value); }),
      removeItem: jest.fn(async (key: string) => { store.delete(key); }),
    }));
    jest.doMock('../api', () => ({ getCurrentToken: jest.fn(async () => token), api: { put: jest.fn() } }));
    jest.doMock('../permissionCoordinator', () => ({
      readPermissionSnapshot: jest.fn(async () => ({ foreground: 'granted', background: 'granted' })),
    }));
    jest.doMock('../backgroundLocationDisclosure', () => ({ BACKGROUND_LOCATION_DISCLOSURE_TEXT: 'test disclosure' }));
    jest.doMock('expo-battery', () => ({}));
    native = {
      ...require('../__mocks__/trackingNative').trackingNative,
      headlessTaskCurrent: jest.fn((id: string) => {
        const execution = executions.get(id);
        return !!execution && execution.running && now < execution.deadline;
      }),
      headlessTaskEnd: jest.fn((id: string) => { executions.delete(id); }),
      originVersion: () => 1,
      originBind: (_request: number, detail: string) => { bound = JSON.parse(detail); },
      originRecord: jest.fn(),
    };
    native.trackingAuthorize('owner:member', 0);
    jest.doMock('expo', () => ({ requireOptionalNativeModule: () => native }));
    const state = {
      enabled: true, url: 'https://example.test/api/members/member/location',
      authorization: { accessToken: token }, extras: { consent_generation: 4 },
    };
    sdk = {
      registerHeadlessTask: jest.fn((fn: typeof headless) => { headless = fn; }),
      getState: jest.fn(async () => state),
      ready: jest.fn(async () => state), start: jest.fn(async () => state),
      stop: jest.fn(async () => ({ enabled: false })), destroyLocations: jest.fn(async () => {}),
      setConfig: jest.fn(async (config: any) => Object.assign(state, config)),
      getCurrentPosition: jest.fn(async () => ({
        timestamp: new Date().toISOString(), coords: { latitude: 1, longitude: 2, accuracy: 5 },
        is_moving: true,
      })),
    };
    for (const listener of ['onLocation', 'onMotionChange', 'onActivityChange', 'onHttp', 'onHeartbeat',
      'onProviderChange', 'onEnabledChange', 'onConnectivityChange']) {
      sdk[listener] = jest.fn(() => ({ remove: jest.fn() }));
    }
    jest.doMock('react-native-background-geolocation', () => ({ default: sdk }));
    let request = 0;
    global.fetch = jest.fn((url: any, options: any = {}) => {
      (global as any).__kinnshipBindRequestOrigin?.(++request);
      const phase = bound?.phase ?? '';
      calls.push({ url: String(url), phase, wake: bound?.wake, method: options.method ?? 'GET' });
      const body = options.body ? JSON.parse(options.body) : {};
      const value = String(url).endsWith('/auth/me') ? { id: 'owner' }
        : String(url).endsWith('/members') ? [{ id: 'member', user_id: 'owner', location_consent_generation: 4 }]
          : String(url).endsWith('/me/preferences') ? { location_sharing_enabled: true }
            : { latitude: body.latitude, longitude: body.longitude,
              coordinate_captured_at: body.timestamp, location_write_accepted: true };
      const response = { ok: true, status: 200, json: async () => value };
      if (!hold(phase)) return Promise.resolve(response);
      const waiting = deferred<any>();
      responses.push({ phase, release: () => waiting.resolve(response) });
      return waiting.promise;
    }) as any;
    // Request scopes are runtime-local, as they are after a real process start.
    delete (global as any).__kinnshipBindRequestOrigin;
    delete (global as any).__kinnshipTaskSettled;
    engine = require('../locationEngine');
    recovery = require('../androidTrackingRecovery');
  });
  afterEach(() => {
    jest.clearAllTimers(); jest.useRealTimers();
    global.fetch = originalFetch; process.env.EXPO_PUBLIC_BACKEND_URL = originalBase;
    delete (global as any).__kinnshipBindRequestOrigin;
    delete (global as any).__kinnshipTaskSettled;
    jest.restoreAllMocks();
  });

  it.each(['expired', 'removed', 'canceled'])('%s while initial reads await: no second-stage or downstream traffic', async reason => {
    hold = phase => phase === 'initial-ownership';
    const pending = headless(begin('wake'));
    await flush();
    expect(calls).toHaveLength(3);
    if (reason === 'expired') now += 120000;
    if (reason === 'removed') executions.delete('wake');
    if (reason === 'canceled') executions.get('wake')!.running = false;
    hold = () => false; release('initial-ownership');
    await pending;
    expect(secondCount()).toBe(0);
    expect(calls).toHaveLength(3);
    expect(sdk.getCurrentPosition).not.toHaveBeenCalled();
    expect(sdk.stop).not.toHaveBeenCalled();
    expect(sdk.destroyLocations).not.toHaveBeenCalled();
    expect(recovery.getVerifiedConsentGeneration('owner:member')).toBeNull();
    expect(JSON.parse(native.trackingRead()).revoked).toBe(false);
  });

  it('expiry during second ownership discards late responses and does not acquire/publish/revoke', async () => {
    hold = phase => phase === 'second-ownership';
    const pending = headless(begin('wake'));
    await flush(); expect(secondCount()).toBe(3);
    const before = native.trackingRead();
    now += 120001;
    hold = () => false; release('second-ownership');
    await pending;
    expect(calls).toHaveLength(6);
    expect(native.trackingRead()).toBe(before);
    expect(sdk.getCurrentPosition).not.toHaveBeenCalled();
    expect(sdk.stop).not.toHaveBeenCalled();
  });

  it('checks each request dispatch, even if the native deadline is crossed inside a triplet', async () => {
    const dispatch = global.fetch as jest.Mock;
    const realDispatch = dispatch.getMockImplementation()!;
    dispatch.mockImplementation((...args: any[]) => {
      const response = realDispatch(...args);
      now += 120000; // First admitted HTTP call crosses the native deadline.
      return response;
    });
    await headless(begin('wake'));
    expect(calls.map(c => c.url)).toEqual(['https://example.test/api/auth/me']);
    expect(secondCount()).toBe(0);
    expect(sdk.stop).not.toHaveBeenCalled();
  });

  it('expiry in the serialized recovery-cache phase prevents later battery and acquisition traffic', async () => {
    hold = phase => phase === 'recovery-cache-miss';
    const pending = headless(begin('wake'));
    await flush();
    expect(calls.filter(c => c.phase === 'recovery-cache-miss')).toHaveLength(3);
    const before = native.trackingRead();
    const count = calls.length; now += 120000;
    hold = () => false; release('recovery-cache-miss');
    await pending;
    expect(calls).toHaveLength(count);
    expect(native.trackingRead()).toBe(before);
    expect(sdk.stop).not.toHaveBeenCalled();
    expect(sdk.getCurrentPosition).not.toHaveBeenCalled();
  });

  it('active task verifies ownership, reports battery and publishes a guarded fresh coordinate', async () => {
    await headless(begin('live'));
    expect(secondCount()).toBe(3);
    expect(calls.some(c => c.url.endsWith('/battery') && c.method === 'PATCH')).toBe(true);
    expect(calls.some(c => c.url.endsWith('/location') && c.method === 'PUT')).toBe(true);
    expect(sdk.getCurrentPosition).toHaveBeenCalledWith(expect.objectContaining({ persist: false }));
    expect(JSON.parse(native.trackingRead())).toMatchObject({ revoked: false, outcome: 'fresh_fix_delivered' });
    expect(native.headlessTaskEnd).toHaveBeenCalledWith('live');
    expect(native.originRecord).toHaveBeenCalledWith('operation', expect.any(String), 'js_settled', expect.any(String));
  });

  it('expired shared-read initiator does not poison a still-valid follower', async () => {
    hold = phase => phase === 'initial-ownership';
    const a = headless(begin('first')); const b = headless(begin('second'));
    await flush(); expect(calls).toHaveLength(3);
    executions.delete('first');
    hold = () => false; release('initial-ownership');
    await Promise.all([a, b]);
    expect(secondCount()).toBe(3);
    expect(calls.filter(c => c.phase === 'second-ownership').every(c => c.wake === 'second')).toBe(true);
    expect(calls.filter(c => c.url.endsWith('/battery'))).toHaveLength(1);
    expect(sdk.getCurrentPosition).toHaveBeenCalled();
  });

  it('multiple valid concurrent tasks retain independent verification and battery processing', async () => {
    await Promise.all([headless(begin('first')), headless(begin('second')), headless(begin('third'))]);
    expect(secondCount()).toBe(9);
    expect(new Set(calls.filter(c => c.phase === 'second-ownership').map(c => c.wake))).toEqual(new Set(['first', 'second', 'third']));
    expect(calls.filter(c => c.url.endsWith('/battery'))).toHaveLength(3);
    expect(sdk.getCurrentPosition).toHaveBeenCalled(); // Existing acquisition policy may coalesce/suppress later fixes.
    expect(sdk.stop).not.toHaveBeenCalled();
  });

  it.each(['logout', 'same-token-session', 'account', 'consent', 'generation', 'engine-lifecycle'])(
    '%s change fences a pending old execution without applying its late authority result', async change => {
      hold = phase => phase === 'initial-ownership';
      const pending = headless(begin('wake'));
      await flush(); expect(calls).toHaveLength(3);
      if (change === 'logout') token = null;
      if (change === 'same-token-session') require('../initialOwnershipReads').beginOwnershipSessionChange()();
      if (change === 'consent') store.set(intentKey, JSON.stringify({ revoked: true, reason: 'consent' }));
      if (change === 'generation' || change === 'account') {
        native.trackingRevoke('signout');
        const generation = JSON.parse(native.trackingRead()).generation;
        native.trackingShutdownComplete(generation);
        native.trackingAuthorize(change === 'account' ? 'replacement:other' : 'owner:member', generation);
      }
      if (change === 'engine-lifecycle') await engine.stop('stopped', 'test_lifecycle_change');
      const before = native.trackingRead();
      const stops = sdk.stop.mock.calls.length;
      hold = () => false; release('initial-ownership'); await pending;
      expect(secondCount()).toBe(0);
      expect(native.trackingRead()).toBe(before);
      expect(sdk.stop).toHaveBeenCalledTimes(stops);
      expect(sdk.getCurrentPosition).not.toHaveBeenCalled();
    },
  );

  it('expiry while native position awaits prevents post-fix ownership traffic and coordinate publication', async () => {
    const fix = deferred<any>();
    sdk.getCurrentPosition.mockReturnValue(fix.promise);
    const pending = headless(begin('wake')); await flush();
    expect(sdk.getCurrentPosition).toHaveBeenCalledTimes(1);
    const count = calls.length; now += 120000;
    fix.resolve({ timestamp: new Date().toISOString(), coords: { latitude: 1, longitude: 2, accuracy: 5 } });
    await pending;
    expect(calls).toHaveLength(count);
    expect(calls.some(c => c.method === 'PUT')).toBe(false);
    expect(JSON.parse(native.trackingRead()).revoked).toBe(false);
  });

  it('missing native lifetime support fails closed for recovery, but native HTTP receipt evidence remains', async () => {
    delete native.headlessTaskCurrent;
    await headless(event('old-binary'));
    expect(calls).toHaveLength(0);
    await headless({ name: 'http', params: { success: true, status: 200 } });
    expect(JSON.parse(store.get('@kinnship/location_engine_log_v1') ?? '[]')).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'headless_http_ok' }),
    ]));
  });

  it.each(['legacy-unconditional', 'native-lifetime'])(
    '30-recovery reproduction: %s boundary', async mode => {
      hold = phase => phase === 'initial-ownership' || phase === 'second-ownership';
      const events = Array.from({ length: 30 }, (_, i) => begin(`wake-${i}`));
      // Control reproduces the exact pre-correction unconditional callback.
      // Both arms use real recovery/ownership/request dispatch, not request-count stubs.
      const pending = events.map(e => mode === 'legacy-unconditional'
        ? engine.recoverFromIndependentWake('sdk-heartbeat', () => true, undefined, e.kcEvidenceWakeId)
        : headless(e));
      await flush(); expect(calls).toHaveLength(3);
      executions.clear(); release('initial-ownership'); await flush();
      expect(secondCount()).toBe(mode === 'legacy-unconditional' ? 90 : 0);
      console.info(`30-task reproduction ${mode}: initial=${calls.filter(c => c.phase === 'initial-ownership').length}, second=${secondCount()}`);
      hold = () => false; release('second-ownership');
      await Promise.all(pending);
    },
  );
});

describe('sticky JS execution cancellation', () => {
  it('a canceled or once-dead execution cannot regain liveness or attach to a replacement', () => {
    jest.resetModules();
    let running = true;
    const end = jest.fn();
    jest.doMock('expo', () => ({ requireOptionalNativeModule: () => ({
      headlessTaskCurrent: () => running, headlessTaskEnd: end,
    }) }));
    const lifetime = require('../headlessTaskLifetime').headlessTaskLifetime({ kcTaskLifetime: 'opaque-execution' });
    expect(lifetime.isCurrent()).toBe(true);
    running = false; expect(lifetime.isCurrent()).toBe(false);
    running = true; expect(lifetime.isCurrent()).toBe(false);
    lifetime.cancel();
    expect(lifetime.isCurrent()).toBe(false);
    expect(end).toHaveBeenCalledWith('opaque-execution');
    const canceled = require('../headlessTaskLifetime').headlessTaskLifetime({ kcTaskLifetime: 'other' });
    canceled.cancel(); expect(canceled.isCurrent()).toBe(false);
  });
});
