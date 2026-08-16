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
import { Platform, AppState } from 'react-native';
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
//  Pipeline Timestamp Tracking (Task #21 — root cause investigation)
// ============================================================
//
// One AsyncStorage key per pipeline stage.  Written fire-and-forget at each
// callback site so Charles can read the most-recent timestamp for every stage
// from Diagnostics without scanning the full ring buffer.
//
// The goal is to answer: "Which stage went silent while earlier stages were
// still active?"  If motion callbacks are fresh but HTTP uploads are 2 hours
// old, the fault is between motion detection and the upload — not in the
// foreground service or the GPS.
//
// Keys are intentionally short (written on every callback tick).
const PTS_PREFIX = 'kc_pts_';
const PTS_KEYS = {
  motion:             `${PTS_PREFIX}motion`,    // onMotionChange
  activity:           `${PTS_PREFIX}activity`,  // onActivityChange
  location:           `${PTS_PREFIX}loc`,       // onLocation (success path)
  heartbeat_js:       `${PTS_PREFIX}hb_js`,     // onHeartbeat (JS runtime alive)
  headless_invoked:   `${PTS_PREFIX}hl_inv`,    // HeadlessTask — any event
  headless_heartbeat: `${PTS_PREFIX}hl_hb`,     // HeadlessTask — heartbeat ok
  headless_battery:   `${PTS_PREFIX}hl_bat`,    // HeadlessTask — battery PATCH sent
  http_attempt:       `${PTS_PREFIX}http_att`,  // onHttp — any call
  http_success:       `${PTS_PREFIX}http_ok`,   // onHttp — 200/201 success
  listeners_attached: `${PTS_PREFIX}attached`,  // attachSdkListeners completed
} as const;

type PtsKey = keyof typeof PTS_KEYS;

/** Write current epoch ms for one pipeline stage.  Fire-and-forget — never throws. */
function recordPipelineTs(stage: PtsKey): void {
  AsyncStorage.setItem(PTS_KEYS[stage], String(Date.now())).catch(() => {});
}

/** Per-stage timestamps keyed by stage name.  null = this stage has never fired. */
export type PipelineTimestamps = { [K in PtsKey]: number | null };

/** Read just the last-successful HTTP upload timestamp from its dedicated
 *  persistent key.  Faster than reading all pipeline timestamps when only
 *  the upload health row needs a fallback.
 *
 *  Returns the epoch-ms of the last confirmed 200/201 upload, or null if
 *  no successful upload has been recorded on this device yet.
 *
 *  This key is written by BOTH the foreground onHttp handler and the
 *  headless HTTP event handler, so it stays current regardless of whether
 *  the main JS runtime was alive at upload time.
 */
export async function getLastHttpSuccessTs(): Promise<number | null> {
  try {
    const raw = await AsyncStorage.getItem(PTS_KEYS.http_success);
    return raw ? Number(raw) : null;
  } catch {
    return null;
  }
}

/** Read all pipeline timestamps from AsyncStorage.  Safe to call from anywhere. */
export async function getPipelineTimestamps(): Promise<PipelineTimestamps> {
  const pairs = await Promise.all(
    (Object.entries(PTS_KEYS) as [PtsKey, string][]).map(async ([stage, key]) => {
      try {
        const raw = await AsyncStorage.getItem(key);
        return [stage, raw ? Number(raw) : null] as [PtsKey, number | null];
      } catch {
        return [stage, null] as [PtsKey, number | null];
      }
    }),
  );
  return Object.fromEntries(pairs) as PipelineTimestamps;
}

/** True if SDK JS listeners have been attached in this runtime instance.
 *  False means the listenersAttached guard was never cleared — if the native
 *  SDK bridge reset without a full JS process restart, callbacks won't fire
 *  and this stays true while the SDK is deaf. */
export function isListenersAttached(): boolean {
  return listenersAttached;
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
//   • Transistor SDK calls + AsyncStorage (via logEvent) + fetch for
//     the explicit battery PATCH (see below) are allowed.  Native
//     module bridges that require a foreground activity context
//     (expo-battery, react-native-permissions, etc.) must NOT be used.
//   • Short-running — call only what is necessary; the headless engine
//     is not subject to a hard Android timeout but should return
//     promptly to avoid blocking the SDK's event queue.
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
      // ── Headless diagnostic entry ─────────────────────────────────
      // This is our only window into the SDK running while the main JS
      // runtime is frozen (post-kill, post-boot, background heartbeat).
      // AsyncStorage IS available in this context — backgroundLocation.ts
      // uses it on every tick.  Each headless invocation starts a fresh
      // JS context, so logBuffer/logBufferLoaded always begin at their
      // defaults; loadLogBuffer() reads from AsyncStorage to pick up the
      // persisted ring buffer before appending.
      //
      // Task #21: record headless invocation timestamp so Diagnostics can
      // show whether the headless task is still firing while JS callbacks
      // have gone silent — this distinguishes "headless alive, JS dead"
      // from "entire background pipeline stopped".
      recordPipelineTs('headless_invoked');
      await logEvent('headless_task_invoked', { eventName: name ?? 'unknown' });

      if (name === 'heartbeat') {
        // Force a fresh GPS fix; SDK persists and uploads via native
        // HTTP transport.  No-op if permission was revoked at the OS
        // level since we last started.
        try {
          const pos = await lib.getCurrentPosition({
            samples: 1,
            persist: true,
            timeout: 30,
            extras: { source: 'headless-heartbeat' },
          });
          recordPipelineTs('headless_heartbeat');
          await logEvent('headless_heartbeat_ok');

          // ── Headless battery PATCH ──────────────────────────────────────
          //
          // The Transistor SDK's native location upload includes battery data
          // (battery.level / battery.is_charging) and the backend extracts it
          // via LocationUpdate._normalize_payload().  However, that path has
          // historically been unreliable: if the JS runtime died while alive
          // (leaving battery_updated_at anchored to a wall-clock PATCH
          // timestamp), subsequent native uploads with GPS-clock captured_at
          // timestamps could fail the write guard.
          //
          // This explicit PATCH is a fully independent battery update path
          // that runs from the headless context using:
          //   • Battery values from the SDK's native reading in the position
          //     result — no expo-battery bridge, no foreground-only API.
          //   • JWT + upload URL from the SDK's persisted SQLite config via
          //     lib.getState() — no shared memory with the main app needed.
          //
          // Result: battery_updated_at advances every ~60 s even when the
          // main JS runtime has been killed by Android, preventing the
          // caregiver's battery row from going stale during long stationary
          // periods (the original 19-hour disappearance bug).
          try {
            const battLevel: number | undefined = pos?.battery?.level;
            // Part 1 fix — SDK may return is_charging as 0/1 (integer) on some
            // Android devices rather than true/false (boolean).  The previous
            // `typeof battCharging === 'boolean'` guard silently skipped the
            // PATCH in those cases.  Coerce to boolean here; null means absent.
            const battChargingRaw = pos?.battery?.is_charging;
            const battCharging: boolean | null =
              battChargingRaw != null ? Boolean(battChargingRaw) : null;
            if (
              typeof battLevel === 'number' && battLevel >= 0 &&
              battCharging !== null
            ) {
              const sdkState = await lib.getState();
              const locationUrl: string = sdkState?.url ?? '';
              const jwt: string = sdkState?.authorization?.accessToken ?? '';
              // URL shape: https://HOST/api/members/MEMBER_ID/location
              const memberMatch = locationUrl.match(/\/members\/([^/]+)\/location/);
              const memberId = memberMatch?.[1] ?? '';
              const baseUrl = locationUrl.split('/api/members/')[0] ?? '';
              if (memberId && jwt && baseUrl) {
                const ts = new Date().toISOString();
                const battUrl = `${baseUrl}/api/members/${memberId}/battery`;
                await Promise.race([
                  fetch(battUrl, {
                    method: 'PATCH',
                    headers: {
                      'Content-Type': 'application/json',
                      'Authorization': `Bearer ${jwt}`,
                    },
                    body: JSON.stringify({
                      battery_level: battLevel,
                      is_charging: battCharging,
                      battery_updated_at: ts,
                    }),
                  }),
                  // Safety timeout — never block the headless engine queue
                  // for more than 6 s waiting for a slow network response.
                  new Promise<never>((_, rej) =>
                    setTimeout(() => rej(new Error('headless-battery-patch-timeout')), 6000),
                  ),
                ]);
                recordPipelineTs('headless_battery');
                await logEvent('headless_battery_patch_ok', { battLevel, battCharging });
              } else {
                await logEvent('headless_battery_patch_skipped', {
                  reason: 'missing_member_id_or_jwt',
                  hasMemberId: !!memberId,
                  hasJwt: !!jwt,
                  hasBaseUrl: !!baseUrl,
                });
              }
            } else {
              await logEvent('headless_battery_patch_skipped', {
                reason: 'invalid_battery_values',
                battLevel: battLevel ?? null,
                battCharging: battCharging ?? null,
              });
            }
          } catch (battE: any) {
            await logEvent('headless_battery_patch_error', {
              error: String(battE?.message || battE),
            });
          }
          // ── End headless battery PATCH ──────────────────────────────────
        } catch (e: any) {
          await logEvent('headless_heartbeat_error', {
            error: String(e?.message || e),
          });
        }

        // Leonidas v1.1 — headless recovery path.
        //
        // If a heartbeat arrived it means the Transistor native service
        // is alive.  However, the engine may be in a disabled state if
        // a previous Leonidas patrol called stop() but could not complete
        // the restart (v1.0 limitation).  Check and recover here while
        // we still have an active headless execution window.
        //
        // In the headless JS context cachedConfig is always null (fresh
        // JS process — no memory shared with the main app).  We call
        // lib.start() with no arguments: the Transistor SDK persists its
        // native config (URL, JWT, headers) across stop/start cycles in
        // its own SQLite store, so a no-arg start() is valid and safe.
        //
        // This does NOT override or conflict with the main app's start()
        // path — if the app subsequently foregrounds and calls start()
        // with a fresh JWT, setConfig() applies the new token on top.
        try {
          const st = await lib.getState();
          if (st?.enabled === false) {
            await logEvent('headless_engine_disabled_restart_attempted');
            await lib.start();
            await logEvent('headless_engine_disabled_restart_ok');
          }
        } catch (e: any) {
          await logEvent('headless_engine_disabled_restart_error', {
            error: String(e?.message || e),
          });
        }
      }

      if (name === 'http') {
        // ── Headless HTTP upload confirmation ─────────────────────────
        //
        // The Transistor SDK delivers http events to the headless task
        // whenever its native HTTP transport completes a location upload
        // (success or failure) while the main JS runtime is frozen.
        // This is the PRIMARY upload evidence path for users who keep
        // Kinnship entirely in the background.
        //
        // lib.onHttp() inside attachSdkListeners() only fires when the
        // main JS runtime is alive (foreground or just-backgrounded).
        // For background-only users, that listener never fires so the
        // ring buffer stays empty and the Health Check always shows
        // "waiting for first upload" — a false alarm.
        //
        // Writing sdk_onHttp here means the same ring buffer key that
        // computeOverallHealth() and computeHealthItems() already search
        // will now be populated from the headless path as well.
        //
        // The Transistor HeadlessEvent contract (HeadlessEvent.d.ts):
        //   event.name   — event type string (e.g. 'http')
        //   event.params — event-specific payload (HttpEvent: { success, status, responseText })
        //
        // HttpEvent does not carry a `url` field in the SDK's declared interface,
        // so `path` is left empty; success/status/responseText are the key signals.
        const params = event?.params ?? {};
        const success: boolean = !!params?.success;
        const status: number | null = typeof params?.status === 'number' ? params.status : null;
        // Capture a truncated response body for data-integrity confirmation
        // (same 400-char limit used by the foreground onHttp handler).
        let bodyHead: string | null = null;
        try {
          const rt: string | undefined = params?.responseText;
          if (typeof rt === 'string' && rt.length > 0) {
            bodyHead = rt.length > 400 ? rt.slice(0, 400) + '…' : rt;
          }
        } catch (_e) { /* best-effort */ }

        await logEvent('sdk_onHttp', { success, status, path: '', bodyHead });

        // Explicit named ok/error events alongside sdk_onHttp so the
        // Diagnostics upload-ratio card can count headless successes and
        // failures without decoding the success boolean inside sdk_onHttp.
        // Mirrors the foreground handler's http_upload_success / http_upload_failure.
        if (success) {
          await logEvent('headless_http_ok', { status });
        } else {
          await logEvent('headless_http_error', { status, bodyHead });
        }

        // Record every HTTP attempt (success or failure) so Charles can
        // distinguish "upload never tried" from "upload tried and failed"
        // in Diagnostics when the device is backgrounded.  Without this,
        // repeated upload failures leave http_attempt null for background-
        // only users, which is indistinguishable from "SDK never reached
        // the HTTP stage at all."  Mirrors the foreground onHttp handler.
        recordPipelineTs('http_attempt');

        // Persist the last-successful-upload timestamp in its own
        // dedicated AsyncStorage key so it survives ring-buffer eviction.
        // If the 50-entry buffer fills with failure entries, computeHealthItems()
        // can still find evidence that uploads are working by reading this key
        // directly (via getLastHttpSuccessTs / getPipelineTimestamps).
        if (success) {
          recordPipelineTs('http_success');
        }

        // Upsert into memberStore when the upload succeeded and we have
        // a parseable response body — keeps the local store consistent
        // with the backend without waiting for the next /members poll.
        // AsyncStorage is available in the headless context; memberStore
        // uses it internally, so this is safe to call here.
        if (success && bodyHead !== null) {
          try {
            const fullRt: string | undefined = params?.responseText;
            if (typeof fullRt === 'string' && fullRt.length > 0 && fullRt.length < 16_000) {
              const obj = JSON.parse(fullRt);
              if (obj && typeof obj === 'object' && obj.id) {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const ms = require('./store/memberStore');
                ms.upsertOne(obj);
              }
            }
          } catch (_e) { /* parse/upsert failure — next /members poll will catch up */ }
        }
      }

      // Sprint 1 stale-location fix — headless motionchange handler.
      //
      // The Transistor SDK normally handles GPS → native HTTP upload by itself
      // when it transitions from stationary → moving.  However, on devices
      // where Android battery optimisation throttles or kills the foreground
      // service, that native autoSync chain can silently stall.  The symptom
      // is exactly what Charles observed: Joyce starts driving but no upload
      // arrives until she manually opens the app (which triggers locationRefresh).
      //
      // Forcing getCurrentPosition here gives us a JS-triggered upload in the
      // same headless execution window as the motionchange event.  This is
      // belt-and-suspenders alongside the native transport — if native is fine,
      // the two uploads are idempotent (server keeps the newer last_seen).
      // If native is stalled, this upload becomes the recovery.
      //
      // Event shape: HeadlessEvent wraps the SDK payload in either
      //   event.event.isMoving  (newer SDK versions)  or
      //   event.isMoving        (older SDK versions, direct unwrapping)
      if (name === 'motionchange') {
        const isMoving: boolean = !!(
          (event?.event?.isMoving) ?? (event?.isMoving)
        );
        if (isMoving) {
          // Cooldown gate: Android Activity Recognition can re-evaluate
          // confidence and deliver multiple motionchange(isMoving:true)
          // events within the same minute.  Without this guard a long
          // drive could trigger dozens of getCurrentPosition calls.
          // 60-second window matches the heartbeat interval — at worst
          // we duplicate the heartbeat's upload once per minute, which
          // is idempotent on the backend (server keeps newer last_seen).
          const nowMs = Date.now();
          const msSinceLast = nowMs - _lastMotionRecoveryTs;
          if (msSinceLast < MOTION_RECOVERY_COOLDOWN_MS) {
            await logEvent('headless_motionchange_recovery_throttled', {
              secondsAgo: Math.floor(msSinceLast / 1000),
            });
          } else {
            _lastMotionRecoveryTs = nowMs;
            // ── Pipeline instrumentation (Charles addendum) ──────────────
            // Log every step so a single real-world drive tells us exactly
            // where the chain succeeds or fails, without guessing.
            await logEvent('motion_recovery_start', {
              source: 'headless',
              secondsSinceLast: Math.floor(msSinceLast / 1000),
            });
            try {
              await logEvent('getCurrentPosition_start', { source: 'headless' });
              const loc = await lib.getCurrentPosition({
                samples: 1, persist: true, timeout: 30,
                extras: { source: 'headless-motionchange' },
              });
              // GPS fix received — coordinates available, SDK will auto-upload
              // because persist:true.  Round to 0.01° (~1.1 km) for privacy.
              await logEvent('gps_fix_received', {
                source: 'headless',
                lat: round01(loc?.coords?.latitude),
                lng: round01(loc?.coords?.longitude),
                accuracy: typeof loc?.coords?.accuracy === 'number'
                  ? Math.round(loc.coords.accuracy) : null,
              });
              // Native HTTP transport will fire the PUT automatically via
              // autoSync — we cannot observe the exact moment the socket
              // opens, but persist:true guarantees it will happen.
              await logEvent('upload_queued', { source: 'headless', persist: true });
              recordPipelineTs('headless_heartbeat');
              await logEvent('headless_motionchange_getCurrentPosition_ok');
            } catch (e: any) {
              await logEvent('headless_motionchange_getCurrentPosition_error', {
                error: String(e?.message || e),
              });
            }
          }
        } else {
          await logEvent('headless_motionchange_stationary');
        }
      }

      // Other event types (location) are observability only — the SDK
      // already handled them natively.
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

// ============================================================
//  Device info injection (Task #21 — engine snapshot enrichment)
// ============================================================
//
// _layout.tsx calls setDeviceInfo() once at startup so the stale
// snapshot event can include device model, binary build number, and
// OTA group ID without importing Constants/Updates here (which would
// risk native-module loading order issues in the headless context).
//
// The snapshot push also uses this config to reach the backend.
export type DeviceInfo = {
  model: string | null;          // e.g. "Pixel 8 Pro" or "SM-G998U"
  buildNumber: string | null;    // nativeBuildVersion
  otaUpdateId: string | null;    // expo-updates updateId
  otaChannel: string | null;     // expo-updates channel
};
let _deviceInfo: DeviceInfo = {
  model: null,
  buildNumber: null,
  otaUpdateId: null,
  otaChannel: null,
};

/** Called once from _layout.tsx at startup — provides device metadata
 *  for the automatic stale snapshot (Task #21 Deliverable 1). */
export function setDeviceInfo(info: DeviceInfo): void {
  _deviceInfo = info;
}

// Activity-change dedup — onActivityChange fires every
// activityRecognitionInterval (10 s) even when the activity is
// unchanged.  Only log when the type OR the moving-state changes so the
// 50-entry ring buffer stays useful across a full trip rather than being
// consumed in the first few minutes.
let _lastActivityType: string | null = null;
let _lastActivityIsMoving: boolean | null = null;
// Cooldown gate shared by the headless motionchange handler and the
// JS-alive onMotionChange listener.  Both live in the same JS module
// scope so a single variable covers both paths within a process lifetime.
// Resets to 0 on cold start — the first motionchange after engine init
// always fires, which is the desired behaviour.
let _lastMotionRecoveryTs = 0;
const MOTION_RECOVERY_COOLDOWN_MS = 60_000; // 60 s — matches heartbeat interval

// ============================================================
//  Battery synchronisation — three paths
// ============================================================
//
// Battery state reaches the backend through three independent paths:
//
//   a) JS-alive heartbeat (every 60 s, stationary case):
//      pushBatteryUpdate('heartbeat') → PATCH /battery.
//      Uses expo-battery.  Requires the main JS runtime to be alive.
//
//   b) JS-alive state-change / level-change listeners:
//      pushBatteryUpdate('charging-state'|'level-change') → PATCH /battery.
//      Fires on plug/unplug events and ~1% level changes.  JS-alive only.
//
//   c) Headless heartbeat (runs even when the main JS runtime is killed):
//      HeadlessTask fires getCurrentPosition() → on success, explicit
//      PATCH /battery using battery data from the position result.
//      Also, the SDK's native location upload always includes
//      battery.level / battery.is_charging in its JSON payload; the
//      backend extracts these via LocationUpdate._normalize_payload().
//
// Path (c) is the critical reliability path for long stationary periods:
// Android aggressively kills the main JS runtime on Samsung and other
// battery-optimised devices after 15–60 minutes of background inactivity.
// Without path (c), battery_updated_at stops advancing and the caregiver's
// battery row disappears after the dashboard's staleness threshold.
//
// expo-battery MUST NOT be called from the headless task — it requires a
// foreground activity context that the headless engine does not have.
let batteryListenersAttached = false;
// Module-level subscription refs — MUST be held to prevent GC.
// React Native's event emitter removes a listener the moment its
// Subscription object is garbage-collected.  Storing them here keeps
// them alive for the lifetime of the JS runtime.
let _battStateSubscription: any = null;
let _battLevelSubscription: any = null;

async function readBatteryState(): Promise<{ level: number | null; isCharging: boolean | null }> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Battery = require('expo-battery');
    const level = await Battery.getBatteryLevelAsync();
    const state = await Battery.getBatteryStateAsync();
    const isCharging: boolean =
      state === Battery.BatteryState.CHARGING ||
      state === Battery.BatteryState.FULL;
    return {
      level:      typeof level === 'number' && isFinite(level) && level >= 0 ? level : null,
      isCharging,
    };
  } catch (e: any) {
    void logEvent('battery_read_error', { error: String(e?.message || e) });
    return { level: null, isCharging: null };
  }
}

export async function pushBatteryUpdate(source: string = 'unknown'): Promise<void> {
  // Step 1 — guard: cachedConfig must be set (i.e. start() was called).
  if (!cachedConfig) {
    void logEvent('battery_push_skipped', { reason: 'no_cached_config', source });
    return;
  }
  void logEvent('battery_push_start', { source, memberId: cachedConfig.memberId });

  // Step 2 — read battery state from expo-battery.
  const { level, isCharging } = await readBatteryState();
  void logEvent('battery_read_result', { level, isCharging, source });

  if (level === null && isCharging === null) {
    void logEvent('battery_push_skipped', { reason: 'no_data_from_expo_battery', source });
    return;
  }

  // Step 3 — send PATCH to backend.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { api } = require('./api');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ms = require('./store/memberStore');
    const ts = new Date().toISOString();
    const body: Record<string, unknown> = { battery_updated_at: ts };
    if (level !== null)      body.battery_level = level;
    if (isCharging !== null) body.is_charging   = isCharging;

    const url = `/members/${cachedConfig.memberId}/battery`;
    void logEvent('battery_patch_sent', { url, level, isCharging, ts });

    const resp = await api.patch(url, body);
    const httpStatus: number = resp?.status ?? 0;
    const hasId = !!(resp?.data?.id);

    void logEvent('battery_patch_response', {
      httpStatus,
      hasId,
      batteryLevel: resp?.data?.battery_level ?? null,
      isCharging:   resp?.data?.is_charging ?? null,
      batteryUpdatedAt: resp?.data?.battery_updated_at ?? null,
    });

    // Step 4 — push the fresh member doc into the store so the UI
    // updates without waiting for the next /members poll.
    if (hasId) {
      ms.upsertOne(resp.data);
      void logEvent('battery_store_updated', { memberId: resp.data.id });
    }
  } catch (e: any) {
    void logEvent('battery_patch_error', {
      source,
      error:  String(e?.message || e),
      status: e?.response?.status ?? null,
      data:   JSON.stringify(e?.response?.data ?? null).slice(0, 200),
    });
  }
}

// ============================================================
//  Device snapshot push (Task #21 Deliverable 2)
// ============================================================
//
// Called from the stale-detection path on every JS heartbeat where
// the last HTTP upload is >5 min old.  Sends a lightweight payload
// to the backend so Charles's Diagnostics screen can show both phones'
// pipeline state side-by-side without Charles needing to physically
// touch Joyce's phone.
//
// Uses the same cachedConfig / require('./api') pattern as
// pushBatteryUpdate() — safe in JS-alive (foreground/just-backgrounded)
// context only.  NOT called from the headless task.

/**
 * Test helper — push the current device snapshot to the backend immediately,
 * regardless of upload health.  Intended for use from the Diagnostics screen
 * so Charles can confirm the full round-trip (device → backend →
 * family-snapshot endpoint) without waiting for a real stale event.
 *
 * Returns `{ ok: true }` on success, or `{ ok: false, error: string }` on
 * failure (including "not configured yet" when the engine has never been
 * started).
 */
export async function triggerDeviceSnapshotNow(): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!cachedConfig) {
    return { ok: false, error: 'Engine not configured — start the location engine first' };
  }
  try {
    const pts = await getPipelineTimestamps();
    const now = Date.now();
    const lib = bgGeo();
    let sdkSt: any = null;
    if (lib) {
      try { sdkSt = await lib.getState(); } catch (_e) { /* best-effort */ }
    }
    await pushDeviceSnapshotToBackend(pts, now, sdkSt);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function pushDeviceSnapshotToBackend(
  pts: PipelineTimestamps,
  now: number,
  sdkSt: any,
): Promise<void> {
  if (!cachedConfig) return;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { api } = require('./api');
  const body = {
    at:                  new Date(now).toISOString(),
    // Device identity
    device_model:        _deviceInfo.model,
    ota_update_id:       _deviceInfo.otaUpdateId,
    ota_channel:         _deviceInfo.otaChannel,
    // App state
    app_state:           AppState.currentState,
    listeners_attached:  listenersAttached,
    // SDK state
    sdk_enabled:         sdkSt?.enabled      ?? null,
    sdk_is_moving:       sdkSt?.isMoving     ?? null,
    sdk_tracking_mode:   sdkSt?.trackingMode ?? null,
    // Per-stage pipeline ages (ms since last callback; null = never fired)
    activity_age_ms:     pts.activity           !== null ? now - pts.activity           : null,
    motion_age_ms:       pts.motion             !== null ? now - pts.motion             : null,
    location_age_ms:     pts.location           !== null ? now - pts.location           : null,
    hb_js_age_ms:        pts.heartbeat_js       !== null ? now - pts.heartbeat_js       : null,
    hl_inv_age_ms:       pts.headless_invoked   !== null ? now - pts.headless_invoked   : null,
    hl_hb_age_ms:        pts.headless_heartbeat !== null ? now - pts.headless_heartbeat : null,
    http_att_age_ms:     pts.http_attempt       !== null ? now - pts.http_attempt       : null,
    http_ok_age_ms:      pts.http_success       !== null ? now - pts.http_success       : null,
  };
  // Throws on network/auth/server error — callers decide whether to swallow
  // (heartbeat path: best-effort fire-and-forget) or propagate
  // (triggerDeviceSnapshotNow: diagnostic path that must report real failures).
  await api.put(`/members/${cachedConfig.memberId}/device-snapshot`, body);
}

function attachBatteryListeners(): void {
  if (batteryListenersAttached || Platform.OS === 'web') return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Battery = require('expo-battery');
    // Store subscriptions at module scope — prevents GC from silently
    // removing the listeners between heartbeat ticks.
    _battStateSubscription = Battery.addBatteryStateListener(() => {
      void pushBatteryUpdate('state_change');
    });
    _battLevelSubscription = Battery.addBatteryLevelListener(() => {
      void pushBatteryUpdate('level_change');
    });
    batteryListenersAttached = true;
    void logEvent('battery_listeners_attached');
  } catch (e: any) {
    void logEvent('battery_listeners_failed', { error: String(e?.message || e) });
  }
}

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
        recordPipelineTs('location');
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
    lib.onMotionChange(async (evt: any) => {
      recordPipelineTs('motion');
      void logEvent('sdk_onMotionChange', { isMoving: !!evt?.isMoving });
      // Sprint 1 stale-location fix — JS-alive path.
      // Mirror of the headless motionchange handler: when JS is alive and
      // the SDK transitions to moving, force an immediate GPS sample so
      // the upload doesn't wait for the next 60-second heartbeat tick.
      // native autoSync will also fire; the two uploads are idempotent.
      if (evt?.isMoving) {
        // Same 60-second cooldown gate as the headless handler.
        // _lastMotionRecoveryTs is module-level and shared between both
        // paths — a headless event that already fired 10 s ago will also
        // suppress a redundant JS-alive call here.
        const nowMs = Date.now();
        const msSinceLast = nowMs - _lastMotionRecoveryTs;
        if (msSinceLast < MOTION_RECOVERY_COOLDOWN_MS) {
          void logEvent('motionchange_recovery_throttled', {
            secondsAgo: Math.floor(msSinceLast / 1000),
          });
        } else {
          _lastMotionRecoveryTs = nowMs;
          // ── Pipeline instrumentation (Charles addendum) ──────────────
          void logEvent('motion_recovery_start', {
            source: 'js',
            secondsSinceLast: Math.floor(msSinceLast / 1000),
          });
          try {
            void logEvent('getCurrentPosition_start', { source: 'js' });
            const loc = await lib.getCurrentPosition({
              samples: 1, persist: true, timeout: 30,
              extras: { source: 'js-motionchange' },
            });
            void logEvent('gps_fix_received', {
              source: 'js',
              lat: round01(loc?.coords?.latitude),
              lng: round01(loc?.coords?.longitude),
              accuracy: typeof loc?.coords?.accuracy === 'number'
                ? Math.round(loc.coords.accuracy) : null,
            });
            void logEvent('upload_queued', { source: 'js', persist: true });
            void logEvent('motionchange_getCurrentPosition_ok');
          } catch (e: any) {
            void logEvent('motionchange_getCurrentPosition_error', {
              error: String(e?.message || e),
            });
          }
        }
      }
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
    // Power-save awareness — fires when Android battery-saver mode
    // activates or deactivates.  Battery-saver suppresses background
    // work and GPS wake-locks even for foreground services, so knowing
    // when it is active is a key diagnostic for stale-location reports.
    // The SDK wrapper is optional (guard avoids crash on SDK versions
    // that don't yet expose this binding).
    if (typeof lib.onPowerSaveChange === 'function') {
      lib.onPowerSaveChange((isPowerSaveMode: boolean) => {
        void logEvent('sdk_onPowerSaveChange', { isPowerSaveMode });
      });
    }
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
      recordPipelineTs('http_attempt');
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
            recordPipelineTs('http_success');
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
      // Explicit named events alongside sdk_onHttp (Charles addendum):
      // "Upload succeeds" and "Upload fails" as unambiguous ring buffer
      // entries so a single drive's log answers the question without
      // decoding the success boolean inside sdk_onHttp.
      if (evt?.success) {
        void logEvent('http_upload_success', {
          status: evt?.status,
          path: (evt?.url || '').split('?')[0],
        });
      } else {
        void logEvent('http_upload_failure', {
          status: evt?.status,
          path: (evt?.url || '').split('?')[0],
        });
      }
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
    lib.onEnabledChange((enabled: boolean) => {
      // Fires whenever the SDK transitions enabled ↔ disabled.
      // Critical for blank-notification investigation: if this fires
      // with enabled=true BEFORE our ready_invoked entry, the native
      // foreground service started autonomously (boot/startOnBoot)
      // without any JS config having been applied yet.
      void logEvent('sdk_onEnabledChange', { enabled });
    });
    lib.onHeartbeat(async () => {
      recordPipelineTs('heartbeat_js');
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
      // Battery companion — read and PATCH on every heartbeat tick so
      // the caregiver dashboard stays current even when stationary.
      // This is JS-alive only; the headless task never calls expo-battery.
      void pushBatteryUpdate('heartbeat');

      // ── Task #21: Automatic stale snapshot (Deliverable 1) ───────────────
      // If the JS heartbeat is firing but the last confirmed HTTP upload
      // is >5 min old, log a full engine snapshot so we have a structured
      // record of what the engine believed during the gap — no manual
      // trigger needed.  Threshold is deliberately shorter than the 15-min
      // health-check warning so we catch the stale condition early.
      //
      // Additionally, push a compact version of the pipeline timestamps to
      // the backend so Charles's Diagnostics screen can show both devices'
      // state side-by-side (Deliverable 2).  The push is fire-and-forget —
      // it must never block or throw in the onHeartbeat path.
      void (async () => {
        try {
          const pts = await getPipelineTimestamps();
          const now = Date.now();
          const httpOkAge = pts.http_success !== null ? now - pts.http_success : null;
          const sdkSt = await lib.getState().catch(() => null);

          // Always push pipeline timestamps to the backend on every JS heartbeat
          // so Charles's Device Comparison table in Diagnostics shows fresh
          // pipeline ages for both devices during healthy operation — not only
          // after a stale-upload event.  The PUT endpoint writes a single field
          // in the member doc; at <1 KB per call and ~60 s cadence, the added
          // load is negligible.
          //
          // Best-effort: swallow network/server errors here so a transient
          // backend hiccup never disturbs the heartbeat pipeline.
          try {
            await pushDeviceSnapshotToBackend(pts, now, sdkSt);
          } catch (_e) {
            void logEvent('device_snapshot_push_error', { error: String((_e as any)?.message || _e) });
          }

          // Only log the verbose stale snapshot when uploads are actually stale
          // (>5 min since last confirmed HTTP success).  This keeps the ring
          // buffer free of noise during healthy operation.
          if (httpOkAge === null || httpOkAge > 5 * 60 * 1000) {
            // Deliverable 1 — structured snapshot with all required fields.
            // AppState.currentState reads synchronously from the React Native
            // AppState module (safe to call from any async context).
            await logEvent('engine_snapshot_stale', {
              trigger:            'js_heartbeat',
              // Device identity (injected by _layout.tsx at startup)
              device_model:       _deviceInfo.model,
              build_number:       _deviceInfo.buildNumber,
              ota_update_id:      _deviceInfo.otaUpdateId,
              ota_channel:        _deviceInfo.otaChannel,
              // App lifecycle
              app_state:          AppState.currentState,
              // Per-stage pipeline ages
              http_ok_age_ms:     httpOkAge,
              http_att_age_ms:    pts.http_attempt       !== null ? now - pts.http_attempt       : null,
              motion_age_ms:      pts.motion             !== null ? now - pts.motion             : null,
              activity_age_ms:    pts.activity           !== null ? now - pts.activity           : null,
              location_age_ms:    pts.location           !== null ? now - pts.location           : null,
              hb_js_age_ms:       pts.heartbeat_js       !== null ? now - pts.heartbeat_js       : null,
              hl_inv_age_ms:      pts.headless_invoked   !== null ? now - pts.headless_invoked   : null,
              hl_hb_age_ms:       pts.headless_heartbeat !== null ? now - pts.headless_heartbeat : null,
              // SDK state
              sdk_enabled:        sdkSt?.enabled      ?? null,
              sdk_isMoving:       sdkSt?.isMoving     ?? null,
              sdk_trackingMode:   sdkSt?.trackingMode ?? null,
              listeners_attached: listenersAttached,
            });
          }
        } catch (_e) { /* never abort onHeartbeat for a diagnostic snapshot */ }
      })();
    });

    // ---- Activity Recognition (Build 64 — Motion Timeline audit) ----
    //
    // onActivityChange fires whenever Android Activity Recognition
    // detects a change in the device's physical activity:
    //   still | walking | on_foot | running | in_vehicle | on_bicycle
    //
    // This is the first link in the stationary→moving transition chain:
    //   Activity Recognition detects IN_VEHICLE
    //   → SDK evaluates confidence vs minimumActivityRecognitionConfidence
    //   → SDK fires onMotionChange(isMoving=true)
    //   → GPS active, distanceFilter applies, uploads begin
    //
    // Without this listener we had NO visibility into whether Android
    // Activity Recognition was firing at all on Joyce's device.
    // Deduplicated (see _lastActivity* vars above) to avoid flooding
    // the ring buffer — only transitions are logged.
    if (typeof lib.onActivityChange === 'function') {
      lib.onActivityChange((evt: any) => {
        const activity: string = String(evt?.activity ?? 'unknown');
        const confidence: number = typeof evt?.confidence === 'number' ? evt.confidence : 0;
        const isMoving: boolean = !!evt?.isMoving;
        if (activity !== _lastActivityType || isMoving !== _lastActivityIsMoving) {
          _lastActivityType = activity;
          _lastActivityIsMoving = isMoving;
          recordPipelineTs('activity');
          void logEvent('sdk_onActivityChange', { activity, confidence, isMoving });
        }
      });
    }

    listenersAttached = true;
    recordPipelineTs('listeners_attached');
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
    // Field-test build — reduced from 30 000 ms to 10 000 ms (the same value
    // as fastestLocationUpdateInterval) so Android's fused-location provider
    // delivers GPS fixes as quickly as the hardware allows when MOVING.
    // Previously the 30 s hint caused Android to batch fixes, producing
    // 3–5 min latency even though Joyce's device was uploading correctly.
    locationUpdateInterval: 10000,
    fastestLocationUpdateInterval: 10000,

    // Activity Recognition / motion detection
    activityRecognitionInterval: 10000,
    minimumActivityRecognitionConfidence: 75,
    // Sprint 1 motion recovery — eliminate Activity Recognition back-off.
    //
    // Transistor SDK default elasticity = 3: each heartbeat cycle without
    // detected movement multiplies the next AR poll interval by 3.
    // After Joyce's phone sits still for several hours the AR poll interval
    // can reach 270 s or more (10 s × 3^N).  When she finally starts
    // driving, Android may take minutes to deliver the first motionchange
    // event — which is exactly the stale-location symptom we are
    // investigating.
    //
    // elasticity: 1 disables the back-off entirely and keeps AR polling
    // at activityRecognitionInterval (10 s) regardless of how long the
    // phone has been stationary.  Battery cost is negligible: AR uses
    // the accelerometer / fused-sensor stack, not GPS.  Power-budget
    // impact is far smaller than one extra GPS fix per hour.
    //
    // Evidence: SDK docs + Transistor GitHub issue #1567 confirm that
    // high elasticity is the #1 cause of slow stationary-to-moving
    // transitions after long idle periods.  If drive-test logs show
    // motionchange firing quickly at elasticity:1, this was the root cause.
    elasticity: 1,

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
      // drawable/notification_icon is compiled into the APK by the
      // expo-notifications plugin from kinnship-notification-icon-shield.png
      // (192×192, pure white on transparent — satisfies Android 5.0+
      // monochrome-only requirement for status bar small icons).
      //
      // DO NOT use mipmap/ic_launcher here.  ic_launcher is a full-colour
      // adaptive icon.  Android OEMs that strictly enforce the monochrome
      // rule (Samsung One UI, Xiaomi MIUI, etc.) replace any coloured small
      // icon with a white square placeholder — which is exactly the symptom
      // reported on Joyce's device.  Charles's device is on a more permissive
      // firmware that renders coloured icons anyway, masking the bug.
      smallIcon: 'drawable/notification_icon',
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
    // No locationTemplate — the SDK's native payload is accepted directly.
    // The backend normalises both flat and nested shapes so old clients
    // and new clients can coexist during the OTA rollout window.
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

  // ----- Attach expo-battery listeners (idempotent) -----
  // Must be called after cachedConfig is set so pushBatteryUpdate() can
  // resolve the member ID and backend URL.  Also sends an initial reading
  // immediately so the caregiver sees up-to-date battery on first launch.
  attachBatteryListeners();
  void pushBatteryUpdate('startup');

  // ----- Snapshot pre-ready SDK state ─────────────────────────────
  // The key diagnostic for the blank-notification hypothesis: if
  // enabled=true here, the native foreground service was already
  // running (startOnBoot auto-restart) before our JS called ready().
  // That is the window where a blank notification could have been
  // shown using only the persisted config from the SDK's SQLite DB.
  try {
    const preState = await lib.getState();
    await logEvent('pre_ready_state', {
      enabled: !!preState?.enabled,
      trackingMode: preState?.trackingMode,
      isMoving: preState?.isMoving ?? null,
      schedulerEnabled: !!preState?.schedulerEnabled,
    });
  } catch (_e) {
    // getState() before ready() may throw on some SDK versions — log
    // the failure but do not abort the start sequence.
    await logEvent('pre_ready_state_error');
  }

  // ----- ready() / setConfig() ─────────────────────────────────────
  try {
    if (isReady) {
      await logEvent('setConfig_invoked');
      await lib.setConfig(config);
      await logEvent('setConfig_ok');
    } else {
      await logEvent('ready_invoked');
      const state = await lib.ready(config);
      isReady = true;
      await logEvent('ready_ok', {
        enabled: !!state?.enabled,
        trackingMode: state?.trackingMode,
        didLaunchInBackground: !!state?.didLaunchInBackground,
      });
      // Build 64 — Config snapshot.
      //
      // Log the SDK's ACTUAL resolved config immediately after ready().
      // The SDK merges the JS config with any values already persisted
      // in its native SQLite database.  If Charles and Joyce ever show
      // different values here, the persisted database is the explanation.
      // Charles's and Joyce's logs can then be compared side-by-side to
      // identify which field differs and why.
      try {
        await logEvent('sdk_config_snapshot', {
          distanceFilter:                    state?.distanceFilter,
          stationaryRadius:                  state?.stationaryRadius,
          stopTimeout:                       state?.stopTimeout,
          heartbeatInterval:                 state?.heartbeatInterval,
          activityRecognitionInterval:       state?.activityRecognitionInterval,
          minimumActivityRecognitionConfidence: state?.minimumActivityRecognitionConfidence,
          locationUpdateInterval:            state?.locationUpdateInterval,
          fastestLocationUpdateInterval:     state?.fastestLocationUpdateInterval,
          motionTriggerDelay:                state?.motionTriggerDelay ?? null,
          disableStopDetection:              state?.disableStopDetection ?? false,
          elasticityMultiplier:              state?.elasticityMultiplier ?? null,
          preventSuspend:                    state?.preventSuspend ?? false,
          pausesLocationUpdatesAutomatically: state?.pausesLocationUpdatesAutomatically ?? null,
          autoSync:                          state?.autoSync,
          batchSync:                         state?.batchSync,
          maxBatchSize:                      state?.maxBatchSize,
        });
      } catch (_e) {
        // Best-effort — never abort engine startup for a diagnostic log.
      }
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
 * Restart the engine using the most recently cached JS config.
 *
 * Leonidas v1.1 — completes the stop→start cycle that the v1.0 patrol
 * could only half-execute.  Previously, patrol.ts called
 * locationEngine.stop() but had no access to the cached config needed
 * to call locationEngine.start() again.  This function encapsulates
 * both steps so Leonidas can issue a true restart in one call.
 *
 * Not suitable from the HeadlessTask context — cachedConfig is always
 * null there (fresh JS context per invocation).  The HeadlessTask uses
 * lib.start() with no arguments instead, relying on the SDK's persisted
 * native config.
 *
 * Logs restart_skipped (no cached config), restart_completed (success),
 * or propagates the error from stop()/start() with its own log entries.
 */
export async function restart(): Promise<void> {
  await logEvent('restart_invoked');
  if (!cachedConfig) {
    await logEvent('restart_skipped', { reason: 'no_cached_config' });
    return;
  }
  // Capture before the async gap — stop() is async and cachedConfig
  // could theoretically be cleared by a concurrent sign-out, though
  // that is extremely unlikely.  Snapshot avoids the race.
  const cfg = cachedConfig;
  await stop();
  await start(cfg);
  await logEvent('restart_completed');
}

/**
 * Update the JWT used by the native HTTP transport.  Logged.
 */
/**
 * Decode the `exp` claim from a JWT for diagnostic purposes. Returns
 * null if the token isn't a well-formed JWT. Pure JS — no crypto,
 * no verification (we're inspecting, not authenticating).
 */
function _jwtExpMs(jwt: string): number | null {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    // Base64URL → base64 → decode
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    // atob is available in RN Hermes; fallback for older envs.
    // eslint-disable-next-line no-undef
    const decoded = typeof atob === 'function' ? atob(payload) : Buffer.from(payload, 'base64').toString('utf8');
    const claims = JSON.parse(decoded);
    return typeof claims?.exp === 'number' ? claims.exp * 1000 : null;
  } catch (_e) {
    return null;
  }
}

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
  // Build 53 — record the JWT's exp claim so post-mortem investigation
  // can prove whether the SDK is holding a fresh vs expired token when
  // an upload fails. Also gives us a lower-bound on "when will this
  // silently start 401ing" if the JS never refreshes it.
  const expMs = _jwtExpMs(jwt);
  const minutesUntilExpiry = expMs ? Math.round((expMs - Date.now()) / 60000) : null;
  try {
    await lib.setConfig({
      authorization: {
        strategy: 'JWT',
        accessToken: jwt,
      },
    });
    await logEvent('setAuthToken_ok', {
      jwt_exp_ms: expMs,
      minutes_until_expiry: minutesUntilExpiry,
      already_expired: expMs ? expMs < Date.now() : null,
    });
  } catch (e: any) {
    await logEvent('setAuthToken_error', {
      error: String(e?.message || e),
      jwt_exp_ms: expMs,
      minutes_until_expiry: minutesUntilExpiry,
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
//  Battery Optimization helpers — Android only.
//
//  Wrappers around BackgroundGeolocation.deviceSettings so
//  diagnostics.tsx does not need to import the SDK directly.
//
//  SDK contract (from installed DeviceSettings.d.ts):
//    isIgnoringBatteryOptimizations() → Promise<boolean>
//    showIgnoreBatteryOptimizations() → Promise<DeviceSettingsRequest>
//    showPowerManager()               → Promise<DeviceSettingsRequest>
//    show(request)                    → Promise<boolean>
//
//  showIgnoreBatteryOptimizations() and showPowerManager() do NOT
//  open Settings automatically — they return a DeviceSettingsRequest
//  with metadata (manufacturer, model, seen, lastSeenAt).  Call
//  deviceSettings.show(request) after obtaining user consent to open
//  the actual screen.
//
//  showPowerManager() throws on stock-Android / Pixel devices that
//  have no OEM power-manager screen.  This is documented behaviour;
//  always wrap in try/catch and treat the throw as "not available".
//
//  The SDK docs note: "In most cases the plugin will perform normally
//  with battery optimizations. Direct users to ignore optimizations
//  only as a last resort for background issues."
// ============================================================

export type DeviceSettingsRequest = {
  manufacturer: string;
  model: string;
  version: string;
  seen: boolean;
  lastSeenAt: Date;
  action: string;
};

/**
 * Returns true if Android is currently ignoring battery optimizations
 * for this app (i.e. the app is in the "Unrestricted" battery bucket).
 * Returns null on iOS / web or if the SDK is unavailable.
 */
export async function checkBatteryOptimization(): Promise<boolean | null> {
  if (Platform.OS !== 'android') return null;
  const lib = bgGeo();
  if (!lib) {
    void logEvent('battery_opt_check_failed', {
      fn: 'checkBatteryOptimization',
      reason: 'SDK_NOT_READY',
    });
    return null;
  }
  try {
    return await lib.deviceSettings.isIgnoringBatteryOptimizations();
  } catch (e: any) {
    void logEvent('battery_opt_check_failed', {
      fn: 'checkBatteryOptimization',
      reason: 'METHOD_THROW',
      error: String(e?.message || e),
    });
    return null;
  }
}

/**
 * Returns a DeviceSettingsRequest for the Android "Ignore Battery
 * Optimizations" settings screen.  Does NOT open the screen — call
 * showDeviceSettingsScreen(request) after user consent.
 * Returns null if the SDK or screen is unavailable.
 */
export async function requestShowIgnoreBatteryOptimizations(): Promise<DeviceSettingsRequest | null> {
  if (Platform.OS !== 'android') return null;
  const lib = bgGeo();
  if (!lib) {
    void logEvent('battery_opt_check_failed', {
      fn: 'requestShowIgnoreBatteryOptimizations',
      reason: 'SDK_NOT_READY',
    });
    return null;
  }
  try {
    return (await lib.deviceSettings.showIgnoreBatteryOptimizations()) as DeviceSettingsRequest;
  } catch (e: any) {
    void logEvent('battery_opt_check_failed', {
      fn: 'requestShowIgnoreBatteryOptimizations',
      reason: 'METHOD_THROW',
      error: String(e?.message || e),
    });
    return null;
  }
}

/**
 * Returns a DeviceSettingsRequest for the OEM vendor power manager
 * (Samsung "Device Care", Huawei "App Launch", etc.).
 * Returns null on stock Android / Pixel devices — the SDK throws when
 * no OEM screen exists, which is expected and not an error.
 */
export async function requestShowPowerManager(): Promise<DeviceSettingsRequest | null> {
  if (Platform.OS !== 'android') return null;
  const lib = bgGeo();
  if (!lib) {
    void logEvent('battery_opt_check_failed', {
      fn: 'requestShowPowerManager',
      reason: 'SDK_NOT_READY',
    });
    return null;
  }
  try {
    return (await lib.deviceSettings.showPowerManager()) as DeviceSettingsRequest;
  } catch (e: any) {
    // Throwing here is expected on stock-Android / Pixel devices that have no
    // OEM power-manager screen.  Log it so we can distinguish "not available on
    // this device" (normal) from an unexpected SDK error (worth investigating).
    void logEvent('battery_opt_power_manager_not_available', {
      fn: 'requestShowPowerManager',
      reason: 'METHOD_THROW',
      error: String(e?.message || e),
    });
    return null;
  }
}

/**
 * Opens the settings screen described by a DeviceSettingsRequest.
 * Only call this after the user has confirmed an explanation dialog.
 */
export async function showDeviceSettingsScreen(request: DeviceSettingsRequest): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  const lib = bgGeo();
  if (!lib) return false;
  try {
    return await lib.deviceSettings.show(request);
  } catch (_e) {
    return false;
  }
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
