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

/** Start (or re-configure) the background location engine. */
export async function start(cfg: LocationEngineConfig): Promise<void> {
  const lib = bgGeo();
  if (!lib) return; // web / not-yet-built environments

  cachedConfig = cfg;
  const uploadUrl =
    `${cfg.backendBaseUrl.replace(/\/$/, '')}/api/members/${cfg.memberId}/location`;

  // SDK config — follows Transistor's recommended "family safety" preset.
  // Adaptive cadence is driven by the SDK's internal motion detection;
  // we don't try to override it with custom intervals.  Reliability first.
  await lib.ready({
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
      Authorization: `Bearer ${cfg.jwt}`,
      'Content-Type': 'application/json',
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
  });

  // start() is the only call that actually begins tracking.  ready()
  // alone configures but does not subscribe to updates.
  await lib.start();
}

/** Stop the engine (used during logout or pause). */
export async function stop(): Promise<void> {
  const lib = bgGeo();
  if (!lib) return;
  try { await lib.stop(); } catch (_e) {}
}

/** Update the JWT header (called on token refresh). */
export async function setAuthToken(jwt: string): Promise<void> {
  const lib = bgGeo();
  if (!lib || !cachedConfig) return;
  cachedConfig.jwt = jwt;
  await lib.setConfig({
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
  });
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
