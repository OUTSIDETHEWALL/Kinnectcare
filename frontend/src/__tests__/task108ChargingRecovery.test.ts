/**
 * Task 108 — charging recovery after a long offline period.
 *
 * The test member can remain stationary long enough for Android to kill the main JS
 * runtime.  The caregiver-facing charging badge must still recover from the
 * next Transistor heartbeat, without requiring the test member to open the app.
 *
 * This test intentionally invokes only the registered native-context
 * headless task.  It does not call start(), attach foreground listeners, or
 * use expo-battery, matching the production path available after a force-kill.
 */

import { getBatteryDisplay } from '../batteryStatus';

const BATTERY_URL = 'https://api.example.com/api/members/member-001/battery';
const LOG_KEY = '@kinnship/location_engine_log_v1';

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
}

describe('Task 108 — headless charging recovery', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-24T12:20:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.resetModules();
    jest.restoreAllMocks();
    delete (globalThis as { fetch?: unknown }).fetch;
  });

  it('updates the caregiver badge on the next heartbeat after plug-in, without app open', async () => {
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
    const fetchMock = jest.fn().mockResolvedValue({ status: 200 });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    let headlessTask:
      | ((event: { name: string }) => Promise<void>)
      | undefined;
    const getCurrentPosition = jest.fn().mockResolvedValue({
      battery: { level: 0.18, is_charging: true },
    });
    const registerHeadlessTask = jest.fn((task: typeof headlessTask) => {
      headlessTask = task;
    });

    jest.isolateModules(() => {
      jest.doMock('react-native', () => ({
        Platform: { OS: 'android' },
        AppState: { currentState: 'background' },
      }));
      jest.doMock('@react-native-async-storage/async-storage', () => asyncStorage);
      jest.doMock('../diagSeq', () => ({
        nextSeq: jest.fn().mockReturnValue(1),
      }));
      jest.doMock('../diagBufferConfig', () => ({
        DIAG_BUFFER_SIZES: { engineLog: 50 },
        pruneBuffer: (entries: unknown[]) => entries,
      }));
      jest.doMock('../backgroundLocationDisclosure', () => ({
        ensureBackgroundLocationDisclosure: jest.fn().mockResolvedValue(undefined),
      }));
      jest.doMock('react-native-background-geolocation', () => ({
        default: {
          registerHeadlessTask,
          getCurrentPosition,
          getState: jest.fn().mockResolvedValue({
            enabled: true,
            url: 'https://api.example.com/api/members/member-001/location',
            authorization: { accessToken: 'headless-jwt' },
          }),
          start: jest.fn().mockResolvedValue(undefined),
        },
      }));

      // Importing the engine registers the callback at module load.  No
      // foreground start() or JS heartbeat listener is involved.
      require('../locationEngine');
    });

    expect(registerHeadlessTask).toHaveBeenCalledTimes(1);
    expect(headlessTask).toBeDefined();

    // The last known reading is from a long stationary/offline period: the
    // caregiver currently sees a stale, non-charging battery state.
    const offlineReadingAt = new Date(
      Date.now() - 20 * 60_000,
    ).toISOString();
    expect(getBatteryDisplay(0.18, false, offlineReadingAt)).toMatchObject({
      statusText: '🔴 18% · Low',
      tone: 'low',
    });

    // The test member plugs in after a long stationary/offline period.  The next
    // heartbeat is one minute later, comfortably inside the two-minute SLO.
    const pluggedInAt = Date.now();
    jest.advanceTimersByTime(60_000);
    const heartbeatAt = Date.now();
    await headlessTask!({ name: 'heartbeat' });
    await flushPromises();

    expect(heartbeatAt - pluggedInAt).toBeLessThanOrEqual(2 * 60_000);
    expect(getCurrentPosition).toHaveBeenCalledWith(
      expect.objectContaining({
        samples: 1,
        persist: true,
        extras: { source: 'headless-heartbeat' },
      }),
    );

    const batteryPatch = fetchMock.mock.calls.find(
      ([url]: [string]) => url === BATTERY_URL,
    );
    expect(batteryPatch).toBeDefined();
    const patchBody = JSON.parse(batteryPatch![1].body as string) as {
      battery_level: number;
      is_charging: boolean;
      battery_updated_at: string;
    };
    expect(patchBody).toMatchObject({
      battery_level: 0.18,
      is_charging: true,
    });
    expect(new Date(patchBody.battery_updated_at).getTime()).toBe(heartbeatAt);

    const engineLog = JSON.parse(storage.get(LOG_KEY) ?? '[]') as Array<{
      event: string;
      detail?: { battCharging?: boolean };
    }>;
    expect(
      engineLog.some(
        (entry) =>
          entry.event === 'headless_battery_patch_ok' &&
          entry.detail?.battCharging === true,
      ),
    ).toBe(true);

    // The dashboard card consumes the server member values through this
    // formatter.  A successful headless PATCH therefore renders the
    // caregiver-visible charging badge immediately on the next dashboard
    // refresh, rather than waiting for an app-open battery read.
    expect(
      getBatteryDisplay(
        patchBody.battery_level,
        patchBody.is_charging,
        patchBody.battery_updated_at,
      ),
    ).toMatchObject({
      statusText: '🔌 Charging · 18%',
      tone: 'charging',
    });
  });
});