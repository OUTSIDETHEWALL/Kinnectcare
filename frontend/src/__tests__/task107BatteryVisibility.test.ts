/**
 * Task 107 — stationary / force-killed battery visibility.
 *
 * The dashboard must keep showing the last known battery state while Joyce's
 * phone is stationary or the main JS runtime has been killed.  The headless
 * Transistor heartbeat is the independent path that refreshes the backend and
 * records diagnostic evidence in that situation.
 */

import { getBatteryDisplay } from '../batteryStatus';

describe('Task 107 — caregiver battery row during a long stationary period', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-24T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('keeps a healthy battery row visible after 20 minutes without a new reading', () => {
    const readingAt = new Date(Date.now() - 20 * 60_000).toISOString();

    const display = getBatteryDisplay(0.82, false, readingAt);

    expect(display).not.toBeNull();
    expect(display?.statusText).toBe('🟢 82%');
    expect(display?.ageLabel).toBe('Updated 20 min ago');
  });

  it('keeps the charging or low state visible three minutes after a force-kill', () => {
    const readingAt = new Date(Date.now() - 23 * 60_000).toISOString();

    expect(getBatteryDisplay(0.18, false, readingAt)).toMatchObject({
      statusText: '🔴 18% · Low',
      ageLabel: 'Updated 23 min ago',
      tone: 'low',
    });
    expect(getBatteryDisplay(0.18, true, readingAt)).toMatchObject({
      statusText: '🔌 Charging · 18%',
      ageLabel: 'Updated 23 min ago',
      tone: 'charging',
    });
  });

  it('hides the row only when no battery reading has ever been recorded', () => {
    expect(getBatteryDisplay(null, false, null)).toBeNull();
    expect(getBatteryDisplay(undefined, false, undefined)).toBeNull();
  });
});

describe('Task 107 — headless heartbeat battery path', () => {
  afterEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
    delete (globalThis as { fetch?: unknown }).fetch;
  });

  it('PATCHes battery and records headless_battery_patch_ok without the main JS runtime', async () => {
    const storage = new Map<string, string>();
    const asyncStorage = {
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
    let headlessTask: ((event: { name: string }) => Promise<void>) | undefined;
    const fetchMock = jest.fn().mockResolvedValue({ status: 200 });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    jest.isolateModules(() => {
      jest.doMock('react-native', () => ({
        Platform: { OS: 'android' },
        AppState: { currentState: 'background' },
      }));
      jest.doMock('@react-native-async-storage/async-storage', () => asyncStorage);
      jest.doMock('../diagSeq', () => ({ nextSeq: jest.fn().mockReturnValue(1) }));
      jest.doMock('../diagBufferConfig', () => ({
        DIAG_BUFFER_SIZES: { engineLog: 50 },
        pruneBuffer: (entries: unknown[]) => entries,
      }));
      jest.doMock('../backgroundLocationDisclosure', () => ({
        ensureBackgroundLocationDisclosure: jest.fn().mockResolvedValue(undefined),
      }));
      jest.doMock('react-native-background-geolocation', () => ({
        default: {
          registerHeadlessTask: jest.fn((task: typeof headlessTask) => {
            headlessTask = task;
          }),
          getCurrentPosition: jest.fn().mockResolvedValue({
            battery: { level: 0.82, is_charging: 0 },
          }),
          getState: jest.fn().mockResolvedValue({
            enabled: true,
            url: 'https://api.example.com/api/members/joyce-001/location',
            authorization: { accessToken: 'headless-jwt' },
          }),
          start: jest.fn().mockResolvedValue(undefined),
        },
      }));

      // Importing the module registers the callback at module load.  No
      // foreground start() or JS heartbeat listener is involved here.
      require('../locationEngine');
    });

    expect(headlessTask).toBeDefined();
    await headlessTask!({ name: 'heartbeat' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/api/members/joyce-001/battery',
      expect.objectContaining({
        method: 'PATCH',
        headers: expect.objectContaining({
          Authorization: 'Bearer headless-jwt',
        }),
        body: expect.stringContaining('"battery_level":0.82'),
      }),
    );

    const engineLog = JSON.parse(storage.get('@kinnship/location_engine_log_v1') ?? '[]');
    expect(engineLog.some((entry: { event: string }) =>
      entry.event === 'headless_battery_patch_ok',
    )).toBe(true);
    expect(storage.get('kc_pts_hl_bat')).toEqual(expect.any(String));
  });
});