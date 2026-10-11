const LOG_KEY = '@kinnship/location_engine_log_v1';

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

jest.mock('../androidTrackingRecovery', () => ({
  trackingIsRevoked: jest.fn(async () => false),
  trackingPolicyStamp: jest.fn(async () => null),
  verifyWakeOwnership: jest.fn(async () => 'allowed'),
  authorizeRevokedBatteryTransport: jest.fn(async () => null),
  migrateLegacyTrackingIntent: jest.fn(async () => false),
  BACKGROUND_PERMISSION_RATIONALE: {},
  authorizeTrackingIntent: jest.fn(), revokeTrackingIntent: jest.fn(),
  trackingIntentEpoch: () => 0,
  recoverUnexpectedlyDisabledTracking: jest.fn(async (_sdk, _current, authorized) => {
    authorized?.({ memberId: 'member-1', baseUrl: 'https://api.example',
      token: 'verified-test-session', isCurrent: async () => true });
    return 'already_enabled';
  }),
}));
jest.mock('../permissionCoordinator', () => ({
  readPermissionSnapshot: jest.fn(async () => ({
    foreground: 'granted', background: 'granted', notifications: 'granted',
  })),
  serializePermissionOperation: (operation: () => Promise<unknown>) => operation(),
}));

describe('headless activity wake recovery', () => {
  afterEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
  });

  it.each([
    ['motionchange', { isMoving: true }, null],
    ['activitychange', { activity: 'walking' }, 'walking'],
    ['activitychange', { activity: 'on_foot' }, 'on_foot'],
    ['activitychange', { activity: 'running' }, 'running'],
    ['activitychange', { activity: 'on_bicycle' }, 'on_bicycle'],
    ['activitychange', { activity: 'in_vehicle' }, 'in_vehicle'],
  ])(
    'forces and records a persisted upload for a moving %s headless event',
    async (eventName, params, expectedActivity) => {
    let headlessTask: ((event: any) => Promise<void>) | undefined;
    const mockGetCurrentPosition = jest.fn().mockResolvedValue({
      coords: { latitude: 47.6, longitude: -122.3, accuracy: 8 },
      timestamp: '2026-10-11T21:00:00.000Z',
    });
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200 } as Response);
    const storage = new Map<string, string>();
    const mockAsyncStorage = {
      getItem: jest.fn((key: string) => Promise.resolve(storage.get(key) ?? null)),
      setItem: jest.fn((key: string, value: string) => {
        storage.set(key, value);
        return Promise.resolve();
      }),
      removeItem: jest.fn((key: string) => {
        storage.delete(key);
        return Promise.resolve();
      }),
    };

    jest.isolateModules(() => {
      jest.mock('react-native', () => ({
        Platform: { OS: 'android' },
        AppState: { currentState: 'background' },
      }));
      jest.mock('@react-native-async-storage/async-storage', () => mockAsyncStorage);
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
          registerHeadlessTask: jest.fn((task) => { headlessTask = task; }),
          getState: jest.fn(async () => ({ enabled: true })),
          getCurrentPosition: mockGetCurrentPosition,
        },
      }));
      jest.mock('../api', () => ({ getCurrentToken: jest.fn(async () => 'verified-test-session'), api: { put: jest.fn() } }));
      jest.mock('expo-battery', () => ({}));

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../locationEngine');
    });

    expect(headlessTask).toBeDefined();
    await headlessTask!({
      name: eventName,
      params,
    });
    await flushPromises();

    expect(mockGetCurrentPosition).toHaveBeenCalledWith(expect.objectContaining({
      persist: false,
      extras: expect.objectContaining({ source: 'headless-motionchange' }),
    }));
    const entries = JSON.parse(storage.get(LOG_KEY) ?? '[]');
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'motion_recovery_start',
        detail: expect.objectContaining({
          trigger: eventName,
          activity: expectedActivity,
        }),
      }),
      expect.objectContaining({
        event: 'headless_heartbeat_ok',
        detail: { trigger: eventName },
      }),
    ]));
  });

  it.each([
    ['activitychange', { activity: 'still' }],
    ['activitychange', { activity: 'unknown' }],
    ['motionchange', { isMoving: false }],
  ])('does not wake GPS for a non-moving %s event', async (eventName, params) => {
    let headlessTask: ((event: any) => Promise<void>) | undefined;
    const mockGetCurrentPosition = jest.fn();
    const mockAsyncStorage = {
      getItem: jest.fn().mockResolvedValue(null),
      setItem: jest.fn().mockResolvedValue(undefined),
      removeItem: jest.fn().mockResolvedValue(undefined),
    };

    jest.isolateModules(() => {
      jest.mock('react-native', () => ({
        Platform: { OS: 'android' },
        AppState: { currentState: 'background' },
      }));
      jest.mock('@react-native-async-storage/async-storage', () => mockAsyncStorage);
      jest.mock('../diagSeq', () => ({ nextSeq: jest.fn().mockReturnValue(1) }));
      jest.mock('../diagBufferConfig', () => ({
        DIAG_BUFFER_SIZES: { engineLog: 100 },
        pruneBuffer: (entries: any[]) => entries,
      }));
      jest.mock('react-native-background-geolocation', () => ({
        default: {
          registerHeadlessTask: jest.fn((task) => { headlessTask = task; }),
          getCurrentPosition: mockGetCurrentPosition,
        },
      }));
      jest.mock('../api', () => ({ getCurrentToken: jest.fn(async () => 'verified-test-session'), api: { put: jest.fn() } }));
      jest.mock('expo-battery', () => ({}));

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../locationEngine');
    });

    await headlessTask!({
      name: eventName,
      params,
    });

    expect(mockGetCurrentPosition).not.toHaveBeenCalled();
  });
});