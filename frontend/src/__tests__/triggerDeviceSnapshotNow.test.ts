/**
 * triggerDeviceSnapshotNow.test.ts  — Task #53
 *
 * Verifies that the diagnostic "Push my snapshot now" action correctly
 * propagates backend success and failure back to the caller rather than
 * always reporting success.
 *
 * Three cases:
 *   1. Engine not configured (start() never called) → { ok: false, error: '...not configured...' }
 *   2. PUT succeeds                                  → { ok: true }
 *   3. PUT fails (network/server error)              → { ok: false, error: <message> }
 *
 * The test uses jest.isolateModules so each case gets a fresh module
 * instance (and therefore a fresh null cachedConfig).  All native modules
 * are mocked so the suite runs in the plain Node test environment.
 *
 * Note: jest.mock() factory functions cannot reference out-of-scope
 * variables — each mock must be fully inlined.  Variables named with a
 * `mock` prefix are the only exception (Jest hoisting whitelist), which
 * is why `mockPut` is declared outside the isolateModules closure.
 */

const FAKE_CFG = {
  memberId:       'member-test-001',
  jwt:            'fake-jwt',
  backendBaseUrl: 'https://api.example.com',
};

describe('triggerDeviceSnapshotNow', () => {
  afterEach(() => {
    jest.resetModules();
  });

  // ── Case 1: not configured ──────────────────────────────────────────────────
  it('returns ok:false with a "not configured" message when the engine has never been started', async () => {
    let fn: (() => Promise<any>) | undefined;

    jest.isolateModules(() => {
      jest.mock('react-native', () => ({
        Platform: { OS: 'android' },
        AppState: { currentState: 'active' },
      }));
      jest.mock('@react-native-async-storage/async-storage', () => ({
        getItem: jest.fn().mockResolvedValue(null),
        setItem: jest.fn().mockResolvedValue(undefined),
        removeItem: jest.fn().mockResolvedValue(undefined),
      }));
      jest.mock('../diagSeq', () => ({ nextSeq: jest.fn().mockReturnValue(0) }));
      jest.mock('../diagBufferConfig', () => ({
        DIAG_BUFFER_SIZES: { engineLog: 50 },
        pruneBuffer: (arr: any[]) => arr,
      }));
      jest.mock('react-native-background-geolocation', () => ({
        default: {
          registerHeadlessTask: jest.fn(),
          getState: jest.fn().mockResolvedValue({ enabled: true, isMoving: false }),
          ready: jest.fn().mockResolvedValue({ enabled: true }),
          setConfig: jest.fn().mockResolvedValue(undefined),
          requestPermission: jest.fn().mockResolvedValue(3),
          start: jest.fn().mockResolvedValue(undefined),
          onHeartbeat: jest.fn().mockReturnValue({ remove: jest.fn() }),
          onLocation: jest.fn().mockReturnValue({ remove: jest.fn() }),
          onHttp: jest.fn().mockReturnValue({ remove: jest.fn() }),
          onMotionChange: jest.fn().mockReturnValue({ remove: jest.fn() }),
          onEnabledChange: jest.fn().mockReturnValue({ remove: jest.fn() }),
          onPowerSaveChange: jest.fn().mockReturnValue({ remove: jest.fn() }),
          onActivityChange: jest.fn().mockReturnValue({ remove: jest.fn() }),
        },
      }));
      jest.mock('../api', () => ({ api: { put: jest.fn() } }));

      // Import AFTER all mocks are registered
      const le = require('../locationEngine');
      // Do NOT call start() — cachedConfig stays null
      fn = le.triggerDeviceSnapshotNow;
    });

    const result = await fn!();
    expect(result.ok).toBe(false);
    expect((result as any).error).toMatch(/not configured/i);
  });

  // ── Case 2: PUT succeeds ────────────────────────────────────────────────────
  it('returns ok:true when the backend PUT succeeds', async () => {
    const mockPut = jest.fn().mockResolvedValue({ status: 200 });
    let fn: (() => Promise<any>) | undefined;
    let startFn: ((cfg: any) => Promise<void>) | undefined;

    jest.isolateModules(() => {
      jest.mock('react-native', () => ({
        Platform: { OS: 'android' },
        AppState: { currentState: 'active' },
      }));
      jest.mock('@react-native-async-storage/async-storage', () => ({
        getItem: jest.fn().mockResolvedValue(null),
        setItem: jest.fn().mockResolvedValue(undefined),
        removeItem: jest.fn().mockResolvedValue(undefined),
      }));
      jest.mock('../diagSeq', () => ({ nextSeq: jest.fn().mockReturnValue(0) }));
      jest.mock('../diagBufferConfig', () => ({
        DIAG_BUFFER_SIZES: { engineLog: 50 },
        pruneBuffer: (arr: any[]) => arr,
      }));
      jest.mock('react-native-background-geolocation', () => ({
        default: {
          registerHeadlessTask: jest.fn(),
          getState: jest.fn().mockResolvedValue({ enabled: true, isMoving: false }),
          ready: jest.fn().mockResolvedValue({ enabled: true }),
          setConfig: jest.fn().mockResolvedValue(undefined),
          requestPermission: jest.fn().mockResolvedValue(3),
          start: jest.fn().mockResolvedValue(undefined),
          onHeartbeat: jest.fn().mockReturnValue({ remove: jest.fn() }),
          onLocation: jest.fn().mockReturnValue({ remove: jest.fn() }),
          onHttp: jest.fn().mockReturnValue({ remove: jest.fn() }),
          onMotionChange: jest.fn().mockReturnValue({ remove: jest.fn() }),
          onEnabledChange: jest.fn().mockReturnValue({ remove: jest.fn() }),
          onPowerSaveChange: jest.fn().mockReturnValue({ remove: jest.fn() }),
          onActivityChange: jest.fn().mockReturnValue({ remove: jest.fn() }),
        },
      }));
      jest.mock('../api', () => ({ api: { put: mockPut } }));
      jest.mock('expo-battery', () => ({
        addBatteryStateListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
        addBatteryLevelListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
        getBatteryLevelAsync: jest.fn().mockResolvedValue(0.85),
        getBatteryStateAsync: jest.fn().mockResolvedValue(2),
      }));

      const le = require('../locationEngine');
      fn = le.triggerDeviceSnapshotNow;
      startFn = le.start;
    });

    // start() sets cachedConfig; triggerDeviceSnapshotNow() can then proceed to PUT
    await startFn!(FAKE_CFG);
    const result = await fn!();

    expect(result.ok).toBe(true);
    // Confirm the PUT was called with the correct endpoint
    const snapshotCall = mockPut.mock.calls.find(
      ([url]: [string]) => url === `/members/${FAKE_CFG.memberId}/device-snapshot`,
    );
    expect(snapshotCall).toBeDefined();
  });

  // ── Case 3: PUT fails ───────────────────────────────────────────────────────
  it('returns ok:false with the error message when the backend PUT fails', async () => {
    const mockPut = jest.fn().mockRejectedValue(new Error('Network request failed'));
    let fn: (() => Promise<any>) | undefined;
    let startFn: ((cfg: any) => Promise<void>) | undefined;

    jest.isolateModules(() => {
      jest.mock('react-native', () => ({
        Platform: { OS: 'android' },
        AppState: { currentState: 'active' },
      }));
      jest.mock('@react-native-async-storage/async-storage', () => ({
        getItem: jest.fn().mockResolvedValue(null),
        setItem: jest.fn().mockResolvedValue(undefined),
        removeItem: jest.fn().mockResolvedValue(undefined),
      }));
      jest.mock('../diagSeq', () => ({ nextSeq: jest.fn().mockReturnValue(0) }));
      jest.mock('../diagBufferConfig', () => ({
        DIAG_BUFFER_SIZES: { engineLog: 50 },
        pruneBuffer: (arr: any[]) => arr,
      }));
      jest.mock('react-native-background-geolocation', () => ({
        default: {
          registerHeadlessTask: jest.fn(),
          getState: jest.fn().mockResolvedValue({ enabled: true, isMoving: false }),
          ready: jest.fn().mockResolvedValue({ enabled: true }),
          setConfig: jest.fn().mockResolvedValue(undefined),
          requestPermission: jest.fn().mockResolvedValue(3),
          start: jest.fn().mockResolvedValue(undefined),
          onHeartbeat: jest.fn().mockReturnValue({ remove: jest.fn() }),
          onLocation: jest.fn().mockReturnValue({ remove: jest.fn() }),
          onHttp: jest.fn().mockReturnValue({ remove: jest.fn() }),
          onMotionChange: jest.fn().mockReturnValue({ remove: jest.fn() }),
          onEnabledChange: jest.fn().mockReturnValue({ remove: jest.fn() }),
          onPowerSaveChange: jest.fn().mockReturnValue({ remove: jest.fn() }),
          onActivityChange: jest.fn().mockReturnValue({ remove: jest.fn() }),
        },
      }));
      jest.mock('../api', () => ({ api: { put: mockPut } }));
      jest.mock('expo-battery', () => ({
        addBatteryStateListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
        addBatteryLevelListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
        getBatteryLevelAsync: jest.fn().mockResolvedValue(0.85),
        getBatteryStateAsync: jest.fn().mockResolvedValue(2),
      }));

      const le = require('../locationEngine');
      fn = le.triggerDeviceSnapshotNow;
      startFn = le.start;
    });

    await startFn!(FAKE_CFG);
    const result = await fn!();

    expect(result.ok).toBe(false);
    expect((result as any).error).toMatch(/Network request failed/);
  });
});
