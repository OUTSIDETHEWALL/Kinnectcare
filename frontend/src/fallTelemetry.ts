/**
 * Fall Detection telemetry (v1.3.3).
 *
 * Why this module exists:
 *   The user threw two phones onto a couch and dropped one from head
 *   height onto a pillow.  The Fall Detection 2.0 state machine
 *   produced ZERO countdowns.  We need to know whether:
 *
 *     (A) The detector isn't running at all (no sensor subscription
 *         active because app was backgrounded — most likely).
 *     (B) Sensors are firing but the impact threshold was never met
 *         (couch toss < 1.5 g).
 *     (C) Impact was met but orientation Δ never crossed 40°.
 *     (D) Impact + orientation passed but stillness never converged.
 *
 *   We need persistent visibility BEFORE tuning anything.  The user
 *   asked: "I want proof the Fall Detection 2.0 state machine is
 *   actually running."  Persistent telemetry is that proof.
 *
 * Storage strategy:
 *   Three ring buffers — phase transitions (50 deep), sensor magnitude
 *   samples (100 deep), and lifecycle events (50 deep, includes
 *   subscription start/stop, AppState changes, simulate-fall calls).
 *
 *   All persisted to AsyncStorage so the user can throw the phone,
 *   then navigate to Diagnostics and inspect what was actually
 *   recorded.  Without persistence the test page loses everything
 *   the moment the user navigates away.
 *
 *   We also expose a synchronous subscribe-to-live-state hook so
 *   the Diagnostics screen can show CURRENT phase / availability
 *   without waiting for the next AsyncStorage roundtrip.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY_PHASES = '@kinnship/fall_phase_log_v1';
const KEY_SAMPLES = '@kinnship/fall_sample_log_v1';
const KEY_EVENTS = '@kinnship/fall_event_log_v1';
const MAX_PHASES = 50;
const MAX_SAMPLES = 100;
const MAX_EVENTS = 50;

export type FallPhaseEntry = {
  at: number;
  phase: string;             // 'idle' | 'impact-detected' | ...
  mag: number;
  orientationDeltaDeg: number | null;
  stillnessFractionPct: number | null;
};

export type FallSampleEntry = {
  at: number;
  mag: number;
  x: number;
  y: number;
  z: number;
};

export type FallEventEntry = {
  at: number;
  kind:
    | 'subscribe-start'      // useFallDetector effect mounted
    | 'subscribe-stop'       // useFallDetector effect unmounted
    | 'accel-available'      // Accelerometer.isAvailableAsync resolved true
    | 'accel-unavailable'
    | 'gyro-available'
    | 'gyro-unavailable'
    | 'appstate-change'      // foreground/background flip
    | 'simulate-fall'        // test-harness simulate button
    | 'confirmed'            // phase 4 fired — overlay would launch
    | 'capture-armed'        // user tapped Arm 30 s capture
    | 'capture-complete';    // capture window ended
  detail?: string;
};

// ---------- Live-state subscription (memory-only) ----------
//
// Diagnostics screen and FallDetectionOverlay both want to know the
// detector's CURRENT phase + availability + sample count without
// pulling from AsyncStorage every tick.  Single shared module-level
// snapshot, fanned out to subscribers.

type LiveState = {
  enabled: boolean | null;
  available: boolean | null;
  gyroAvailable: boolean | null;
  phase: string;
  appState: string;
  sampleCount: number;
  lastMag: number;
  subscribedAt: number | null;
  unsubscribedAt: number | null;
  // v1.3.3 — peak magnitude observed within the last 5 sec, so the
  // diagnostics screen can show "biggest thump you felt while throwing
  // this phone" without scrolling through 100 samples.
  peakMag5s: number;
};

const liveState: LiveState = {
  enabled: null,
  available: null,
  gyroAvailable: null,
  phase: 'idle',
  appState: 'unknown',
  sampleCount: 0,
  lastMag: 0,
  subscribedAt: null,
  unsubscribedAt: null,
  peakMag5s: 0,
};

const liveSubscribers: Set<(s: LiveState) => void> = new Set();

export function subscribeLiveState(cb: (s: LiveState) => void): () => void {
  liveSubscribers.add(cb);
  try { cb({ ...liveState }); } catch (_e) {}
  return () => { liveSubscribers.delete(cb); };
}

function notifyLive(): void {
  const snapshot = { ...liveState };
  for (const cb of liveSubscribers) {
    try { cb(snapshot); } catch (_e) {}
  }
}

export function setLiveAvailability(v: { accel: boolean | null; gyro: boolean | null }): void {
  liveState.available = v.accel;
  liveState.gyroAvailable = v.gyro;
  notifyLive();
}

export function setLiveEnabled(v: boolean): void {
  liveState.enabled = v;
  notifyLive();
}

export function setLivePhase(phase: string): void {
  liveState.phase = phase;
  notifyLive();
}

export function setLiveAppState(s: string): void {
  liveState.appState = s;
  notifyLive();
}

export function markSubscribeStart(): void {
  liveState.subscribedAt = Date.now();
  liveState.unsubscribedAt = null;
  liveState.sampleCount = 0;
  liveState.peakMag5s = 0;
  notifyLive();
}

export function markSubscribeStop(): void {
  liveState.unsubscribedAt = Date.now();
  notifyLive();
}

export function bumpSample(mag: number): void {
  liveState.sampleCount += 1;
  liveState.lastMag = mag;
  if (mag > liveState.peakMag5s) liveState.peakMag5s = mag;
  // Decay the peak every ~5 s — we don't need a sliding-window queue
  // for diagnostics, a coarse decay is enough.
  const now = Date.now();
  if (!(globalThis as any).__kc_peak_at || now - (globalThis as any).__kc_peak_at > 5000) {
    (globalThis as any).__kc_peak_at = now;
    liveState.peakMag5s = mag;
  }
  // Don't notifyLive() on every sample — too chatty.  Diagnostics
  // re-polls live state on a 500 ms timer.
}

export function readLiveStateSync(): LiveState {
  return { ...liveState };
}

// ---------- Persistent ring buffers ----------

async function appendRing<T>(key: string, entry: T, max: number): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(key);
    const arr: T[] = raw ? JSON.parse(raw) : [];
    arr.unshift(entry);
    if (arr.length > max) arr.length = max;
    await AsyncStorage.setItem(key, JSON.stringify(arr));
  } catch (_e) { /* swallow */ }
}

async function readRing<T>(key: string): Promise<T[]> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function logPhase(entry: FallPhaseEntry): void {
  appendRing(KEY_PHASES, entry, MAX_PHASES);
}

export function logSample(entry: FallSampleEntry): void {
  appendRing(KEY_SAMPLES, entry, MAX_SAMPLES);
}

export function logEvent(entry: FallEventEntry): void {
  appendRing(KEY_EVENTS, entry, MAX_EVENTS);
}

export function getPhases(): Promise<FallPhaseEntry[]> { return readRing(KEY_PHASES); }
export function getSamples(): Promise<FallSampleEntry[]> { return readRing(KEY_SAMPLES); }
export function getEvents(): Promise<FallEventEntry[]> { return readRing(KEY_EVENTS); }

export async function clearAllFallLogs(): Promise<void> {
  try {
    await AsyncStorage.multiRemove([KEY_PHASES, KEY_SAMPLES, KEY_EVENTS]);
  } catch (_e) {}
}

// ---------- Capture mode ----------
//
// User taps "Arm 30 s capture" in Diagnostics → we set a flag that
// fallDetector reads to log EVERY sample (instead of the default
// down-sampling) so we get a high-resolution time series for the
// throw event.  Auto-disarms after 30 s.

let _captureUntil = 0;
export function armSampleCapture(durationMs = 30_000): void {
  _captureUntil = Date.now() + durationMs;
  logEvent({ at: Date.now(), kind: 'capture-armed', detail: `${durationMs}ms` });
  // Schedule the disarm event for telemetry symmetry.
  setTimeout(() => {
    logEvent({ at: Date.now(), kind: 'capture-complete' });
  }, durationMs);
}
export function isCaptureActive(): boolean {
  return Date.now() < _captureUntil;
}
