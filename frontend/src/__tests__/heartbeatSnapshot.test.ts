/**
 * heartbeatSnapshot.test.ts  — Task #56
 *
 * Confirms that pushDeviceSnapshotToBackend() fires on EVERY JS heartbeat,
 * not just when the last HTTP upload was >5 min old.
 *
 * Background: Task #32 moved the pushDeviceSnapshotToBackend() call outside
 * the stale-detection gate so Charles's Device Comparison table shows fresh
 * pipeline ages for Joyce during normal operation — not only after an upload
 * gap.  These tests guard that the two concerns stay separated:
 *
 *   • Snapshot push   — always fires (confirms Task #32 is intact)
 *   • Stale log entry — only fires when http_ok age > 5 min (no noise)
 *
 * Two cases:
 *   1. HTTP upload is recent (30 s ago)  → snapshot pushed, stale log NOT written
 *   2. HTTP upload is stale (6 min ago)  → snapshot pushed, stale log IS written
 *
 * Note: jest.mock() factory functions inside jest.isolateModules() are NOT
 * hoisted to the top of the file, so they CAN reference variables defined
 * in the enclosing it() scope — the hoisting whitelist restriction applies
 * only to top-level jest.mock() calls.
 */

const FAKE_CFG = {
  memberId: 'member-joyce-001',
  jwt: 'fake-jwt-token',
  backendBaseUrl: 'https://api.example.com',
};

const LOG_KEY = '@kinnship/location_engine_log_v1';
const HTTP_OK_TS_KEY = 'kc_pts_http_ok';

/**
 * Flush microtasks queued by the fire-and-forget inner IIFE inside the
 * onHeartbeat handler.  The IIFE is `void`-ed so `await heartbeatCb()` returns
 * before it finishes.  With all inner promises resolved immediately (mocks),
 * multiple `await Promise.resolve()` hops drain the microtask queue.
 */
async function flushPromises(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
}

/** Last value written to LOG_KEY in an AsyncStorage mock, parsed as an array. */
function getLogEntries(mockSetItem: jest.Mock): any[] {
  const logCalls = mockSetItem.mock.calls.filter(
    ([key]: [string]) => key === LOG_KEY,
  );
  if (logCalls.length === 0) return [];
  const lastJson: string = logCalls[logCalls.length - 1][1];
  try {
    return JSON.parse(lastJson) as any[];
  } catch {
    return [];
  }
}

describe('onHeartbeat → pushDeviceSnapshotToBackend (Task #56)', () => {
  afterEach(() => {
    jest.resetModules();
  });

  // ── Case 1: HTTP upload is fresh ─────────────────────────────────────────────
  it('pushes a device snapshot on every heartbeat even when uploads are fresh (< 5 min)', async () => {
    const mockPut = jest.fn().mockResolvedValue({ status: 204 });
    const mockOnHeartbeat = jest.fn().mockReturnValue({ remove: jest.fn() });
    const mockGetState = jest
      .fn()
      .mockResolvedValue({ enabled: true, isMoving: false, trackingMode: 1 });
    const freshTs = String(Date.now() - 30_000); // 30 s ago — clearly fresh
    const mockAsyncStorage = {
      getItem: jest.fn().mockImplementation((key: string) => {
        if (key === HTTP_OK_TS_KEY) return Promise.resolve(freshTs);
        return Promise.resolve(null);
      }),
      setItem: jest.fn().mockResolvedValue(undefined),
      removeItem: jest.fn().mockResolvedValue(undefined),
    };

    let startFn: ((cfg: any) => Promise<void>) | undefined;

    jest.isolateModules(() => {
      jest.mock('react-native', () => ({
        Platform: { OS: 'android' },
        AppState: { currentState: 'active' },
      }));
      jest.mock('@react-native-async-storage/async-storage', () => mockAsyncStorage);
      jest.mock('../diagSeq', () => ({ nextSeq: jest.fn().mockReturnValue(0) }));
      jest.mock('../diagBufferConfig', () => ({
        DIAG_BUFFER_SIZES: { engineLog: 50 },
        pruneBuffer: (arr: any[]) => arr,
      }));
      jest.mock('react-native-background-geolocation', () => ({
        default: {
          registerHeadlessTask: jest.fn(),
          getState: mockGetState,
          ready: jest.fn().mockResolvedValue({ enabled: true }),
          setConfig: jest.fn().mockResolvedValue(undefined),
          requestPermission: jest.fn().mockResolvedValue(3),
          start: jest.fn().mockResolvedValue({ enabled: true }),
          onHeartbeat: mockOnHeartbeat,
          onLocation: jest.fn().mockReturnValue({ remove: jest.fn() }),
          onHttp: jest.fn().mockReturnValue({ remove: jest.fn() }),
          onMotionChange: jest.fn().mockReturnValue({ remove: jest.fn() }),
          onProviderChange: jest.fn().mockReturnValue({ remove: jest.fn() }),
          onEnabledChange: jest.fn().mockReturnValue({ remove: jest.fn() }),
          onPowerSaveChange: jest.fn().mockReturnValue({ remove: jest.fn() }),
          onActivityChange: jest.fn().mockReturnValue({ remove: jest.fn() }),
          getCurrentPosition: jest.fn().mockResolvedValue({
            coords: { latitude: 47.6, longitude: -122.3, accuracy: 10 },
          }),
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
      startFn = le.start;
    });

    await startFn!(FAKE_CFG);

    // Capture the heartbeat callback that start() registered via attachSdkListeners
    expect(mockOnHeartbeat.mock.calls.length).toBeGreaterThan(0);
    const heartbeatCb: () => Promise<void> = mockOnHeartbeat.mock.calls[0][0];
    expect(typeof heartbeatCb).toBe('function');

    // Fire one heartbeat cycle
    mockPut.mockClear();
    await heartbeatCb();
    await flushPromises();

    // ── Assertion 1: snapshot is pushed ──────────────────────────────────────
    const snapshotCall = mockPut.mock.calls.find(
      ([url]: [string]) => url === `/members/${FAKE_CFG.memberId}/device-snapshot`,
    );
    expect(snapshotCall).toBeDefined();

    // ── Assertion 2: stale log NOT written (uploads are healthy) ─────────────
    const logEntries = getLogEntries(mockAsyncStorage.setItem);
    const hasStale = logEntries.some((e: any) => e.event === 'engine_snapshot_stale');
    expect(hasStale).toBe(false);
  });

  // ── Case 2: HTTP upload is stale ─────────────────────────────────────────────
  it('pushes a device snapshot AND writes engine_snapshot_stale when uploads are stale (> 5 min)', async () => {
    const mockPut = jest.fn().mockResolvedValue({ status: 204 });
    const mockOnHeartbeat = jest.fn().mockReturnValue({ remove: jest.fn() });
    const mockGetState = jest
      .fn()
      .mockResolvedValue({ enabled: true, isMoving: false, trackingMode: 1 });
    const staleTs = String(Date.now() - 6 * 60_000); // 6 min ago — past the 5-min gate
    const mockAsyncStorage = {
      getItem: jest.fn().mockImplementation((key: string) => {
        if (key === HTTP_OK_TS_KEY) return Promise.resolve(staleTs);
        return Promise.resolve(null);
      }),
      setItem: jest.fn().mockResolvedValue(undefined),
      removeItem: jest.fn().mockResolvedValue(undefined),
    };

    let startFn: ((cfg: any) => Promise<void>) | undefined;

    jest.isolateModules(() => {
      jest.mock('react-native', () => ({
        Platform: { OS: 'android' },
        AppState: { currentState: 'active' },
      }));
      jest.mock('@react-native-async-storage/async-storage', () => mockAsyncStorage);
      jest.mock('../diagSeq', () => ({ nextSeq: jest.fn().mockReturnValue(0) }));
      jest.mock('../diagBufferConfig', () => ({
        DIAG_BUFFER_SIZES: { engineLog: 50 },
        pruneBuffer: (arr: any[]) => arr,
      }));
      jest.mock('react-native-background-geolocation', () => ({
        default: {
          registerHeadlessTask: jest.fn(),
          getState: mockGetState,
          ready: jest.fn().mockResolvedValue({ enabled: true }),
          setConfig: jest.fn().mockResolvedValue(undefined),
          requestPermission: jest.fn().mockResolvedValue(3),
          start: jest.fn().mockResolvedValue({ enabled: true }),
          onHeartbeat: mockOnHeartbeat,
          onLocation: jest.fn().mockReturnValue({ remove: jest.fn() }),
          onHttp: jest.fn().mockReturnValue({ remove: jest.fn() }),
          onMotionChange: jest.fn().mockReturnValue({ remove: jest.fn() }),
          onProviderChange: jest.fn().mockReturnValue({ remove: jest.fn() }),
          onEnabledChange: jest.fn().mockReturnValue({ remove: jest.fn() }),
          onPowerSaveChange: jest.fn().mockReturnValue({ remove: jest.fn() }),
          onActivityChange: jest.fn().mockReturnValue({ remove: jest.fn() }),
          getCurrentPosition: jest.fn().mockResolvedValue({
            coords: { latitude: 47.6, longitude: -122.3, accuracy: 10 },
          }),
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
      startFn = le.start;
    });

    await startFn!(FAKE_CFG);

    const heartbeatCb: () => Promise<void> = mockOnHeartbeat.mock.calls[0][0];
    expect(typeof heartbeatCb).toBe('function');

    mockPut.mockClear();
    await heartbeatCb();
    await flushPromises();

    // ── Assertion 1: snapshot is pushed even when stale ───────────────────────
    const snapshotCall = mockPut.mock.calls.find(
      ([url]: [string]) => url === `/members/${FAKE_CFG.memberId}/device-snapshot`,
    );
    expect(snapshotCall).toBeDefined();

    // ── Assertion 2: stale log IS written (the diagnostic entry fires) ────────
    const logEntries = getLogEntries(mockAsyncStorage.setItem);
    const hasStale = logEntries.some((e: any) => e.event === 'engine_snapshot_stale');
    expect(hasStale).toBe(true);

    // ── Assertion 3: the stale entry carries http_ok_age_ms ───────────────────
    const staleEntry = logEntries.find((e: any) => e.event === 'engine_snapshot_stale');
    expect(staleEntry?.detail?.http_ok_age_ms).toBeGreaterThan(5 * 60_000);
  });
});
