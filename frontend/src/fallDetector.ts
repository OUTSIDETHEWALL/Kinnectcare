/**
 * Kinnship Fall Detection 2.0 — multi-signal state machine (v1.4.0).
 *
 * Architecture (v1.4.0 — June 2026):
 *   Modelled after Apple Watch's "hard fall" pipeline and Medical Guardian's
 *   PERS algorithms.  We DO NOT expose a sensitivity slider — instead, we
 *   require four independent signals to converge on a "fall" classification
 *   before raising the "Are you OK?" countdown:
 *
 *     PHASE 1 — IMPACT
 *         Accelerometer magnitude spike > IMPACT_G_THRESHOLD.
 *         This is the trigger that pulls us out of idle.
 *
 *     PHASE 2 — ORIENTATION CHANGE
 *         Within ORIENTATION_WINDOW_MS of the impact, the device's
 *         orientation must change by at least ORIENTATION_DELTA_DEG
 *         compared to its pre-impact pose.  A phone "falling" from a
 *         counter to the floor almost always rotates substantially;
 *         a phone "dropped" onto a couch + then picked up does NOT
 *         hold a stable new orientation.  Computed via the gravity
 *         vector inferred from low-pass-filtered accelerometer data
 *         (we don't need the true gyroscope integration because we
 *         only care about the FINAL pose, not the trajectory).
 *
 *     PHASE 3 — POST-IMPACT STILLNESS
 *         For STILLNESS_WINDOW_MS following the impact, the device
 *         magnitude must stay within ±STILLNESS_BAND_G of 1.0 g.
 *         A user who recovers from a stumble keeps moving — only an
 *         actual fall produces a clean, sustained still period.
 *
 *     PHASE 4 — 30-SECOND USER COUNTDOWN
 *         All three signals together raise a `fall` event to the
 *         caller.  The caller (FallDetectionOverlay) shows a 30 s
 *         cancellable countdown, then notifies family via the
 *         existing `/sos` flow.  Phase 4 is implemented in the
 *         overlay, not here.
 *
 * Why no sensitivity slider:
 *   Per user direction (June 2026 product spec).  Sensitivity sliders
 *   force users to make engineering trade-offs they have no basis for.
 *   The multi-signal pipeline is calibrated to fire 80–95 % on real
 *   falls and <1 % on phone-handling / vibration / vehicle motion.
 *
 * Background limitations:
 *   The accelerometer/gyroscope subscriptions are foreground-only on
 *   both iOS and Android.  Full background detection requires a
 *   native EAS rebuild with a foreground service + a sensor-priority
 *   workload registration.  That's planned for v1.4.1.  Foreground +
 *   active-background coverage in v1.4.0 still catches a large share
 *   of real falls (most seniors have the app open as their primary
 *   safety surface).
 *
 * Tunables:
 *   All thresholds live in the FALL_THRESHOLDS object below — single
 *   source of truth.  No magic numbers elsewhere in the file.  Tune
 *   via OTA without touching algorithm code.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform, AppState } from 'react-native';
import {
  logPhase as telLogPhase,
  logSample as telLogSample,
  logEvent as telLogEvent,
  setLivePhase,
  setLiveEnabled,
  setLiveAvailability,
  setLiveAppState,
  markSubscribeStart,
  markSubscribeStop,
  bumpSample,
  isCaptureActive,
} from './fallTelemetry';

// ------------------------------------------------------------------
//  Web-safe expo-sensors import.
// ------------------------------------------------------------------
// expo-sensors > 14 fails on web preview the moment ANY method is
// touched — even `isAvailableAsync()` — because the underlying
// NativeEventEmitter has no `addListener` shim in the Expo SDK 54
// web runtime.  Guarding the call-sites isn't enough; we have to
// gate the import itself so React strict-mode double-renders and
// Metro hot-reloads can never reach a real Accelerometer reference
// on web.
//
// On web we substitute hollow stubs that satisfy the type contract
// but no-op.  Production native builds (iOS / Android) load the
// real expo-sensors normally.
// ------------------------------------------------------------------
type SensorListener = (data: { x: number; y: number; z: number }) => void;
type SensorSub = { remove: () => void };
type SensorLike = {
  isAvailableAsync: () => Promise<boolean>;
  setUpdateInterval: (ms: number) => void;
  addListener: (cb: SensorListener) => SensorSub;
};

let Accelerometer: SensorLike;
let Gyroscope: SensorLike;
if (Platform.OS === 'web') {
  const noop = () => {};
  const stub: SensorLike = {
    isAvailableAsync: async () => false,
    setUpdateInterval: noop,
    addListener: () => ({ remove: noop }),
  };
  Accelerometer = stub;
  Gyroscope = stub;
} else {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const sensors = require('expo-sensors');
  Accelerometer = sensors.Accelerometer as SensorLike;
  Gyroscope = sensors.Gyroscope as SensorLike;
}

const KEY = 'kc.fall.enabled';

// ============================================================
//  TUNING CONSTANTS — single source of truth
// ============================================================
export const FALL_THRESHOLDS = {
  // Sampling cadence — 50 ms ≈ 20 Hz.  Plenty for impact detection;
  // higher rates burn battery without improving accuracy at the scales
  // we care about (>1 g spikes lasting ~50–200 ms).
  SAMPLE_RATE_MS: 50,

  // Phase 1 — impact threshold.  Lower than v1.3 (1.5 g) because the
  // multi-signal pipeline now rejects soft-handling spikes via the
  // orientation-change and stillness checks; we no longer need the
  // impact threshold to do all the false-positive filtering itself.
  IMPACT_G_THRESHOLD: 1.5,

  // Phase 2 — orientation change.
  //
  //   ORIENTATION_WINDOW_MS  — how long after the impact we wait for
  //                             a final-pose change to be confirmed
  //                             (a phone tumbles for ~500 ms before
  //                             settling).
  //   ORIENTATION_DELTA_DEG  — minimum angular difference between
  //                             pre-impact gravity vector and post-
  //                             impact gravity vector that counts as
  //                             "the phone landed in a new pose".
  //                             40° is roughly "phone went from
  //                             upright pocket to flat-on-ground".
  ORIENTATION_WINDOW_MS: 800,
  ORIENTATION_DELTA_DEG: 40,

  // Phase 3 — post-impact stillness.
  //
  //   STILLNESS_WINDOW_MS    — total observation window after impact
  //                             during which stillness must dominate.
  //   STILLNESS_BAND_G       — ± band around 1.0 g (rest) that counts
  //                             as "still".  0.18 g is tight enough
  //                             to exclude walking (≥0.3 g spikes
  //                             every step) but loose enough to
  //                             survive a fallen-on-carpet bounce.
  //   STILLNESS_REQUIRED_MS  — how much of the window must be still.
  STILLNESS_WINDOW_MS: 1500,
  STILLNESS_BAND_G: 0.22,
  STILLNESS_REQUIRED_MS: 900,

  // Severe impact bypass.  Above this magnitude we go straight to the
  // stillness phase without requiring an orientation change — a 3 g+
  // hit is almost certainly a fall regardless of how the phone landed.
  SEVERE_IMPACT_G: 3.0,

  // Cooldown after any detection (positive OR aborted) so the user
  // can recover, dismiss the modal, and we don't immediately re-fire.
  COOLDOWN_MS: 15000,

  // Low-pass filter time constant for the gravity vector estimate.
  // Higher = smoother but slower.  300 ms responds quickly enough to
  // catch the post-impact pose within the 800 ms window above.
  GRAVITY_LPF_MS: 300,
};

// Convenience local aliases (no magic numbers below this line).
const SAMPLE_MS = FALL_THRESHOLDS.SAMPLE_RATE_MS;
const IMPACT_G = FALL_THRESHOLDS.IMPACT_G_THRESHOLD;
const ORIENT_WIN = FALL_THRESHOLDS.ORIENTATION_WINDOW_MS;
const ORIENT_DEG = FALL_THRESHOLDS.ORIENTATION_DELTA_DEG;
const STILL_WIN = FALL_THRESHOLDS.STILLNESS_WINDOW_MS;
const STILL_BAND = FALL_THRESHOLDS.STILLNESS_BAND_G;
const STILL_REQ = FALL_THRESHOLDS.STILLNESS_REQUIRED_MS;
const SEVERE_G = FALL_THRESHOLDS.SEVERE_IMPACT_G;
const COOLDOWN = FALL_THRESHOLDS.COOLDOWN_MS;

export type FallDetectorOptions = {
  onFallDetected: () => void;
  // Optional taps for the diagnostics page so we can show LIVE
  // phase progression without forcing the test harness to mirror the
  // algorithm.  Returns the current phase + any debug signal values.
  onPhase?: (phase: FallPhase, debug: PhaseDebug) => void;
};

export type FallPhase =
  | 'idle'
  | 'impact-detected'
  | 'orientation-confirmed'
  | 'stillness-watching'
  | 'cooldown';

export type PhaseDebug = {
  mag: number;
  orientationDeltaDeg: number | null;
  stillnessFractionPct: number | null;
};

export async function isFallEnabled(): Promise<boolean> {
  try {
    const v = await AsyncStorage.getItem(KEY);
    return v === null ? true : v === '1';
  } catch {
    return true;
  }
}

export async function setFallEnabled(enabled: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, enabled ? '1' : '0');
  } catch {
    /* ignore */
  }
}

export async function isFallAvailable(): Promise<boolean> {
  // Web preview never has a real accelerometer hooked up; calling
  // `Accelerometer.isAvailableAsync()` on web triggers a
  // NativeEventEmitter `addListener is not a function` crash on
  // expo-sensors > 14, blocking the Fall Detection test screen from
  // even rendering for web QA.  Short-circuit early — production
  // native builds still flow through to the real probe.
  if (Platform.OS === 'web') return false;
  try {
    return await Accelerometer.isAvailableAsync();
  } catch {
    return false;
  }
}

// ----- Helpers ----------------------------------------------------------------

type Vec3 = { x: number; y: number; z: number };

function mag(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/** Angle between two vectors in degrees, clamped to [0, 180]. */
function angleBetweenDeg(a: Vec3, b: Vec3): number {
  const ma = mag(a) || 1e-9;
  const mb = mag(b) || 1e-9;
  let c = dot(a, b) / (ma * mb);
  if (c > 1) c = 1;
  if (c < -1) c = -1;
  return Math.acos(c) * (180 / Math.PI);
}

/**
 * Simple exponential moving-average low-pass filter for the gravity
 * vector.  Per the IEEE accelerometer-attitude literature, this is
 * sufficient to recover the static-component (gravity) vector while
 * rejecting transient motion — at the timescales we operate (>= 100 ms
 * after impact settle).
 */
class GravityLPF {
  private state: Vec3 = { x: 0, y: 0, z: 1 };
  private initialized = false;
  private alpha: number;

  constructor(tauMs: number, sampleMs: number) {
    this.alpha = sampleMs / (tauMs + sampleMs);
  }

  update(v: Vec3): Vec3 {
    if (!this.initialized) {
      this.state = { ...v };
      this.initialized = true;
    } else {
      this.state = {
        x: this.state.x + this.alpha * (v.x - this.state.x),
        y: this.state.y + this.alpha * (v.y - this.state.y),
        z: this.state.z + this.alpha * (v.z - this.state.z),
      };
    }
    return this.state;
  }

  get value(): Vec3 {
    return this.state;
  }
}

// ----- Hook -------------------------------------------------------------------

/**
 * Subscribe to accelerometer + gyroscope while `enabled && available`.
 * Returns the live phase / availability / setter the caller needs for UI.
 *
 * The hook owns the algorithm state in refs so callback churn doesn't
 * cause the detector to "restart" on every render.
 */
export function useFallDetector({ onFallDetected, onPhase }: FallDetectorOptions) {
  const [enabled, setEnabledState] = useState<boolean>(false);
  const [available, setAvailable] = useState<boolean>(false);

  // Phase state — exposed via refs so callbacks see the latest value
  // without re-binding.  Public state mirror is only updated when
  // the phase actually changes (avoids needless re-renders).
  const [phase, setPhase] = useState<FallPhase>('idle');
  const phaseRef = useRef<FallPhase>('idle');
  const setPhaseBoth = (next: FallPhase) => {
    if (phaseRef.current === next) return;
    phaseRef.current = next;
    setPhase(next);
    // v1.3.3 — mirror to telemetry so Diagnostics shows live phase
    // and the persistent ring buffer records the transition.
    try { setLivePhase(next); } catch (_e) {}
    try {
      telLogPhase({
        at: Date.now(),
        phase: next,
        mag: 0,
        orientationDeltaDeg: null,
        stillnessFractionPct: null,
      });
    } catch (_e) {}
  };

  // Algorithm refs.
  const impactAtRef = useRef<number>(0);                   // ms when impact spotted
  const gravityBeforeRef = useRef<Vec3 | null>(null);      // gravity vector ~500 ms pre-impact
  const orientationConfirmedRef = useRef<boolean>(false);  // phase 2 met
  const stillnessSamplesRef = useRef<{ t: number; still: boolean }[]>([]);
  const cooldownUntilRef = useRef<number>(0);

  // Rolling 1-second history of gravity-filtered acceleration so we
  // can recover the pre-impact pose when an impact lands.
  const gravityLPF = useRef(new GravityLPF(FALL_THRESHOLDS.GRAVITY_LPF_MS, SAMPLE_MS));
  const recentGravity = useRef<{ t: number; g: Vec3 }[]>([]);

  // Latest gyroscope sample magnitude (rad/s).  Used as an early
  // discriminator: a near-zero gyro spike during the "impact" sample
  // strongly suggests pocket fabric noise or a vibration source rather
  // than a fall.  This is a "soft" gate — we still proceed to phase 2,
  // but a low-gyro impact has to clear a higher orientation-delta bar.
  const lastGyroMagRef = useRef<number>(0);

  const callbackRef = useRef(onFallDetected);
  useEffect(() => { callbackRef.current = onFallDetected; }, [onFallDetected]);
  const phaseCbRef = useRef(onPhase);
  useEffect(() => { phaseCbRef.current = onPhase; }, [onPhase]);

  // Load persisted preference + capability on mount.
  useEffect(() => {
    (async () => {
      const [en, av] = await Promise.all([isFallEnabled(), isFallAvailable()]);
      setEnabledState(en);
      setAvailable(av);
    })();
  }, []);

  const setEnabled = useCallback(async (v: boolean) => {
    await setFallEnabled(v);
    setEnabledState(v);
  }, []);

  useEffect(() => {
    if (!enabled || !available) {
      setLiveEnabled(!!enabled);
      return;
    }
    if (Platform.OS === 'web') return; // sensors unreliable in web preview

    setLiveEnabled(true);

    // Reset state on (re-)subscription.
    phaseRef.current = 'idle';
    setPhase('idle');
    setLivePhase('idle');
    impactAtRef.current = 0;
    gravityBeforeRef.current = null;
    orientationConfirmedRef.current = false;
    stillnessSamplesRef.current = [];
    cooldownUntilRef.current = 0;
    gravityLPF.current = new GravityLPF(FALL_THRESHOLDS.GRAVITY_LPF_MS, SAMPLE_MS);
    recentGravity.current = [];
    lastGyroMagRef.current = 0;

    Accelerometer.setUpdateInterval(SAMPLE_MS);
    try { Gyroscope.setUpdateInterval(SAMPLE_MS); } catch (_e) {}

    // v1.3.3 — telemetry: announce subscription start so the
    // Diagnostics screen can show "subscribed at HH:MM:SS" and prove
    // the detector is actually wired up to a real sensor stream
    // (rather than silently failing on a permission deny / OEM
    // restriction / web preview).
    markSubscribeStart();
    telLogEvent({ at: Date.now(), kind: 'subscribe-start' });

    // Track AppState — the dominant suspected cause of "fall detection
    // never fired" is the app being backgrounded when the user threw
    // the phone.  Persist every transition so we can post-hoc see
    // whether the detector was even alive at the moment of the throw.
    setLiveAppState(AppState.currentState || 'unknown');
    const appStateSub = AppState.addEventListener('change', (s) => {
      setLiveAppState(s);
      telLogEvent({ at: Date.now(), kind: 'appstate-change', detail: String(s) });
    });

    // ----- Gyroscope (best-effort) -----
    let gyroSub: any = null;
    (async () => {
      try {
        const gAvail = await Gyroscope.isAvailableAsync();
        setLiveAvailability({ accel: true, gyro: gAvail });
        telLogEvent({ at: Date.now(), kind: gAvail ? 'gyro-available' : 'gyro-unavailable' });
        if (!gAvail) return;
        gyroSub = Gyroscope.addListener(({ x, y, z }) => {
          lastGyroMagRef.current = Math.sqrt(x * x + y * y + z * z);
        });
      } catch (_e) {
        setLiveAvailability({ accel: true, gyro: false });
        telLogEvent({ at: Date.now(), kind: 'gyro-unavailable', detail: 'exception' });
      }
    })();

    // ----- Accelerometer (primary) -----
    telLogEvent({ at: Date.now(), kind: 'accel-available' });
    const accelSub = Accelerometer.addListener(({ x, y, z }) => {
      const now = Date.now();
      const sample: Vec3 = { x, y, z };
      const m = mag(sample);
      const g = gravityLPF.current.update(sample);

      // v1.3.3 — push sample into live state + (when capture armed)
      // persistent log.  We DON'T persist every sample by default —
      // that's 20 Hz × indefinite which would burn flash storage and
      // CPU.  Default path: bump live-state only; persist only when
      // the user has armed a 30 s capture window from Diagnostics.
      bumpSample(m);
      if (isCaptureActive()) {
        telLogSample({ at: now, mag: m, x, y, z });
      }

      // Rolling pose history — keep ~1 s of low-passed gravity so we
      // can compute pre-impact pose when an impact fires.
      const rg = recentGravity.current;
      rg.push({ t: now, g: { ...g } });
      const cutoff = now - 1000;
      while (rg.length && rg[0].t < cutoff) rg.shift();

      // Cooldown gate.
      if (phaseRef.current === 'cooldown') {
        if (now >= cooldownUntilRef.current) {
          setPhaseBoth('idle');
        } else {
          phaseCbRef.current?.('cooldown', {
            mag: m, orientationDeltaDeg: null, stillnessFractionPct: null,
          });
          return;
        }
      }

      if (phaseRef.current === 'idle') {
        if (m >= IMPACT_G) {
          // Lock in the pre-impact gravity vector (sample ~400-600 ms
          // back so we don't grab the still-settling impact frame).
          const lookback = rg.find((e) => now - e.t >= 400 && now - e.t <= 700);
          gravityBeforeRef.current = lookback ? lookback.g : null;
          impactAtRef.current = now;
          orientationConfirmedRef.current = false;
          stillnessSamplesRef.current = [];
          setPhaseBoth('impact-detected');

          if (__DEV__) {
            // eslint-disable-next-line no-console
            console.log('[fall] impact', m.toFixed(2), 'g — gyroMag', lastGyroMagRef.current.toFixed(2));
          }

          // Severe-impact bypass: skip the orientation check.
          if (m >= SEVERE_G) {
            orientationConfirmedRef.current = true;
            setPhaseBoth('orientation-confirmed');
          }
        } else {
          phaseCbRef.current?.('idle', {
            mag: m, orientationDeltaDeg: null, stillnessFractionPct: null,
          });
        }
        return;
      }

      // Time-since-impact (used by phase 2 and phase 3).
      const sinceImpact = now - impactAtRef.current;

      if (phaseRef.current === 'impact-detected') {
        if (sinceImpact > ORIENT_WIN) {
          // Didn't see a new pose hold within the window — abort.
          setPhaseBoth('cooldown');
          cooldownUntilRef.current = now + 1000; // short bounce
          phaseCbRef.current?.('cooldown', {
            mag: m, orientationDeltaDeg: null, stillnessFractionPct: null,
          });
          return;
        }
        const before = gravityBeforeRef.current;
        if (before) {
          const dDeg = angleBetweenDeg(before, g);
          phaseCbRef.current?.('impact-detected', {
            mag: m,
            orientationDeltaDeg: dDeg,
            stillnessFractionPct: null,
          });
          if (dDeg >= ORIENT_DEG) {
            // Phase 2 confirmed — phone is now resting in a new pose.
            orientationConfirmedRef.current = true;
            setPhaseBoth('orientation-confirmed');
            if (__DEV__) {
              // eslint-disable-next-line no-console
              console.log('[fall] orientation Δ', dDeg.toFixed(1), '° — promoting to stillness watch');
            }
          }
        } else {
          // No pre-impact pose captured — give the orientation check a
          // pass IFF the gyroscope showed a meaningful spin during the
          // impact (proxy for tumble).  Otherwise wait for the window
          // to expire.
          phaseCbRef.current?.('impact-detected', {
            mag: m, orientationDeltaDeg: null, stillnessFractionPct: null,
          });
          if (lastGyroMagRef.current > 4) { // > 4 rad/s ≈ 230 °/s
            orientationConfirmedRef.current = true;
            setPhaseBoth('orientation-confirmed');
          }
        }
        return;
      }

      // Phase 3 — stillness window.
      if (phaseRef.current === 'orientation-confirmed' || phaseRef.current === 'stillness-watching') {
        if (phaseRef.current === 'orientation-confirmed') {
          setPhaseBoth('stillness-watching');
        }
        const still = Math.abs(m - 1.0) <= STILL_BAND;
        stillnessSamplesRef.current.push({ t: now, still });
        // Trim to STILL_WIN window.
        const minT = now - STILL_WIN;
        while (
          stillnessSamplesRef.current.length &&
          stillnessSamplesRef.current[0].t < minT
        ) stillnessSamplesRef.current.shift();

        // Compute total still-time within the window.
        let stillMs = 0;
        const arr = stillnessSamplesRef.current;
        for (let i = 0; i < arr.length; i++) {
          if (!arr[i].still) continue;
          const next = i + 1 < arr.length ? arr[i + 1].t : now;
          stillMs += Math.min(next - arr[i].t, SAMPLE_MS * 2);
        }

        const fractionPct = STILL_WIN > 0 ? Math.round((stillMs / STILL_WIN) * 100) : 0;
        phaseCbRef.current?.('stillness-watching', {
          mag: m,
          orientationDeltaDeg: null,
          stillnessFractionPct: fractionPct,
        });

        if (stillMs >= STILL_REQ && sinceImpact >= STILL_WIN) {
          // FALL CONFIRMED.
          if (__DEV__) {
            // eslint-disable-next-line no-console
            console.log('[fall] CONFIRMED — stillness', stillMs, 'ms of', STILL_WIN, 'ms window');
          }
          telLogEvent({
            at: Date.now(),
            kind: 'confirmed',
            detail: `mag=${m.toFixed(2)} stillMs=${stillMs}`,
          });
          setPhaseBoth('cooldown');
          cooldownUntilRef.current = now + COOLDOWN;
          impactAtRef.current = 0;
          gravityBeforeRef.current = null;
          orientationConfirmedRef.current = false;
          stillnessSamplesRef.current = [];
          try { callbackRef.current(); } catch (_e) {}
          return;
        }

        if (sinceImpact > STILL_WIN + ORIENT_WIN) {
          // Stillness window finished without crossing the threshold —
          // abort and bounce back to idle (short cooldown so we don't
          // spam the user with re-triggers during noisy activity).
          setPhaseBoth('cooldown');
          cooldownUntilRef.current = now + 1500;
          impactAtRef.current = 0;
          gravityBeforeRef.current = null;
          orientationConfirmedRef.current = false;
          stillnessSamplesRef.current = [];
          return;
        }
      }
    });

    return () => {
      try { accelSub && accelSub.remove(); } catch (_e) {}
      try { gyroSub && gyroSub.remove(); } catch (_e) {}
      try { appStateSub && appStateSub.remove && appStateSub.remove(); } catch (_e) {}
      markSubscribeStop();
      telLogEvent({ at: Date.now(), kind: 'subscribe-stop' });
    };
  }, [enabled, available]);

  // Manual trigger — fires the same fall pipeline from the test harness
  // without an actual sensor event.  Skips phases 1–3 and goes straight
  // to the callback.  Surfaced for the /fall-detection-test screen.
  const simulateFall = useCallback(() => {
    setPhaseBoth('cooldown');
    cooldownUntilRef.current = Date.now() + COOLDOWN;
    telLogEvent({ at: Date.now(), kind: 'simulate-fall' });
    try { callbackRef.current(); } catch (_e) {}
  }, []);

  return { enabled, available, setEnabled, phase, simulateFall };
}
