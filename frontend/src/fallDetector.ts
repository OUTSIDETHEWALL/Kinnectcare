/**
 * Kinnship fall detection.
 *
 * Algorithm (lightweight, runs on the device's accelerometer at 50 Hz):
 *   1) Wait for an IMPACT — a magnitude spike > 2.5 g.
 *   2) After the spike, watch for STILLNESS — magnitude stays in 1.0 ± 0.18 g
 *      for ~1.2 s. The combination of "big spike then unusually still" is a
 *      strong fall signature (the device hits the ground and stops).
 *   3) If both pass, raise a "fall" event (the UI then shows a 30-second
 *      cancel-or-SOS countdown).
 *
 * Tunable thresholds live at the top of the file.
 *
 * Notes:
 *  - We use expo-sensors `Accelerometer`. No runtime permission is required
 *    on iOS for the user accelerometer (Apple treats it as low-sensitivity
 *    motion data).
 *  - On web preview, `Accelerometer.isAvailableAsync()` returns false on most
 *    desktop browsers; we silently noop in that case.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { Accelerometer } from 'expo-sensors';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

const KEY = 'kc.fall.enabled';
// v6.6 retuning — Charles reported "throwing phone at couch" no longer
// triggered. Lowered impact threshold 2.6g → 2.2g to catch couch-impact
// falls (which produce lower peak G than hard-floor falls).  The
// freefall PRE-CHECK is what kills false positives now — we still
// require ~120ms of sub-0.6g BEFORE the impact spike, which no everyday
// phone handling motion produces. Net effect: catches more real falls
// without re-introducing the v6.4 over-sensitivity.
const SAMPLE_RATE_MS = 50;             // ~20 Hz
const FREEFALL_G = 0.6;                // require sub-0.6g for freefall
const FREEFALL_REQUIRED_MS = 120;      // ~120ms of freefall = ~7cm minimum drop
const FREEFALL_LOOKBACK_MS = 600;      // look back this far for the freefall
const IMPACT_G = 2.2;                  // lowered 2.6 → 2.2 (couch-impact falls)
const STILLNESS_BAND_G = 0.25;         // slightly tighter
const STILLNESS_REQUIRED_MS = 1200;    // longer stillness — falls settle for >1s
const POST_IMPACT_WINDOW_MS = 3500;
const COOLDOWN_MS = 12000;             // longer cooldown so the user has time to react

export type FallDetectorOptions = {
  onFallDetected: () => void;
};

type State = 'idle' | 'impact-wait-stillness' | 'cooldown';

export async function isFallEnabled(): Promise<boolean> {
  try {
    const v = await AsyncStorage.getItem(KEY);
    // default: enabled (user must opt out)
    return v === null ? true : v === '1';
  } catch {
    return true;
  }
}

export async function setFallEnabled(enabled: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, enabled ? '1' : '0');
  } catch {
    // ignore
  }
}

export async function isFallAvailable(): Promise<boolean> {
  try {
    return await Accelerometer.isAvailableAsync();
  } catch {
    return false;
  }
}

export function useFallDetector({ onFallDetected }: FallDetectorOptions) {
  const [enabled, setEnabledState] = useState<boolean>(false);
  const [available, setAvailable] = useState<boolean>(false);

  // Mutable detector state stored in refs so callbacks don't churn.
  const stateRef = useRef<State>('idle');
  const impactAtRef = useRef<number>(0);
  const stillnessStartRef = useRef<number>(0);
  const cooldownUntilRef = useRef<number>(0);
  // Ring buffer of recent magnitudes — used to detect a pre-impact
  // freefall (magnitude < 0.6g for ≥120ms). This is the v6.5 false-positive
  // killer: phone-handling spikes never have a preceding freefall window.
  const recentRef = useRef<Array<{ t: number; m: number }>>([]);
  const callbackRef = useRef(onFallDetected);
  useEffect(() => { callbackRef.current = onFallDetected; }, [onFallDetected]);

  // Load persisted preference + capability on mount.
  useEffect(() => {
    (async () => {
      const [en, av] = await Promise.all([isFallEnabled(), isFallAvailable()]);
      setEnabledState(en);
      setAvailable(av);
    })();
  }, []);

  // Public setter that also persists.
  const setEnabled = useCallback(async (v: boolean) => {
    await setFallEnabled(v);
    setEnabledState(v);
  }, []);

  // Subscribe to the accelerometer whenever both `enabled` and `available` are true.
  useEffect(() => {
    if (!enabled || !available) return;
    // Web preview: skip — accelerometer events aren't reliable here and most
    // desktop browsers don't expose them.
    if (Platform.OS === 'web') return;

    Accelerometer.setUpdateInterval(SAMPLE_RATE_MS);
    const sub = Accelerometer.addListener(({ x, y, z }) => {
      const now = Date.now();
      const mag = Math.sqrt(x * x + y * y + z * z);

      // Maintain rolling ring buffer used by the freefall check below.
      // We keep ~1 second of history (FREEFALL_LOOKBACK_MS + slack).
      const buf = recentRef.current;
      buf.push({ t: now, m: mag });
      const cutoff = now - (FREEFALL_LOOKBACK_MS + 200);
      while (buf.length && buf[0].t < cutoff) buf.shift();

      if (stateRef.current === 'cooldown') {
        if (now >= cooldownUntilRef.current) {
          stateRef.current = 'idle';
        } else {
          return;
        }
      }

      if (stateRef.current === 'idle') {
        if (mag >= IMPACT_G) {
          // v6.5: Before accepting this as a fall impact, look back for
          // a freefall signature. A real fall has ~120ms+ of sub-0.6g
          // magnitude during the actual fall through the air. Phone
          // handling spikes (smacking the phone on a table, dropping
          // into your lap, etc.) DON'T have this pre-impact freefall.
          let freefallMs = 0;
          let freefallStart = 0;
          for (let i = 0; i < buf.length - 1; i++) {
            if (buf[i].t > now - 20) break;  // ignore the impact sample itself
            if (buf[i].m < FREEFALL_G) {
              if (!freefallStart) freefallStart = buf[i].t;
              freefallMs = buf[i].t - freefallStart;
            } else {
              freefallStart = 0;
              freefallMs = 0;
            }
          }
          if (freefallMs < FREEFALL_REQUIRED_MS) {
            // No freefall → likely a phone-handling spike. Ignore.
            return;
          }
          stateRef.current = 'impact-wait-stillness';
          impactAtRef.current = now;
          stillnessStartRef.current = 0;
        }
        return;
      }

      // state === 'impact-wait-stillness'
      const elapsedSinceImpact = now - impactAtRef.current;
      const isStill = Math.abs(mag - 1.0) <= STILLNESS_BAND_G;

      if (isStill) {
        if (stillnessStartRef.current === 0) stillnessStartRef.current = now;
        const stillFor = now - stillnessStartRef.current;
        if (stillFor >= STILLNESS_REQUIRED_MS) {
          // Fall confirmed.
          stateRef.current = 'cooldown';
          cooldownUntilRef.current = now + COOLDOWN_MS;
          impactAtRef.current = 0;
          stillnessStartRef.current = 0;
          try { callbackRef.current(); } catch (_e) {}
        }
      } else {
        // Reset stillness streak — device still moving.
        stillnessStartRef.current = 0;
      }

      // If the post-impact window expires without enough stillness, reset.
      if (elapsedSinceImpact > POST_IMPACT_WINDOW_MS) {
        stateRef.current = 'idle';
        impactAtRef.current = 0;
        stillnessStartRef.current = 0;
      }
    });

    return () => {
      sub && sub.remove();
    };
  }, [enabled, available]);

  return { enabled, available, setEnabled };
}
