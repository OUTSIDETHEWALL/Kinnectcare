const ENGINE_LOG_KEY = '@kinnship/location_engine_log_v1';
const BATTERY_LOG_KEY = '@kinnship/battery_task_log_v1';

function storageMock() {
  const data = new Map<string, string>();
  return {
    data,
    api: {
      getItem: jest.fn((key: string) => Promise.resolve(data.get(key) ?? null)),
      setItem: jest.fn((key: string, value: string) => {
        data.set(key, value);
        return Promise.resolve();
      }),
      removeItem: jest.fn((key: string) => {
        data.delete(key);
        return Promise.resolve();
      }),
    },
  };
}

describe('minimum device-presence freshness', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
  });

  it('PATCHes heartbeat battery presence even when the GPS request fails', async () => {
    let mockHeadlessTask: ((event: any) => Promise<void>) | undefined;
    const mockStorage = storageMock();
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const mockGetCurrentPosition = jest.fn().mockRejectedValue(new Error('gps unavailable'));
    const mockGetState = jest.fn().mockResolvedValue({
      enabled: true,
      url: 'https://api.example/api/members/member-1/location',
      authorization: { accessToken: 'test-jwt' },
    });
    (global as any).fetch = fetchMock;

    jest.isolateModules(() => {
      jest.mock('react-native', () => ({
        Platform: { OS: 'android' },
        AppState: { currentState: 'background' },
      }));
      jest.mock('@react-native-async-storage/async-storage', () => mockStorage.api);
      jest.mock('../diagSeq', () => {
        let seq = 0;
        return { nextSeq: () => ++seq };
      });
      jest.mock('../diagBufferConfig', () => ({
        DIAG_BUFFER_SIZES: { engineLog: 100 },
        pruneBuffer: (entries: any[]) => entries,
      }));
      jest.mock('react-native-background-geolocation', () => ({
        default: {
          registerHeadlessTask: jest.fn((task) => { mockHeadlessTask = task; }),
          getCurrentPosition: mockGetCurrentPosition,
          getState: mockGetState,
        },
      }));
      jest.mock('../api', () => ({ api: { put: jest.fn() } }));
      jest.mock('expo-battery', () => ({}));
      require('../locationEngine');
    });

    await mockHeadlessTask!({
      name: 'heartbeat',
      params: {
        location: {
          battery: { level: 0.82, is_charging: 1 },
        },
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example/api/members/member-1/battery',
      expect.objectContaining({
        method: 'PATCH',
        headers: expect.objectContaining({
          'X-Kinnship-Presence-Source': 'battery-task',
        }),
      }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(expect.objectContaining({
      battery_level: 0.82,
      is_charging: true,
    }));
    expect(mockGetCurrentPosition).toHaveBeenCalled();

    const log = JSON.parse(mockStorage.data.get(ENGINE_LOG_KEY) ?? '[]');
    expect(log).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'headless_battery_patch_ok' }),
      expect.objectContaining({ event: 'headless_heartbeat_error' }),
    ]));
  });

  it('targets 30 minutes and never records an HTTP failure as successful', async () => {
    let mockConfiguredHandler: ((taskId: string) => Promise<void>) | undefined;
    const mockStorage = storageMock();
    const mockFinish = jest.fn();
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 401 });
    const mockGetCurrentPosition = jest.fn().mockResolvedValue({
      timestamp: '2026-09-14T19:14:13.577Z',
      coords: { accuracy: 10 },
    });
    (global as any).fetch = fetchMock;

    jest.isolateModules(() => {
      jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
      jest.mock('@react-native-async-storage/async-storage', () => mockStorage.api);
      jest.mock('expo-battery', () => ({
        BatteryState: { CHARGING: 2, FULL: 5 },
        getBatteryLevelAsync: jest.fn().mockResolvedValue(0.64),
        getBatteryStateAsync: jest.fn().mockResolvedValue(2),
      }));
      jest.mock('react-native-background-geolocation', () => ({
        default: {
          getState: jest.fn().mockResolvedValue({
            enabled: true,
            url: 'https://api.example/api/members/member-1/location',
            authorization: { accessToken: 'test-jwt' },
          }),
          getCurrentPosition: mockGetCurrentPosition,
        },
      }));
      jest.mock('react-native-background-fetch', () => ({
        default: {
          NETWORK_TYPE_ANY: 0,
          registerHeadlessTask: jest.fn(),
          finish: mockFinish,
          configure: jest.fn((options, handler) => {
            mockConfiguredHandler = handler;
            expect(options.minimumFetchInterval).toBe(30);
            return Promise.resolve(2);
          }),
        },
      }));

      const task = require('../batteryTask');
      expect(task.BATTERY_TASK_INTERVAL_MINUTES).toBe(30);
      void task.configureBatteryTask();
    });

    await Promise.resolve();
    await mockConfiguredHandler!('presence-refresh');

    const log = JSON.parse(mockStorage.data.get(BATTERY_LOG_KEY) ?? '[]');
    expect(log.some((entry: any) => entry.event === 'background_battery_ok')).toBe(false);
    expect(log).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'background_battery_error',
        detail: expect.objectContaining({ error: 'background-battery-http-401' }),
      }),
      expect.objectContaining({
        event: 'background_location_persisted',
        detail: expect.objectContaining({ persisted: true }),
      }),
    ]));
    expect(mockGetCurrentPosition).toHaveBeenCalledWith({
      samples: 1,
      persist: true,
      timeout: 20,
      extras: { source: 'workmanager-stationary-refresh' },
    });
    expect(mockFinish).toHaveBeenCalledWith('presence-refresh');
  });

  it('still requests a persisted stationary position when battery auth state is missing', async () => {
    let mockConfiguredHandler: ((taskId: string) => Promise<void>) | undefined;
    const mockStorage = storageMock();
    const mockFinish = jest.fn();
    const mockGetCurrentPosition = jest.fn().mockResolvedValue({
      timestamp: '2026-09-14T19:14:13.577Z',
      coords: { accuracy: 18.6 },
    });

    jest.isolateModules(() => {
      jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
      jest.mock('@react-native-async-storage/async-storage', () => mockStorage.api);
      jest.mock('expo-battery', () => ({
        BatteryState: { CHARGING: 2, FULL: 5 },
        getBatteryLevelAsync: jest.fn().mockResolvedValue(0.6),
        getBatteryStateAsync: jest.fn().mockResolvedValue(1),
      }));
      jest.mock('react-native-background-geolocation', () => ({
        default: {
          getState: jest.fn().mockResolvedValue({
            enabled: true,
            url: '',
            authorization: {},
          }),
          getCurrentPosition: mockGetCurrentPosition,
        },
      }));
      jest.mock('react-native-background-fetch', () => ({
        default: {
          NETWORK_TYPE_ANY: 0,
          registerHeadlessTask: jest.fn(),
          finish: mockFinish,
          configure: jest.fn((_options, handler) => {
            mockConfiguredHandler = handler;
            return Promise.resolve(2);
          }),
        },
      }));

      const task = require('../batteryTask');
      void task.configureBatteryTask();
    });

    await Promise.resolve();
    await mockConfiguredHandler!('stationary-refresh');

    expect(mockGetCurrentPosition).toHaveBeenCalledWith(expect.objectContaining({
      persist: true,
      extras: { source: 'workmanager-stationary-refresh' },
    }));
    const log = JSON.parse(mockStorage.data.get(BATTERY_LOG_KEY) ?? '[]');
    expect(log).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'background_battery_skipped',
        detail: expect.objectContaining({ reason: 'missing_member_id_or_jwt' }),
      }),
      expect.objectContaining({
        event: 'background_location_persisted',
        detail: expect.objectContaining({ accuracy: 19, persisted: true }),
      }),
    ]));
    expect(mockFinish).toHaveBeenCalledTimes(1);
    expect(mockFinish).toHaveBeenCalledWith('stationary-refresh');
  });

  it('does not request a position when location tracking is disabled', async () => {
    let mockConfiguredHandler: ((taskId: string) => Promise<void>) | undefined;
    const mockStorage = storageMock();
    const mockFinish = jest.fn();
    const mockGetCurrentPosition = jest.fn();
    (global as any).fetch = jest.fn().mockResolvedValue({ status: 200 });

    jest.isolateModules(() => {
      jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
      jest.mock('@react-native-async-storage/async-storage', () => mockStorage.api);
      jest.mock('expo-battery', () => ({
        BatteryState: { CHARGING: 2, FULL: 5 },
        getBatteryLevelAsync: jest.fn().mockResolvedValue(0.6),
        getBatteryStateAsync: jest.fn().mockResolvedValue(1),
      }));
      jest.mock('react-native-background-geolocation', () => ({
        default: {
          getState: jest.fn().mockResolvedValue({
            enabled: false,
            url: 'https://api.example/api/members/member-1/location',
            authorization: { accessToken: 'test-jwt' },
          }),
          getCurrentPosition: mockGetCurrentPosition,
        },
      }));
      jest.mock('react-native-background-fetch', () => ({
        default: {
          NETWORK_TYPE_ANY: 0,
          registerHeadlessTask: jest.fn(),
          finish: mockFinish,
          configure: jest.fn((_options, handler) => {
            mockConfiguredHandler = handler;
            return Promise.resolve(2);
          }),
        },
      }));

      const task = require('../batteryTask');
      void task.configureBatteryTask();
    });

    await Promise.resolve();
    await mockConfiguredHandler!('tracking-disabled');

    expect(mockGetCurrentPosition).not.toHaveBeenCalled();
    const log = JSON.parse(mockStorage.data.get(BATTERY_LOG_KEY) ?? '[]');
    expect(log).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'background_location_skipped',
        detail: expect.objectContaining({
          taskId: 'tracking-disabled',
          reason: 'tracking_disabled',
        }),
      }),
    ]));
    expect(mockFinish).toHaveBeenCalledTimes(1);
  });

  it('keeps a timed-out execution from finishing or logging into the next run with the same task ID', async () => {
    let mockConfiguredHandler: ((taskId: string) => Promise<void>) | undefined;
    let mockTimeoutHandler: ((taskId: string) => Promise<void>) | undefined;
    const locationResolvers: ((value: {
      timestamp: string;
      coords: { accuracy: number };
    }) => void)[] = [];
    const mockStorage = storageMock();
    const mockFinish = jest.fn();
    const mockGetCurrentPosition = jest.fn(() => new Promise((resolve) => {
      locationResolvers.push(resolve);
    }));
    (global as any).fetch = jest.fn().mockResolvedValue({ status: 200 });

    jest.isolateModules(() => {
      jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
      jest.mock('@react-native-async-storage/async-storage', () => mockStorage.api);
      jest.mock('expo-battery', () => ({
        BatteryState: { CHARGING: 2, FULL: 5 },
        getBatteryLevelAsync: jest.fn().mockResolvedValue(0.6),
        getBatteryStateAsync: jest.fn().mockResolvedValue(1),
      }));
      jest.mock('react-native-background-geolocation', () => ({
        default: {
          getState: jest.fn().mockResolvedValue({
            enabled: true,
            url: 'https://api.example/api/members/member-1/location',
            authorization: { accessToken: 'test-jwt' },
          }),
          getCurrentPosition: mockGetCurrentPosition,
        },
      }));
      jest.mock('react-native-background-fetch', () => ({
        default: {
          NETWORK_TYPE_ANY: 0,
          registerHeadlessTask: jest.fn(),
          finish: mockFinish,
          configure: jest.fn((_options, handler, timeoutHandler) => {
            mockConfiguredHandler = handler;
            mockTimeoutHandler = timeoutHandler;
            return Promise.resolve(2);
          }),
        },
      }));

      const task = require('../batteryTask');
      void task.configureBatteryTask();
    });

    await Promise.resolve();
    const firstExecution = mockConfiguredHandler!('reused-task-id');
    for (let i = 0; i < 5 && !mockGetCurrentPosition.mock.calls.length; i += 1) {
      await Promise.resolve();
    }
    await mockTimeoutHandler!('reused-task-id');
    expect(mockFinish).toHaveBeenCalledTimes(1);

    const secondExecution = mockConfiguredHandler!('reused-task-id');
    for (let i = 0; i < 5 && mockGetCurrentPosition.mock.calls.length < 2; i += 1) {
      await Promise.resolve();
    }

    locationResolvers[0]({
      timestamp: '2026-09-14T19:14:13.000Z',
      coords: { accuracy: 11 },
    });
    await firstExecution;

    expect(mockFinish).toHaveBeenCalledTimes(1);

    locationResolvers[1]({
      timestamp: '2026-09-14T19:14:45.000Z',
      coords: { accuracy: 9 },
    });
    await secondExecution;

    expect(mockFinish).toHaveBeenCalledTimes(2);
    expect(mockFinish).toHaveBeenNthCalledWith(1, 'reused-task-id');
    expect(mockFinish).toHaveBeenNthCalledWith(2, 'reused-task-id');
    const log = JSON.parse(mockStorage.data.get(BATTERY_LOG_KEY) ?? '[]');
    expect(log).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'background_battery_timeout',
        detail: { taskId: 'reused-task-id' },
      }),
      expect.objectContaining({
        event: 'background_location_persisted',
        detail: expect.objectContaining({
          taskId: 'reused-task-id',
          capturedAt: '2026-09-14T19:14:45.000Z',
        }),
      }),
    ]));
    expect(log).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'background_location_persisted',
        detail: expect.objectContaining({
          capturedAt: '2026-09-14T19:14:13.000Z',
        }),
      }),
    ]));
  });
});