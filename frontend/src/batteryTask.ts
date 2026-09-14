/**
 * batteryTask.ts — Independent battery refresh subsystem (Build XX).
 *
 * Provides a periodic WorkManager (Android) / BGTaskScheduler (iOS) background
 * task that targets a 30-minute cadence and PATCHes /battery regardless of
 * whether the device has moved or the Transistor SDK heartbeat is firing.
 * On Android, the same existing WorkManager wake also requests one bounded,
 * persisted Transistor position so stationary devices retain a low-frequency
 * server-visible location/presence path when OEMs defer native heartbeats.
 *
 * Architecture:
 *   Movement → BackgroundGeolocation → battery PATCH   (existing path, unchanged)
 *   Timer    → BackgroundFetch task  → battery PATCH + one persisted position
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

/**
 * Desired interval between battery refreshes.
 *
 * WorkManager is inexact and Android may defer work in Doze or under OEM
 * restrictions. A 30-minute target leaves enough scheduling slack to keep
 * presence below one hour whenever Android permits background execution.
 */
export const BATTERY_TASK_INTERVAL_MINUTES = 30;

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
    | 'background_battery_timeout'
    | 'background_location_persisted'
    | 'background_location_skipped'
    | 'background_location_error';
  detail?: Record<string, unknown>;
}

// ── Log helpers ───────────────────────────────────────────────────────────────

let logWriteQueue: Promise<void> = Promise.resolve();

function appendLog(
  event: BatteryTaskLogEntry['event'],
  detail?: Record<string, unknown>,
  shouldWrite: () => boolean = () => true,
): Promise<void> {
  const write = logWriteQueue.then(async () => {
    if (!shouldWrite()) return;
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
  });
  logWriteQueue = write.catch(() => {});
  return write;
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

type TaskExecution = {
  taskId: string;
  generation: number;
  finished: boolean;
  timedOut: boolean;
};

let nextTaskGeneration = 0;
const activeTaskExecutions = new Map<string, TaskExecution>();

function beginTask(taskId: string): TaskExecution {
  const execution: TaskExecution = {
    taskId,
    generation: ++nextTaskGeneration,
    finished: false,
    timedOut: false,
  };
  activeTaskExecutions.set(taskId, execution);
  return execution;
}

function isActiveExecution(execution: TaskExecution): boolean {
  return activeTaskExecutions.get(execution.taskId) === execution
    && !execution.finished
    && !execution.timedOut;
}

function appendExecutionLog(
  execution: TaskExecution,
  event: BatteryTaskLogEntry['event'],
  detail?: Record<string, unknown>,
): Promise<void> {
  return appendLog(event, detail, () => isActiveExecution(execution));
}

function finishExecutionOnce(
  backgroundFetch: BackgroundFetchModule,
  execution: TaskExecution,
): void {
  if (execution.finished) return;
  execution.finished = true;
  if (activeTaskExecutions.get(execution.taskId) === execution) {
    backgroundFetch.finish(execution.taskId);
  }
}

/**
 * Read battery from expo-battery, obtain JWT from the Transistor SDK's
 * persisted SQLite state, and PATCH /battery. On Android, also request one
 * persisted position through the existing WorkManager wake. Called both from
 * the foreground/background handler and the headless (app-terminated) handler.
 */
async function executeBatteryRefresh(taskId: string): Promise<void> {
  const backgroundFetch = getBackgroundFetch();
  if (!backgroundFetch) return;

  const execution = beginTask(taskId);
  await appendExecutionLog(execution, 'background_battery_task_start', {
    taskId,
    generation: execution.generation,
  });

  type BackgroundGeolocationModule = {
    getState: () => Promise<{
      enabled?: boolean;
      url?: string;
      authorization?: { accessToken?: string };
    }>;
    getCurrentPosition: (options: {
      samples: number;
      persist: boolean;
      timeout: number;
      extras: { source: string };
    }) => Promise<{ timestamp?: string; coords?: { accuracy?: number } }>;
  };

  let BGL: BackgroundGeolocationModule | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    BGL = require('react-native-background-geolocation').default as BackgroundGeolocationModule;
  } catch (e: unknown) {
    const err = e instanceof Error ? e.message : String(e);
    await appendExecutionLog(execution, 'background_battery_error', {
      error: `background-geolocation-unavailable:${err}`,
      taskId,
      generation: execution.generation,
    });
    if (Platform.OS === 'android') {
      await appendExecutionLog(execution, 'background_location_skipped', {
        reason: 'background_geolocation_unavailable',
        taskId,
        generation: execution.generation,
      });
    }
    finishExecutionOnce(backgroundFetch, execution);
    return;
  }

  let sdkState: Awaited<ReturnType<BackgroundGeolocationModule['getState']>> | null = null;
  try {
    sdkState = await BGL.getState();
  } catch (e: unknown) {
    const err = e instanceof Error ? e.message : String(e);
    await appendExecutionLog(execution, 'background_battery_error', {
      error: `background-geolocation-state:${err}`,
      taskId,
      generation: execution.generation,
    });
  }

  type LocationOutcome = {
    event: 'background_location_persisted' | 'background_location_skipped' | 'background_location_error';
    detail: Record<string, unknown>;
  };

  // Start the bounded position request alongside the battery network work, but
  // return its outcome instead of logging concurrently. AsyncStorage logging is
  // read-modify-write and must remain serialized to avoid losing either result.
  const stationaryLocationRefresh: Promise<LocationOutcome | null> = Platform.OS !== 'android'
    ? Promise.resolve(null)
    : sdkState?.enabled !== true
      ? Promise.resolve({
          event: 'background_location_skipped',
          detail: {
            taskId,
            generation: execution.generation,
            reason: sdkState ? 'tracking_disabled' : 'state_unavailable',
          },
        })
      : (async () => {
          try {
            const position = await BGL.getCurrentPosition({
              samples: 1,
              persist: true,
              timeout: 20,
              extras: { source: 'workmanager-stationary-refresh' },
            });
            return {
              event: 'background_location_persisted',
              detail: {
                taskId,
                generation: execution.generation,
                capturedAt: position?.timestamp ?? null,
                accuracy: typeof position?.coords?.accuracy === 'number'
                  ? Math.round(position.coords.accuracy)
                  : null,
                persisted: true,
                uploadConfirmation: 'awaiting-native-http',
              },
            };
          } catch (e: unknown) {
            const err = e instanceof Error ? e.message : String(e);
            return {
              event: 'background_location_error',
              detail: { taskId, generation: execution.generation, error: err },
            };
          }
        })();

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
      await appendExecutionLog(execution, 'background_battery_skipped', {
        reason: 'invalid_battery_level',
        rawLevel,
        taskId,
        generation: execution.generation,
      });
    } else {
      const level = rawLevel;
      const isCharging: boolean =
        rawState === BatteryModule.BatteryState.CHARGING ||
        rawState === BatteryModule.BatteryState.FULL;

      // Step 2 — Obtain member ID, JWT, and API base URL from the Transistor
      // SDK's persisted SQLite state. No shared main-runtime memory is needed.
      const locationUrl: string = sdkState?.url ?? '';
      const jwt: string = sdkState?.authorization?.accessToken ?? '';
      const memberMatch = locationUrl.match(/\/members\/([^/]+)\/location/);
      const memberId = memberMatch?.[1] ?? '';
      const baseUrl = locationUrl.split('/api/members/')[0] ?? '';

      if (!memberId || !jwt || !baseUrl) {
        await appendExecutionLog(execution, 'background_battery_skipped', {
          reason: 'missing_member_id_or_jwt',
          hasMemberId: !!memberId,
          hasJwt: !!jwt,
          hasBaseUrl: !!baseUrl,
          taskId,
          generation: execution.generation,
        });
      } else {
        // Step 3 — PATCH /api/members/{id}/battery.
        const ts = new Date().toISOString();
        const battUrl = `${baseUrl}/api/members/${memberId}/battery`;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

        try {
          const resp = await Promise.race([
            fetch(battUrl, {
              method: 'PATCH',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${jwt}`,
                'X-Kinnship-Presence-Source': 'battery-task',
              },
              body: JSON.stringify({
                battery_level: level,
                is_charging: isCharging,
                battery_updated_at: ts,
              }),
            }),
            new Promise<never>((_, rej) => {
              timeoutHandle = setTimeout(
                () => rej(new Error('background-battery-patch-timeout')),
                8_000,
              );
            }),
          ]);

          if (resp.status < 200 || resp.status >= 300) {
            throw new Error(`background-battery-http-${resp.status}`);
          }

          await appendExecutionLog(execution, 'background_battery_ok', {
            levelPct: Math.round(level * 100),
            isCharging,
            httpStatus: resp.status,
            taskId,
            generation: execution.generation,
          });
        } finally {
          if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        }
      }
    }
  } catch (e: unknown) {
    const err = e instanceof Error ? e.message : String(e);
    await appendExecutionLog(execution, 'background_battery_error', {
      error: err,
      taskId,
      generation: execution.generation,
    });
  }

  // Persisted means the SDK accepted the fix into its native queue. Actual
  // server acceptance remains proven by the existing native HTTP callback.
  const locationOutcome = await stationaryLocationRefresh;
  if (locationOutcome) {
    await appendExecutionLog(execution, locationOutcome.event, locationOutcome.detail);
  }

  finishExecutionOnce(backgroundFetch, execution);
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
        const execution = activeTaskExecutions.get(taskId);
        if (execution && !execution.finished) {
          execution.timedOut = true;
          finishExecutionOnce(backgroundFetch, execution);
        } else if (!execution) {
          backgroundFetch.finish(taskId);
        }
        await appendLog('background_battery_timeout', { taskId });
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
