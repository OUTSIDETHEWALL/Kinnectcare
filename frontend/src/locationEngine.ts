/**
 * Kinnship Location Engine (v1.2.0+).
 *
 * Architectural envelope wrapping `react-native-background-geolocation`
 * (Transistor SDK).  Every Kinnship screen / service that needs
 * background location reliability calls into THIS module, not the
 * library directly.
 *
 * v1.2.0 scope:
 *   • `start()` — ready + start the SDK with our recommended config.
 *   • `stop()` — clean shutdown.
 *   • `getState()` — sync read of current engine state for diagnostics.
 *   • `setAuthToken()` — updates the JWT used by the SDK's native HTTP
 *     transport when posting locations to our backend.
 *   • Per-user backend URL injection so we POST to
 *     `PUT /api/members/{member_id}/location` on Railway.
 *
 * v1.2.1 — Diagnostic instrumentation (build 41).
 *
 * The Phase 3 field test showed neither engine displaying a foreground
 * service notification, and Joyce's location going stale 15+ minutes
 * after the app backgrounded.  The previous wrapper caught every SDK
 * exception silently, which left us blind to the actual failure mode.
 *
 * Build 41 adds:
 *
 *   1. Named try/catch on every SDK call — every error path now logs
 *      a structured entry (event name + reason).
 *
 *   2. Explicit `requestPermission()` call before `start()` — required
 *      on Android 10+ to escalate to ACCESS_BACKGROUND_LOCATION.  The
 *      SDK's `start()` does NOT auto-request this on its own; without
 *      it tracking silently degrades to foreground-only.
 *
 *   3. Persistent ring buffer (30 entries, AsyncStorage) capturing
 *      every lifecycle event: invocation, permission state, ready
 *      result, start result, SDK event callbacks (location, motion
 *      change, HTTP success/error, heartbeat, provider change),
 *      stop result.  No JWT contents written.  Readable via
 *      `getEngineDiagnostics()` and surfaced on the Diagnostics screen
 *      so we can triage from a field device without a debug build.
 *
 *   4. SDK event subscriptions — onLocation / onMotionChange /
 *      onProviderChange / onHttp / onHeartbeat all funnel into the
 *      ring buffer so we can SEE whether the SDK is generating
 *      fixes, posting to the backend, and what the backend returns.
 */
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Lazy require so this module is safe to import on web (where the
// native module is absent).
let BGGeo: any = null;
function bgGeo(): any | null {
  if (Platform.OS === 'web') return null;
  if (BGGeo) return BGGeo;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    BGGeo = require('react-native-background-geolocation').default;
  } catch (e: any) {
    BGGeo = null;
    // Log this — if the native module fails to load on Android, we
    // need to know immediately.  The error is rarely fatal but it's
    // ALWAYS the root cause when "the engine doesn't work".
    void logEvent('require_failed', { error: String(e?.message || e) });
  }
  return BGGeo;
}

// ============================================================
//  Diagnostic ring buffer (v1.2.1 / build 41)
// ============================================================
//
// Persisted to AsyncStorage so it survives app kill/restart cycles
// and can be retrieved from the Diagnostics screen even if the
// underlying SDK crashed.  30 entries is enough to capture the
// last ~30 minutes of activity at default heartbeat cadence,
// well past the "engine never started" diagnosis horizon we need.
//
// PRIVACY: coordinates rounded to 0.01° (~1.1 km) before logging,
// same convention used by the legacy `backgroundLocation.ts` log
// buffer.  JWTs are NEVER logged — only their presence as boolean.
const LOG_KEY = '@kinnship/location_engine_log_v1';
const LOG_MAX = 30;

export type EngineLogEvent = {
  at: number;                  // epoch ms
  event: string;               // event name (see below)
  detail?: Record<string, any>;
};

// In-memory mirror so reads from the Diagnostics screen don't wait on
// AsyncStorage.  AsyncStorage is the source of truth on cold start.
let logBuffer: EngineLogEvent[] = [];
let logBufferLoaded = false;

async function loadLogBuffer(): Promise<void> {
  if (logBufferLoaded) return;
  try {
    const raw = await AsyncStorage.getItem(LOG_KEY);
    if (raw) logBuffer = JSON.parse(raw);
  } catch (_e) {
    logBuffer = [];
  }
  logBufferLoaded = true;
}

async function persistLogBuffer(): Promise<void> {
  try {
    await AsyncStorage.setItem(LOG_KEY, JSON.stringify(logBuffer));
  } catch (_e) {
    // Persistence is best-effort; in-memory mirror is still valid.
  }
}

/**
 * Append a single diagnostic event to the ring buffer.  Exported so
 * that the layout (app launched / foregrounded / backgrounded) can
 * push its own lifecycle events alongside the SDK ones.
 */
export async function logEvent(
  event: string,
  detail?: Record<string, any>,
): Promise<void> {
  await loadLogBuffer();
  logBuffer.push({ at: Date.now(), event, detail });
  if (logBuffer.length > LOG_MAX) {
    logBuffer = logBuffer.slice(-LOG_MAX);
  }
  await persistLogBuffer();
}

/**
 * Read the full diagnostic log for the Diagnostics screen.
 * Oldest-first.  Safe to call on web (returns []).
 */
export async function getEngineLog(): Promise<EngineLogEvent[]> {
  await loadLogBuffer();
  return [...logBuffer];
}

/** Clear the log buffer.  Surfaced as a button on Diagnostics. */
export async function clearEngineLog(): Promise<void> {
  logBuffer = [];
  await persistLogBuffer();
}

export type LocationEngineConfig = {
  /** Caller's backend base URL (e.g. https://kinnship.up.railway.app). */
  backendBaseUrl: string;
  /** Member ID whose location this device uploads. */
  memberId: string;
  /** Current JWT — used by the SDK's native HTTP transport. */
  jwt: string;
};

export type LocationEngineState = {
  enabled: boolean;
  trackingMode: 'unknown' | 'foreground' | 'background' | 'idle';
  isMoving: boolean | null;
  lastSampleAt: number | null;
  odometerMeters: number | null;
};

let cachedConfig: LocationEngineConfig | null = null;
let isReady = false;
let listenersAttached = false;

/**
 * One-time SDK event subscription.  These callbacks feed the
 * diagnostic ring buffer — they are READ-ONLY observers, they do not
 * affect engine behavior.  Idempotent (guarded by listenersAttached).
 */
function attachSdkListeners(lib: any): void {
  if (listenersAttached) return;
  try {
    lib.onLocation(
      (loc: any) => {
        void logEvent('sdk_onLocation', {
          // Round to 0.01 deg for privacy in logs.  Real PUT uses full
          // precision via the SDK's native HTTP transport.
          lat: round01(loc?.coords?.latitude),
          lng: round01(loc?.coords?.longitude),
          acc: loc?.coords?.accuracy,
          speed: loc?.coords?.speed,
          isMoving: !!loc?.is_moving,
          event: loc?.event,
        });
      },
      (err: any) => {
        void logEvent('sdk_onLocation_error', {
          code: err?.code ?? err?.status ?? -1,
          message: String(err?.message || err),
        });
      },
    );
    lib.onMotionChange((evt: any) => {
      void logEvent('sdk_onMotionChange', {
        isMoving: !!evt?.isMoving,
      });
    });
    lib.onProviderChange((evt: any) => {
      // status: 0=disabled, 1=allow-while-using, 3=always.
      void logEvent('sdk_onProviderChange', {
        enabled: !!evt?.enabled,
        gps: !!evt?.gps,
        network: !!evt?.network,
        status: evt?.status,
      });
    });
    lib.onHttp((evt: any) => {
      // success: boolean, status: HTTP code, url: string.
      void logEvent('sdk_onHttp', {
        success: !!evt?.success,
        status: evt?.status,
        // Strip query strings; preserve path so we can confirm we're
        // hitting /api/members/{id}/location and not a misconfigured URL.
        path: (evt?.url || '').split('?')[0],
      });
    });
    lib.onHeartbeat(() => {
      void logEvent('sdk_onHeartbeat');
    });
    listenersAttached = true;
    void logEvent('sdk_listeners_attached');
  } catch (e: any) {
    void logEvent('sdk_listeners_failed', {
      error: String(e?.message || e),
    });
  }
}

function round01(n: any): number | null {
  if (typeof n !== 'number' || !isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function buildSdkConfig(lib: any, cfg: LocationEngineConfig): Record<string, any> {
  const uploadUrl =
    `${cfg.backendBaseUrl.replace(/\/$/, '')}/api/members/${cfg.memberId}/location`;

  return {
    // Tracking
    desiredAccuracy: lib.DESIRED_ACCURACY_HIGH,
    distanceFilter: 10,
    stopTimeout: 5,
    locationUpdateInterval: 30000,
    fastestLocationUpdateInterval: 10000,

    // Activity Recognition / motion detection
    activityRecognitionInterval: 10000,
    minimumActivityRecognitionConfidence: 75,

    // Heartbeat — fires onHeartbeat every N seconds while STILL.  Used
    // here purely as a "the SDK is alive" signal in the diagnostic log.
    // 60s keeps log noise reasonable.
    heartbeatInterval: 60,

    // Lifecycle
    stopOnTerminate: false,
    startOnBoot: true,
    enableHeadless: true,

    // Foreground service (Android — required by Android 14+)
    foregroundService: true,
    notification: {
      title: 'Kinnship is sharing your location',
      text: 'Your family can see where you are. Tap to pause.',
      smallIcon: 'mipmap/ic_launcher',
      channelName: 'Location sharing',
      priority: lib.NOTIFICATION_PRIORITY_LOW,
      sticky: true,
    },

    // Native HTTP transport
    url: uploadUrl,
    method: 'PUT',
    autoSync: true,
    batchSync: false,
    maxBatchSize: 50,
    httpRootProperty: '.',
    locationTemplate:
      '{"latitude":<%= latitude %>,"longitude":<%= longitude %>,"accuracy":<%= accuracy %>,"speed":<%= speed %>,"heading":<%= heading %>,"timestamp":"<%= timestamp %>","is_moving":<%= is_moving %>,"event":"<%= event %>","provider":"transistor"}',
    headers: {
      'Content-Type': 'application/json',
    },
    authorization: {
      strategy: 'JWT',
      accessToken: cfg.jwt,
    },

    maxRecordsToPersist: 10000,
    maxDaysToPersist: 7,

    debug: false,
    logLevel: lib.LOG_LEVEL_INFO,
  };
}

/**
 * Start (or re-configure) the background location engine.
 *
 * v1.2.1 (build 41): Now performs the full lifecycle
 *   listeners → ready → requestPermission → start
 *
 * Each step logs success or failure to the diagnostic ring buffer
 * so the Diagnostics screen can show exactly where the engine failed.
 */
export async function start(cfg: LocationEngineConfig): Promise<void> {
  await logEvent('start_invoked', {
    hasJwt: !!cfg.jwt,
    memberId: cfg.memberId,
    backendBaseUrlSet: !!cfg.backendBaseUrl,
    platform: Platform.OS,
  });

  const lib = bgGeo();
  if (!lib) {
    await logEvent('start_skipped', { reason: 'native_module_unavailable' });
    return;
  }

  // ----- Attach SDK event listeners (idempotent) -----
  attachSdkListeners(lib);

  const config = buildSdkConfig(lib, cfg);
  cachedConfig = cfg;

  // ----- ready() / setConfig() -----
  try {
    if (isReady) {
      await lib.setConfig(config);
      await logEvent('setConfig_ok');
    } else {
      const state = await lib.ready(config);
      isReady = true;
      await logEvent('ready_ok', {
        enabled: !!state?.enabled,
        trackingMode: state?.trackingMode,
        didLaunchInBackground: !!state?.didLaunchInBackground,
      });
    }
  } catch (e: any) {
    await logEvent('ready_or_setConfig_error', {
      error: String(e?.message || e),
    });
    // Don't continue to start() — without a successful ready/setConfig
    // the engine state is undefined.
    return;
  }

  // ----- requestPermission() (CRITICAL on Android 10+) -----
  //
  // Per Transistor docs, lib.start() does NOT auto-request
  // ACCESS_BACKGROUND_LOCATION on Android — it requests only
  // foreground.  Without this explicit call the SDK silently
  // degrades to foreground-only tracking, which is exactly what
  // the Phase 3 field test exhibited (location refreshes while
  // app open, goes stale when backgrounded).
  //
  // Return codes:
  //   AUTHORIZATION_STATUS_ALWAYS (3) — background granted
  //   AUTHORIZATION_STATUS_WHEN_IN_USE (2) — foreground only
  //   AUTHORIZATION_STATUS_DENIED (1) — denied
  //   AUTHORIZATION_STATUS_NOT_DETERMINED (0) — never asked
  try {
    const status = await lib.requestPermission();
    await logEvent('requestPermission_ok', {
      status,
      // Add human-readable label for the Diagnostics panel.
      label:
        status === 3 ? 'ALWAYS'
        : status === 2 ? 'WHEN_IN_USE (foreground only)'
        : status === 1 ? 'DENIED'
        : status === 0 ? 'NOT_DETERMINED'
        : `unknown(${status})`,
    });
  } catch (e: any) {
    await logEvent('requestPermission_error', {
      error: String(e?.message || e),
    });
    // Continue anyway — the user may have granted permission via the
    // OS settings page outside the SDK's request flow.  start() will
    // then succeed.  If permission really is denied, start() will
    // log its own failure.
  }

  // ----- start() — the actual tracking subscription -----
  try {
    const state = await lib.start();
    await logEvent('started_ok', {
      enabled: !!state?.enabled,
      trackingMode: state?.trackingMode,
      isMoving: state?.isMoving,
    });
  } catch (e: any) {
    await logEvent('start_error', {
      error: String(e?.message || e),
    });
  }
}

/** Stop the engine.  Logs the outcome. */
export async function stop(): Promise<void> {
  await logEvent('stop_invoked');
  const lib = bgGeo();
  if (!lib) {
    await logEvent('stop_skipped', { reason: 'native_module_unavailable' });
    return;
  }
  try {
    await lib.stop();
    await logEvent('stop_ok');
  } catch (e: any) {
    await logEvent('stop_error', { error: String(e?.message || e) });
  }
}

/**
 * Update the JWT used by the native HTTP transport.  Logged.
 */
export async function setAuthToken(jwt: string): Promise<void> {
  const lib = bgGeo();
  if (!lib || !cachedConfig) {
    await logEvent('setAuthToken_skipped', {
      hasLib: !!lib,
      hasCachedConfig: !!cachedConfig,
    });
    return;
  }
  cachedConfig.jwt = jwt;
  try {
    await lib.setConfig({
      authorization: {
        strategy: 'JWT',
        accessToken: jwt,
      },
    });
    await logEvent('setAuthToken_ok');
  } catch (e: any) {
    await logEvent('setAuthToken_error', {
      error: String(e?.message || e),
    });
  }
}

/** Sync read of current engine state for diagnostics. */
export async function getState(): Promise<LocationEngineState> {
  const lib = bgGeo();
  if (!lib) {
    return {
      enabled: false,
      trackingMode: 'unknown',
      isMoving: null,
      lastSampleAt: null,
      odometerMeters: null,
    };
  }
  try {
    const state = await lib.getState();
    return {
      enabled: !!state?.enabled,
      trackingMode: state?.trackingMode === 1 ? 'foreground' : 'background',
      isMoving: state?.isMoving ?? null,
      lastSampleAt: null,
      odometerMeters: state?.odometer ?? null,
    };
  } catch (e: any) {
    await logEvent('getState_error', { error: String(e?.message || e) });
    return {
      enabled: false,
      trackingMode: 'unknown',
      isMoving: null,
      lastSampleAt: null,
      odometerMeters: null,
    };
  }
}

/** Available — true if the native module is loaded (i.e. not web). */
export function isAvailable(): boolean {
  return bgGeo() !== null;
}

/**
 * Aggregate diagnostics payload for the Diagnostics screen.
 * Combines the in-memory engine state with the persisted ring buffer.
 */
export async function getEngineDiagnostics(): Promise<{
  available: boolean;
  state: LocationEngineState;
  log: EngineLogEvent[];
}> {
  return {
    available: isAvailable(),
    state: await getState(),
    log: await getEngineLog(),
  };
}
