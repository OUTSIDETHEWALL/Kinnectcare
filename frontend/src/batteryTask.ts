/**
 * batteryTask.ts — Independent battery refresh subsystem (Build XX).
 *
 * Provides a periodic WorkManager (Android) / BGTaskScheduler (iOS) background
 * task that fires roughly every 4 hours and PATCHes /battery regardless of
 * whether the device has moved or the Transistor SDK is active.
 *
 * Architecture:
 *   Movement → BackgroundGeolocation → battery PATCH   (existing path, unchanged)
 *   Timer    → BackgroundFetch task  → battery PATCH   (this file — new path)
 *
 * Both paths call the same PATCH /members/{id}/battery endpoint.  The backend
 * write-guard (incoming_ts > stored_ts) ensures the most recent reading wins.
 *
 * Implementation uses react-native-background-fetch (Transistor SDK companion
 * library, already native-linked in the build) rather than expo-background-task
 * (not yet in the native build — would require a full rebuild to add).
 * react-native-background-fetch uses WorkManager on Android and BGTaskScheduler
 * on iOS, exactly the same as expo-background-task under the hood.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

type BackgroundFetchModule = typeof import('react-native-background-fetch').default;

function getBackgroundFetch(): BackgroundFetchModule | null {
  if (Platform.OS === 'web') return null;
  // Lazy-load the native module so Expo web can render without evaluating
  // react-native-background-fetch's Android-only native bridge.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('react-native-background-fetch').default as BackgroundFetchModule;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** BackgroundFetch task identifier — must be unique within the app. */
const BATTERY_TASK_ID = 'com.kinnship.battery-refresh';

/** Desired interval between battery refreshes, in minutes (~4 hours). */
const BATTERY_TASK_INTERVAL_MINUTES = 240;

/** AsyncStorage key for the per-task rolling log. */
const BATTERY_TASK_LOG_KEY = '@kinnship/battery_task_log_v1';

/** Maximum log entries to retain in AsyncStorage. */
const BATTERY_TASK_LOG_MAX = 30;

/** AsyncStorage key for the one-time battery optimization prompt flag. */
export const BATTERY_OPT_PROMPTED_KEY = '@kinnship/battery_opt_prompted_v1';

// ── Log type ──────────────────────────────────────────────────────────────────

export interface BatteryTaskLogEntry {
  seq: number;
  /** Epoch ms */
  at: number;
  event:
    | 'background_battery_configured'
    | 'background_battery_configure_error'
    | 'background_battery_task_start'
    | 'background_battery_ok'
    | 'background_battery_skipped'
    | 'background_battery_error'
    | 'background_battery_timeout';
  detail?: Record<string, unknown>;
}

// ── Log helpers ───────────────────────────────────────────────────────────────

async function appendLog(
  event: BatteryTaskLogEntry['event'],
  detail?: Record<string, unknown>,
): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(BATTERY_TASK_LOG_KEY);
    const log: BatteryTaskLogEntry[] = raw ? (JSON.parse(raw) as BatteryTaskLogEntry[]) : [];
    const seq = (log[log.length - 1]?.seq ?? 0) + 1;
    log.push({ seq, at: Date.now(), event, detail });
    if (log.length > BATTERY_TASK_LOG_MAX) {
      log.splice(0, log.length - BATTERY_TASK_LOG_MAX);
    }
    await AsyncStorage.setItem(BATTERY_TASK_LOG_KEY, JSON.stringify(log));
  } catch {
    // Non-fatal — never block the background task for logging failures.
  }
}

/** Return all stored battery task log entries, oldest-first. */
export async function readBatteryTaskLog(): Promise<BatteryTaskLogEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(BATTERY_TASK_LOG_KEY);
    return raw ? (JSON.parse(raw) as BatteryTaskLogEntry[]) : [];
  } catch {
    return [];
  }
}

/** Wipe the battery task log from AsyncStorage. */
export async function clearBatteryTaskLog(): Promise<void> {
  try {
    await AsyncStorage.removeItem(BATTERY_TASK_LOG_KEY);
  } catch {
    // Non-fatal.
  }
}

// ── Core task logic ───────────────────────────────────────────────────────────

/**
 * Read battery from expo-battery, obtain JWT from the Transistor SDK's
 * persisted SQLite state, and PATCH /battery.  Called both from the
 * foreground/background handler and the headless (app-terminated) handler.
 */
async function executeBatteryRefresh(taskId: string): Promise<void> {
  const backgroundFetch = getBackgroundFetch();
  if (!backgroundFetch) return;

  await appendLog('background_battery_task_start', { taskId });

  try {
    // Step 1 — Read battery state via expo-battery one-shot APIs.
    // These work in any JS context (foreground, background, headless).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const BatteryModule = require('expo-battery') as typeof import('expo-battery');
    const rawLevel: number = await BatteryModule.getBatteryLevelAsync();
    const rawState: number = await BatteryModule.getBatteryStateAsync();

    const validLevel =
      typeof rawLevel === 'number' && isFinite(rawLevel) && rawLevel >= 0;

    if (!validLevel) {
      await appendLog('background_battery_skipped', {
        reason: 'invalid_battery_level',
        rawLevel,
      });
      backgroundFetch.finish(taskId);
      return;
    }

    const level = rawLevel;
    const isCharging: boolean =
      rawState === BatteryModule.BatteryState.CHARGING ||
      rawState === BatteryModule.BatteryState.FULL;

    // Step 2 — Obtain member ID, JWT, and API base URL from the Transistor
    // SDK's persisted SQLite state.  No shared memory with the main JS runtime
    // is needed — the SDK stores this natively and BackgroundGeolocation.getState()
    // is callable from any JS context including a terminated-app headless task.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const BGL = require('react-native-background-geolocation').default as {
      getState: () => Promise<{ url?: string; authorization?: { accessToken?: string } }>;
    };

    const sdkState = await BGL.getState();
    const locationUrl: string = sdkState?.url ?? '';
    const jwt: string = sdkState?.authorization?.accessToken ?? '';
    const memberMatch = locationUrl.match(/\/members\/([^/]+)\/location/);
    const memberId = memberMatch?.[1] ?? '';
    const baseUrl = locationUrl.split('/api/members/')[0] ?? '';

    if (!memberId || !jwt || !baseUrl) {
      await appendLog('background_battery_skipped', {
        reason: 'missing_member_id_or_jwt',
        hasMemberId: !!memberId,
        hasJwt: !!jwt,
        hasBaseUrl: !!baseUrl,
      });
      backgroundFetch.finish(taskId);
      return;
    }

    // Step 3 — PATCH /api/members/{id}/battery.
    const ts = new Date().toISOString();
    const battUrl = `${baseUrl}/api/members/${memberId}/battery`;

    const resp = await Promise.race([
      fetch(battUrl, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({
          battery_level: level,
          is_charging: isCharging,
          battery_updated_at: ts,
        }),
      }),
      // Safety timeout — OS gives us limited CPU budget; don't burn it waiting.
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('background-battery-patch-timeout')), 10_000),
      ),
    ]);

    await appendLog('background_battery_ok', {
      levelPct: Math.round(level * 100),
      isCharging,
      httpStatus: resp.status,
    });
  } catch (e: unknown) {
    const err = e instanceof Error ? e.message : String(e);
    await appendLog('background_battery_error', { error: err });
  }

  backgroundFetch.finish(taskId);
}

// ── Headless task registration (Android) ──────────────────────────────────────
//
// Must be registered at module-load time (before the React component tree
// mounts) so Android can fire the task even when the app is terminated.
// This mirrors the pattern used by BackgroundGeolocation.registerHeadlessTask()
// in locationEngine.ts.

try {
  getBackgroundFetch()?.registerHeadlessTask(
    async ({ taskId }: { taskId: string }) => {
      await executeBatteryRefresh(taskId);
    },
  );
} catch {
  // Silently ignore — may throw in environments where native module is absent.
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Configure and register the periodic battery background task.
 *
 * Call once after the user authenticates.  Safe to call on every app launch —
 * BackgroundFetch deduplicates registrations by task ID.
 *
 * @param onStatusChange  Optional callback invoked with the BackgroundFetch
 *                        status code so the caller can show a warning if
 *                        background execution is restricted (STATUS_RESTRICTED
 *                        on iOS, not granted on Android).
 */
export async function configureBatteryTask(
  onStatusChange?: (status: number) => void,
): Promise<void> {
  const backgroundFetch = getBackgroundFetch();
  if (!backgroundFetch) return;

  try {
    const status = await backgroundFetch.configure(
      {
        minimumFetchInterval: BATTERY_TASK_INTERVAL_MINUTES,
        stopOnTerminate: false,   // Keep running after force-close (Android)
        startOnBoot: true,        // Reschedule after device reboot
        enableHeadless: true,     // Fire headless task when app is terminated
        forceAlarmManager: false, // Use WorkManager (preferred over AlarmManager)
        requiresCharging: false,
        requiresDeviceIdle: false,
        requiredNetworkType: backgroundFetch.NETWORK_TYPE_ANY,
      },
      // Foreground / background handler (app is alive or in background)
      async (taskId: string) => {
        await executeBatteryRefresh(taskId);
      },
      // Timeout handler — OS is revoking the CPU budget
      async (taskId: string) => {
        await appendLog('background_battery_timeout', { taskId });
        backgroundFetch.finish(taskId);
      },
    );

    onStatusChange?.(status);

    await appendLog('background_battery_configured', {
      status,
      minimumFetchIntervalMinutes: BATTERY_TASK_INTERVAL_MINUTES,
    });
  } catch (e: unknown) {
    const err = e instanceof Error ? e.message : String(e);
    await appendLog('background_battery_configure_error', { error: err });
  }
}
