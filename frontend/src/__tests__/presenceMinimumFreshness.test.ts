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
            url: 'https://api.example/api/members/member-1/location',
            authorization: { accessToken: 'test-jwt' },
          }),
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
        detail: { error: 'background-battery-http-401' },
      }),
    ]));
    expect(mockFinish).toHaveBeenCalledWith('presence-refresh');
  });
});