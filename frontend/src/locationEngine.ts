/**
 * Kinnship Location Engine (v1.2.0+).
 *
 * Architectural envelope wrapping `react-native-background-geolocation`
 * (Transistor SDK).  Every Kinnship screen / service that needs
 * background location reliability calls into THIS module, not the
 * library directly.
 *
 * Why the envelope:
 *   • Single place to swap engines in the future without touching the
 *     rest of the app (~unlikely now that we've committed to Transistor,
 *     but cheap insurance).
 *   • Single place to add future features (Safe Zones, arrival
 *     notifications, wandering detection) without re-plumbing screens.
 *   • Clean test boundary — screens can mock the engine interface
 *     instead of mocking the underlying SDK.
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
 * NOT in v1.2.0 (intentionally deferred per founder directive):
 *   • Safe Zones / geofence CRUD UI / arrival-departure notification
 *     events / wandering alerts / privacy controls / Bubble mode.
 *   • Those features will layer on top of this engine via
 *     `BackgroundGeolocation.onGeofence(...)` etc. when ready.
 */
import { Platform } from 'react-native';

// Lazy require so this module is safe to import on web (where the
// native module is absent).  Phase 1 + 2 work happens on Android only.
let BGGeo: any = null;
function bgGeo(): any | null {
  if (Platform.OS === 'web') return null;
  if (BGGeo) return BGGeo;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    BGGeo = require('react-native-background-geolocation').default;
  } catch (_e) {
    BGGeo = null;
  }
  return BGGeo;
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

/**
 * Build the SDK config object for a given session.  Extracted so that
 * both the cold-start `ready()` path and the re-login `setConfig()`
 * path stay in lock-step (same URL template, same headers, same
 * auth strategy).
 */
function buildSdkConfig(lib: any, cfg: LocationEngineConfig): Record<string, any> {
  const uploadUrl =
    `${cfg.backendBaseUrl.replace(/\/$/, '')}/api/members/${cfg.memberId}/location`;

  return {
    // Tracking
    desiredAccuracy: lib.DESIRED_ACCURACY_HIGH,
    distanceFilter: 10,            // meters between fixes when moving
    stopTimeout: 5,                 // minutes of stationary before SDK goes "still"
    locationUpdateInterval: 30000,  // fallback cadence ~30s
    fastestLocationUpdateInterval: 10000,

    // Activity Recognition / motion detection
    activityRecognitionInterval: 10000,
    minimumActivityRecognitionConfidence: 75,

    // Lifecycle
    stopOnTerminate: false,        // keep tracking after app swipe-killed
    startOnBoot: true,             // resume after device reboot
    enableHeadless: true,          // allow background JS in headless mode

    // Foreground service (Android — required by Android 14+)
    foregroundService: true,
    notification: {
      title: 'Kinnship is sharing your location',
      text: 'Your family can see where you are. Tap to pause.',
      smallIcon: 'mipmap/ic_launcher',
      channelName: 'Location sharing',
      // IMPORTANCE_LOW — visible but no sound / no banner.
      priority: lib.NOTIFICATION_PRIORITY_LOW,
      sticky: true,
    },

    // Native HTTP transport — uploads directly from the native service
    // to our backend, bypassing the JS engine entirely.  This is the
    // single biggest reliability win over expo-location.
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
    // ============================================================
    //  JWT authorization (Phase 2 — Transistor official pattern)
    // ============================================================
    //  Per Transistor's official documentation and GitHub issue #1980
    //  (the canonical "JWT rotation" reference), the SDK ships a
    //  built-in `authorization` config that dynamically rebinds the
    //  JWT to outgoing requests.  Manually rotating the
    //  `headers.Authorization` field via setConfig() is documented as
    //  unreliable — the SDK's internal HTTP client may cache the old
    //  value and 401 silently.  Using `authorization` with
    //  `strategy: 'JWT'` means subsequent `setConfig({ authorization:
    //  { accessToken: <new> } })` calls correctly hot-swap the token
    //  on the next outgoing PUT.
    //
    //  Our rolling-refresh path (api.ts response interceptor) listens
    //  to the X-Refresh-Token header on every authenticated response
    //  and calls saveToken() — which fans out to setAuthToken() in
    //  this module via the subscriber registry in api.ts.
    authorization: {
      strategy: 'JWT',
      accessToken: cfg.jwt,
    },

    // Retry queue — locations persist in SDK's SQLite and retry on
    // network return.  Offline drives / Walmart-basement parking are
    // covered automatically.
    maxRecordsToPersist: 10000,
    maxDaysToPersist: 7,

    // Debug — INFO in production once we ship.  VERBOSE during the
    // integration so the sound-effect-free debug ribbon helps field
    // testers see life-cycle events.
    debug: false,
    logLevel: lib.LOG_LEVEL_INFO,
  };
}

/**
 * Start (or re-configure) the background location engine.
 *
 *  - First call after install: invokes `ready()` to configure the
 *    SDK, then `start()` to begin tracking.
 *  - Subsequent calls (e.g. account switch on the same device, or a
 *    cold-restart where the SDK retained its previous configuration):
 *    invokes `setConfig()` instead of `ready()` (per Transistor docs,
 *    `ready()` is intended to be called once per process), then
 *    `start()` to ensure tracking is on.
 *
 *  Safe to call repeatedly.
 */
export async function start(cfg: LocationEngineConfig): Promise<void> {
  const lib = bgGeo();
  if (!lib) return; // web / not-yet-built environments

  const config = buildSdkConfig(lib, cfg);
  cachedConfig = cfg;

  if (isReady) {
    // Re-login / member-id change / token rotation between sessions.
    // setConfig() updates url + authorization + everything else
    // without re-running the one-shot ready() initializer.
    await lib.setConfig(config);
  } else {
    await lib.ready(config);
    isReady = true;
  }

  // start() is the only call that actually begins tracking.  ready()
  // alone configures but does not subscribe to updates.  Idempotent
  // per Transistor docs — calling on an already-running engine is a
  // no-op.
  await lib.start();
}

/** Stop the engine (used during logout or pause). */
export async function stop(): Promise<void> {
  const lib = bgGeo();
  if (!lib) return;
  try { await lib.stop(); } catch (_e) {}
  // Intentionally do NOT clear isReady or cachedConfig here — they
  // describe SDK state (which persists across stop/start) and cached
  // session config (which the next login will overwrite).  Clearing
  // them on logout is handled by the layout effect calling start()
  // with the new session's config.
}

/**
 * Update the JWT used by the native HTTP transport.
 *
 * Called every time `api.ts/saveToken()` runs — i.e. after OTP
 * verify AND after every rolling-refresh response from the backend.
 * Uses the documented `authorization` patch (not `headers`) so the
 * SDK's HTTP interceptor correctly rebinds the token to the next
 * outgoing PUT.  See JWT-rotation comment block in buildSdkConfig.
 */
export async function setAuthToken(jwt: string): Promise<void> {
  const lib = bgGeo();
  if (!lib || !cachedConfig) return;
  cachedConfig.jwt = jwt;
  try {
    await lib.setConfig({
      authorization: {
        strategy: 'JWT',
        accessToken: jwt,
      },
    });
  } catch (_e) {
    // Never let a token-refresh failure crash the api response
    // interceptor — the engine will pick up the new token on the
    // next session boot in the worst case.
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
  } catch (_e) {
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
