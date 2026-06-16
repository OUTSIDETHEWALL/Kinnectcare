/**
 * Kinnship background location service (Fix #1 + #4 of v1.2 beta).
 *
 * Spec:
 *  - Continuous foreground service while a user is logged in.
 *  - Normal interval: 5 minutes / 100 meters (battery-friendly).
 *  - SOS-active interval: 10 seconds / 5 meters (per Fix #4).
 *  - Foreground notification text: "🛡️ Kinnship is protecting your family".
 *  - Stops on logout / when background-location permission is revoked.
 *
 * Implementation:
 *  TaskManager + expo-location's startLocationUpdatesAsync.  The task
 *  runs in a separate JS context owned by the OS — survives the app
 *  being killed.  Each tick reads our SOS-active flag from AsyncStorage
 *  and decides whether to fire a high-frequency update on top of the
 *  default cadence.
 *
 * Why a separate AsyncStorage flag instead of broadcasting through
 * Zustand:  the TaskManager JS context CANNOT access in-memory React
 * state.  AsyncStorage is the only reliable channel between the
 * foreground app and the OS-owned task.  Trade-off: ~5ms read overhead
 * per tick, completely fine.
 */
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { api } from './api';

export const BG_LOCATION_TASK = 'kinnship/background-location-v1';
export const SOS_ACTIVE_KEY = '@kinnship/sos_active_v1';
export const BG_LOCATION_MEMBER_ID_KEY = '@kinnship/bg_location_member_id_v1';

// Cadence settings — see the doc-block above for the rationale.
const NORMAL_TIME_INTERVAL_MS = 5 * 60 * 1000;   // 5 min
const NORMAL_DISTANCE_M = 100;
const SOS_TIME_INTERVAL_MS = 10 * 1000;          // 10 sec
const SOS_DISTANCE_M = 5;

// In-flight POST tracker — drop duplicates if the previous tick is still
// uploading.  Stale GPS isn't worth queuing up requests forever.
//
// v1.2.4 fix: replaced the boolean `uploadInFlight` flag with a
// timestamp-based stale check.  The boolean variant could permanently
// pin to `true` if api.put() ever hung (slow Atlas, mid-upload TCP
// reset, runaway timeout) — the finally block wouldn't fire and every
// subsequent tick would short-circuit forever.  Now: if the previous
// upload started >30 s ago we assume it died and proceed anyway.  The
// worst case is two concurrent uploads from the OS-task context,
// which is fine — the backend write is idempotent (latest-wins).
const UPLOAD_LOCK_TIMEOUT_MS = 30 * 1000;
let uploadStartedAt = 0;

// ---------- Background-task diagnostics ----------
//
// Until v1.2.4, every failure mode in this file was silently swallowed:
// task errors, missing member-ids, in-flight zombie locks, HTTP 401s
// from rotated JWTs, network failures.  We had ZERO ability to tell
// from Joyce's phone whether the OS task was running at the expected
// cadence, whether it was running and failing, or whether it was being
// suppressed entirely by Android Doze / iOS deferred-update gating.
//
// This rolling buffer (50 entries, oldest rolls off) is populated by
// every tick with one entry describing what happened.  The Diagnostics
// screen renders it alongside the foreground-refresh and push-refresh
// logs so support can triangulate.
//
// PRIVACY: coords are coarse-rounded to 0.01° (~1.1 km) before being
// written here, same convention as locationRefresh.ts.  The actual PUT
// upload of course uses full precision — that's the whole point.
const BG_TASK_LOG_KEY = 'kc_bg_task_log';
type BgTaskLogPhase =
  | 'tick'
  | 'task-error'
  | 'no-locs'
  | 'no-member-id'
  | 'lock-held'
  | 'upload-ok'
  | 'upload-fail';

type BgTaskLogEntry = {
  t: number;
  phase: BgTaskLogPhase;
  // Phase-specific extra data.  Kept loosely typed because each phase
  // surfaces different fields and we don't want to bloat the union.
  err?: string;
  status?: number;
  latApprox?: number;
  lonApprox?: number;
  ageS?: number; // seconds since the GPS fix was recorded (helps detect deferred batching)
  count?: number; // locations array length when the OS batches
};

async function appendBgLog(entry: BgTaskLogEntry): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(BG_TASK_LOG_KEY);
    const arr: BgTaskLogEntry[] = raw ? JSON.parse(raw) : [];
    arr.push(entry);
    while (arr.length > 50) arr.shift();
    await AsyncStorage.setItem(BG_TASK_LOG_KEY, JSON.stringify(arr));
  } catch (_e) {
    // We're in the OS-detached context with no UI; nothing to do.
  }
}

export async function readBgTaskLog(): Promise<BgTaskLogEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(BG_TASK_LOG_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (_e) {
    return [];
  }
}

export async function clearBgTaskLog(): Promise<void> {
  try { await AsyncStorage.removeItem(BG_TASK_LOG_KEY); } catch (_e) {}
}

function roundCoord(x: number): number {
  return Math.round(x * 100) / 100;
}

export type { BgTaskLogEntry, BgTaskLogPhase };

// Type the task payload so the body is well-typed.
type BgTaskPayload = {
  data?: {
    locations?: Location.LocationObject[];
  };
  error?: TaskManager.TaskManagerError | null;
};

async function readMemberId(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(BG_LOCATION_MEMBER_ID_KEY);
  } catch (_e) {
    return null;
  }
}

export async function setSosActive(active: boolean): Promise<void> {
  try {
    if (active) await AsyncStorage.setItem(SOS_ACTIVE_KEY, '1');
    else await AsyncStorage.removeItem(SOS_ACTIVE_KEY);
  } catch (_e) {}
}

export async function isSosActive(): Promise<boolean> {
  try {
    const v = await AsyncStorage.getItem(SOS_ACTIVE_KEY);
    return v === '1';
  } catch (_e) {
    return false;
  }
}

// ---------- The task itself ----------
//
// IMPORTANT: TaskManager.defineTask must be called at module top-level
// (not inside any React component) so the JS context registers the
// handler BEFORE the OS hands a wake-up event to the bundle.
TaskManager.defineTask(BG_LOCATION_TASK, async (payload: BgTaskPayload) => {
  const now = Date.now();
  if (payload.error) {
    // OS-level task error (permission revoked, GPS off, system kill).
    // Until v1.2.4 we only emitted console.warn — which is invisible
    // from the detached task context.  Persist it so Diagnostics can
    // surface the failure mode.
    // eslint-disable-next-line no-console
    console.warn('[bgLocation] task error:', payload.error);
    await appendBgLog({
      t: now,
      phase: 'task-error',
      err: `${payload.error?.code || ''}:${payload.error?.message || 'unknown'}`.slice(0, 80),
    });
    return;
  }
  const locs = payload?.data?.locations;
  if (!locs || locs.length === 0) {
    await appendBgLog({ t: now, phase: 'no-locs' });
    return;
  }

  const memberId = await readMemberId();
  if (!memberId) {
    await appendBgLog({ t: now, phase: 'no-member-id', count: locs.length });
    return;
  }

  // Pick the freshest fix and skip the rest — the OS sometimes
  // batches multiple historical points into a single callback.
  const fresh = locs[locs.length - 1];
  if (!fresh?.coords) {
    await appendBgLog({ t: now, phase: 'no-locs', count: locs.length });
    return;
  }

  // Stale-lock check (replaces the v1.2.3 boolean uploadInFlight).
  if (uploadStartedAt && now - uploadStartedAt < UPLOAD_LOCK_TIMEOUT_MS) {
    await appendBgLog({
      t: now,
      phase: 'lock-held',
      ageS: Math.round((now - uploadStartedAt) / 1000),
    });
    return;
  }
  uploadStartedAt = now;

  // Diagnostic for the tick that actually attempts an upload: capture
  // the GPS-fix age so we can spot OS deferred-update batching.
  const gpsAgeS = fresh.timestamp ? Math.round((now - fresh.timestamp) / 1000) : undefined;

  try {
    await api.put(`/members/${memberId}/location`, {
      latitude: fresh.coords.latitude,
      longitude: fresh.coords.longitude,
    });
    await appendBgLog({
      t: now,
      phase: 'upload-ok',
      latApprox: roundCoord(fresh.coords.latitude),
      lonApprox: roundCoord(fresh.coords.longitude),
      ageS: gpsAgeS,
      count: locs.length,
    });
  } catch (e: any) {
    // Silent in terms of UI — but persist the failure so we can
    // diagnose JWT-rotation 401s, network drops, 5xx, etc.
    const status = e?.response?.status;
    await appendBgLog({
      t: now,
      phase: 'upload-fail',
      status: status || undefined,
      err: status ? `http_${status}` : `network_${(e?.message || 'unknown').slice(0, 40)}`,
      ageS: gpsAgeS,
      count: locs.length,
    });
  } finally {
    uploadStartedAt = 0;
  }
});

/**
 * Start the foreground service.  Idempotent — calling repeatedly is
 * safe; OS keeps a single instance.  Returns `true` on success,
 * `false` if the user denied any required permission.
 *
 * Caller is responsible for showing a contextual permission rationale
 * BEFORE invoking this (see handle_permissions_contract).
 */
export async function startBackgroundLocation(memberId: string): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  // Persist the member-id keyed used by the OS-task to know whose
  // record to update.  Read fresh on every tick to handle account
  // switches without restarting the service.
  await AsyncStorage.setItem(BG_LOCATION_MEMBER_ID_KEY, memberId);

  const fg = await Location.getForegroundPermissionsAsync();
  if (fg.status !== 'granted') {
    const req = await Location.requestForegroundPermissionsAsync();
    if (req.status !== 'granted') return false;
  }
  const bg = await Location.getBackgroundPermissionsAsync();
  if (bg.status !== 'granted') {
    const req = await Location.requestBackgroundPermissionsAsync();
    if (req.status !== 'granted') return false;
  }

  // If a sister task is already running, just refresh its options to
  // pick up any cadence change.
  const sosNow = await isSosActive();
  const opts = sosNow
    ? { timeIntervalMs: SOS_TIME_INTERVAL_MS, distanceM: SOS_DISTANCE_M }
    : { timeIntervalMs: NORMAL_TIME_INTERVAL_MS, distanceM: NORMAL_DISTANCE_M };

  const already = await Location.hasStartedLocationUpdatesAsync(BG_LOCATION_TASK);
  if (already) {
    // Soft-restart with new options so cadence updates propagate.
    try {
      await Location.stopLocationUpdatesAsync(BG_LOCATION_TASK);
    } catch (_e) {}
  }

  await Location.startLocationUpdatesAsync(BG_LOCATION_TASK, {
    accuracy: sosNow ? Location.Accuracy.BestForNavigation : Location.Accuracy.Balanced,
    timeInterval: opts.timeIntervalMs,
    distanceInterval: opts.distanceM,
    deferredUpdatesInterval: opts.timeIntervalMs,
    showsBackgroundLocationIndicator: true,  // iOS blue bar
    pausesUpdatesAutomatically: false,
    foregroundService: Platform.OS === 'android'
      ? {
          notificationTitle: 'Kinnship',
          notificationBody: '🛡️ Kinnship is protecting your family',
          notificationColor: '#1B5E35',
          // killServiceOnDestroy intentionally NOT set — the default
          // (true) is what we want; if the app is force-stopped from
          // recents, the service goes with it, which is expected
          // Android behavior and matches Life360.
        }
      : undefined,
  });
  return true;
}

/** Stop the foreground service.  Idempotent. */
export async function stopBackgroundLocation(): Promise<void> {
  try {
    const running = await Location.hasStartedLocationUpdatesAsync(BG_LOCATION_TASK);
    if (running) await Location.stopLocationUpdatesAsync(BG_LOCATION_TASK);
  } catch (_e) {}
  try {
    await AsyncStorage.removeItem(BG_LOCATION_MEMBER_ID_KEY);
    await AsyncStorage.removeItem(SOS_ACTIVE_KEY);
  } catch (_e) {}
}

/**
 * Bump the task to high-frequency SOS cadence.  Call when this device's
 * user triggers SOS.  Caller is responsible for calling endSosBoost()
 * when SOS is resolved.
 *
 * Auto-revert: also start a 30-min watchdog that ends the boost even
 * if the resolve event never fires — guards against zombie SOS.
 */
let sosWatchdog: ReturnType<typeof setTimeout> | null = null;
export async function beginSosBoost(): Promise<void> {
  await setSosActive(true);
  const memberId = await readMemberId();
  if (memberId) {
    // Restart updates with the SOS cadence.
    await startBackgroundLocation(memberId);
  }
  if (sosWatchdog) clearTimeout(sosWatchdog);
  sosWatchdog = setTimeout(() => {
    void endSosBoost();
  }, 30 * 60 * 1000);
}

export async function endSosBoost(): Promise<void> {
  await setSosActive(false);
  if (sosWatchdog) {
    clearTimeout(sosWatchdog);
    sosWatchdog = null;
  }
  const memberId = await readMemberId();
  if (memberId) {
    await startBackgroundLocation(memberId);
  }
}
