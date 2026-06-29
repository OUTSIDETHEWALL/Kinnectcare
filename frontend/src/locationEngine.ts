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
 *   1. Named try/catch on every SDK call.
 *   2. Explicit requestPermission() before start().
 *   3. Persistent ring buffer (30 entries, AsyncStorage).
 *   4. SDK event subscriptions feeding the ring buffer.
 *
 * v1.2.2 — Headless heartbeat (build 42).
 *
 * Build 41 confirmed the engine starts cleanly (`started_ok`,
 * permission ALWAYS) but produced ZERO `sdk_onLocation` /
 * `sdk_onHeartbeat` / `sdk_onHttp` events once the device backgrounded
 * and went stationary.  Root cause: when Android moves Kinnship to the
 * background, the React Native JS runtime is frozen — the native
 * Transistor service stays alive, but the JS callbacks (lib.onLocation,
 * lib.onHeartbeat, ...) can't fire to request a fresh GPS fix or log
 * events.  Without a JS handler to call getCurrentPosition() on each
 * heartbeat, the SDK's motion-detection design suppresses GPS while
 * stationary → no fixes → no uploads → stale location.
 *
 * Build 42 adds the OFFICIAL Transistor fix:
 *
 *   1. Module-load `BackgroundGeolocation.registerHeadlessTask(...)`:
 *      A NATIVE-CONTEXT JS task that Android instantiates on a fresh
 *      tiny JS engine when the SDK fires a heartbeat (or location /
 *      motionchange / http) event AND the main app's JS runtime is
 *      frozen/dead.  Inside the headless task we call
 *      `getCurrentPosition({ samples: 1, persist: true })` — forces a
 *      single GPS sample and queues it through the SDK's native HTTP
 *      transport using the URL+headers+JWT we already configured.
 *
 *   2. Same handler via `lib.onHeartbeat(...)` for the JS-alive case
 *      (app foregrounded).  Idempotent — both layers do the same
 *      `getCurrentPosition` call.
 *
 *   3. Explicit `notification.id: 1` on the foreground-service config
 *      to prevent any chance of multiple notification slots if
 *      setConfig() ever runs concurrently with engine start.
 *
 * Net effect: every 60 seconds while stationary, regardless of JS
 * runtime state, the device wakes briefly, gets a fix, uploads it,
 * and goes back to sleep.  Family dashboard stays fresh; battery
 * cost is roughly identical to the previous foreground polling
 * because the SDK gates GPS acquisition tightly (single sample, no
 * keep-alive).
 */
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { nextSeq } from './diagSeq';
import { DIAG_BUFFER_SIZES, pruneBuffer } from './diagBufferConfig';

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
//  Headless task registration (v1.2.2 / build 42)
// ============================================================
//
// MUST be invoked at module-load time, BEFORE any user interaction.
// Android instantiates a fresh native-context JS engine to run this
// task when the SDK fires an event (heartbeat / location / etc.) AND
// the main app's JS runtime is frozen or dead (post-background or
// post-kill).  Without this, JS callbacks via lib.onHeartbeat(...)
// cannot fire while backgrounded and the SDK's stationary-mode
// behavior (no GPS while still) leads to stale locations.
//
// The headless task must be MINIMAL:
//   • Pure Transistor SDK calls only (no AsyncStorage, no fetch,
//     no other library calls that aren't guaranteed to be initialised
//     in the headless JS context).
//   • Short-running — the headless engine has a strict time budget
//     before Android terminates it (~30 seconds).
//   • Stateless — the headless JS context doesn't share memory with
//     the main app.  Use SDK config (already persisted natively) to
//     pass URL / JWT / headers.
//
// The official documented contract: on every heartbeat we call
// `getCurrentPosition({ samples: 1, persist: true })`.  This:
//   1. Forces a single fresh GPS sample even though the SDK is in
//      stationary mode.
//   2. Persists the sample to the SDK's SQLite queue with
//      `persist: true`.
//   3. The SDK's native HTTP transport (autoSync: true, url, method,
//      headers, authorization — all set by the main-app start() call
//      and persisted natively) PUTs it to our backend.
//   4. SDK releases GPS and the device returns to sleep.
let headlessRegistered = false;
function registerHeadlessTaskOnce(): void {
  if (Platform.OS === 'web') return;
  if (headlessRegistered) return;
  const lib = bgGeo();
  if (!lib) return;

  const HeadlessTask = async (event: any) => {
    try {
      const name = event?.name;
      if (name === 'heartbeat') {
        // Force a fresh GPS fix; SDK persists and uploads via native
        // HTTP transport.  No-op if permission was revoked at the OS
        // level since we last started.
        try {
          await lib.getCurrentPosition({
            samples: 1,
            persist: true,
            timeout: 30,
            extras: { source: 'headless-heartbeat' },
          });
        } catch (_e) {
          // Swallow — Android may also kill us mid-flight; the SDK
          // will retry the upload from its queue on the next event.
        }
      }
      // Other event types (location, motionchange, http) are
      // observability only — we don't need to act on them in
      // headless context, the SDK already handled them natively.
    } catch (_e) {
      // Any uncaught throw in a headless task could destabilize the
      // SDK's native service; defensive top-level catch.
    }
  };

  try {
    lib.registerHeadlessTask(HeadlessTask);
    headlessRegistered = true;
    void logEvent('registerHeadlessTask_ok');
  } catch (e: any) {
    void logEvent('registerHeadlessTask_error', {
      error: String(e?.message || e),
    });
  }
}

// Fire the registration as a side-effect of the first import of this
// module.  React Native module loading order guarantees this runs
// before any login flow because _layout.tsx imports locationEngine at
// the top of its module graph.
//
// IMPORTANT: invoked at the BOTTOM of the file, AFTER all module-level
// `let`/`const` declarations (LOG_KEY, logBuffer, etc.).  If called
// inline here, `bgGeo()` could hit a require failure and try to call
// `logEvent()` which references TDZ'd const/let bindings — TypeError.
// The bottom-of-file invocation is at line ~end of this module.

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
const LOG_MAX = DIAG_BUFFER_SIZES.engineLog;

export type EngineLogEvent = {
  /** Global monotonic seq from diagSeq — strict ordering across all diagnostic streams. */
  seq: number;
  /** Source tag — always 'engine' for entries created by this module. */
  src: 'engine';
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
  logBuffer.push({
    seq: nextSeq(),
    src: 'engine',
    at: Date.now(),
    event,
    detail,
  });
  logBuffer = pruneBuffer(logBuffer, (e) => e.at, LOG_MAX);
  await persistLogBuffer();
}

/**
 * Read the full diagnostic log for the Diagnostics screen.
 * Oldest-first.  Safe to call on web (returns []).
 */
export async function getEngineLog(): Promise<EngineLogEvent[]> {
  await loadLogBuffer();
  logBuffer = pruneBuffer(logBuffer, (e) => e.at, LOG_MAX);
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
      // success: boolean, status: HTTP code, url: string, responseText: string.
      //
      // v1.2.0 (43) — also capture responseText so we have proof of
      // what the BACKEND told us was stored.  The PUT response body
      // is the updated FamilyMember doc as the server saw it,
      // including the `last_seen` value the server actually wrote.
      // Truncate to 400 chars to keep the ring buffer reasonable in
      // size; the leading 400 chars of `{"id":...,"latitude":...,
      // "longitude":...,"last_seen":"..."}` is plenty to confirm
      // identity and freshness.
      let bodyHead: string | null = null;
      let parsed: any = null;
      try {
        const rt = evt?.responseText;
        if (typeof rt === 'string' && rt.length > 0) {
          bodyHead = rt.length > 400 ? rt.slice(0, 400) + '…' : rt;
          // Build 48 — data-integrity fix.
          //
          // The Transistor native HTTP transport pushes location
          // uploads from a JS-less native context.  Pre-Build 48
          // the JS side received the success event but threw the
          // response body away — so the senior's local memberStore
          // could drift many minutes behind the backend even
          // though her engine was uploading successfully every
          // minute.  That divergence is what made Leonidas (which
          // read the engine log) disagree with the Member screen
          // (which read the memberStore).
          //
          // Parse the FULL response (not just the truncated head)
          // and upsert into the canonical store.  Best-effort —
          // any parse failure simply skips the upsert and the
          // next /members poll picks up the change instead.
          if (evt?.success === true && (evt?.status === 200 || evt?.status === 201) && rt.length < 16_000) {
            try {
              const obj = JSON.parse(rt);
              if (obj && typeof obj === 'object' && obj.id) {
                parsed = obj;
              }
            } catch (_e) { /* malformed body — ignore */ }
          }
        }
      } catch (_e) {}
      void logEvent('sdk_onHttp', {
        success: !!evt?.success,
        status: evt?.status,
        // Strip query strings; preserve path so we can confirm we're
        // hitting /api/members/{id}/location and not a misconfigured URL.
        path: (evt?.url || '').split('?')[0],
        bodyHead,
      });
      // Fire upsert AFTER the diagnostic log so the log entry stays
      // a faithful record of what the backend returned even if the
      // upsert throws for some reason.  Use a require()'d ref to the
      // store to avoid a top-of-file circular import.
      if (parsed) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const ms = require('./store/memberStore');
          ms.upsertOne(parsed);
        } catch (_e) { /* swallow — diagnostics already wrote the bodyHead */ }
      }
    });
    lib.onHeartbeat(async () => {
      void logEvent('sdk_onHeartbeat');
      // JS-alive companion to the headless task above.  When the app
      // is foregrounded (or just-backgrounded and JS still attached),
      // force a single fresh GPS sample so the family dashboard
      // stays current without waiting for the headless engine.
      try {
        await lib.getCurrentPosition({
          samples: 1,
          persist: true,
          timeout: 30,
          extras: { source: 'js-heartbeat' },
        });
        void logEvent('heartbeat_getCurrentPosition_ok');
      } catch (e: any) {
        void logEvent('heartbeat_getCurrentPosition_error', {
          error: String(e?.message || e),
        });
      }
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
      // Explicit fixed id ensures Android updates the existing
      // foreground-service notification in place rather than creating
      // a new slot if setConfig() ever rebinds the notification config
      // mid-session (e.g. on a token rotation).
      id: 1,
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
 * Force a single fresh GPS sample and queue it through the SDK's
 * native HTTP transport.  Used by Leonidas (Build 45) for intelligent
 * recovery when a stationary phone has gone silent too long.
 * Returns void on success / throws on SDK error.  Caller should treat
 * an absence of `sdk_onHttp` events as failure even if this resolves.
 */
export async function requestFreshLocation(): Promise<void> {
  const lib = bgGeo();
  if (!lib) {
    await logEvent('requestFreshLocation_skipped', { reason: 'native_module_unavailable' });
    return;
  }
  await logEvent('requestFreshLocation_invoked');
  try {
    await lib.getCurrentPosition({
      samples: 1,
      persist: true,
      timeout: 30,
      extras: { source: 'leonidas-recovery' },
    });
    await logEvent('requestFreshLocation_ok');
  } catch (e: any) {
    await logEvent('requestFreshLocation_error', { error: String(e?.message || e) });
    throw e;
  }
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

// ============================================================
//  Module bootstrap (v1.2.2 / build 42)
// ============================================================
//
// Registers the native headless task with the Transistor SDK on the
// first import of this module — typically done by _layout.tsx at app
// startup, well before any auth flow runs.
//
// Placed at the VERY END of the file (rather than co-located with the
// `registerHeadlessTaskOnce` declaration up top) so that all
// module-level `let` / `const` bindings used by the diagnostic
// logger (LOG_KEY, LOG_MAX, logBuffer, logBufferLoaded, etc.) are
// already initialised before bootstrap runs.  If `bgGeo()` happens to
// fail on first require and `logEvent('require_failed', ...)` is
// invoked, that path now reads fully-initialised bindings instead of
// hitting a temporal-dead-zone TypeError.
registerHeadlessTaskOnce();
