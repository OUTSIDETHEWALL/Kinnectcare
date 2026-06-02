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
// v6.11.5 RECALIBRATION — user feedback: fall detection not triggering
// at all on real-world tests. Per user direction: "lower the threshold
// significantly — err toward too sensitive rather than not sensitive
// enough." The 30-second cancel-countdown handles false positives.
//
// Changes vs v6.8.3:
//   IMPACT_G        2.2  → 1.7   (catches softer impacts, mattress / couch falls)
//   FREEFALL_G      0.6  → 0.75  (looser pre-impact band — phone often rotates
//                                  during a fall and doesn't hit a clean <0.6g
//                                  trough for 120ms straight)
//   FREEFALL_REQ_MS 120  → 60    (sharp downward motion from standing height
//                                  only has ~60-100ms of freefall before impact)
//   STILLNESS_BAND  0.35 → 0.5   (very loose — any soft-surface bounce ok)
//   STILLNESS_REQ   1000 → 600   (don't make user wait — confirm fast)
//
// Net effect: a sharp downward motion from standing height should
// trigger every time. A gentle set-down still won't qualify because:
//   • There's no freefall window in a controlled set-down (the hand
//     supports the phone the whole way, magnitude never drops <0.75g).
//   • Peak impact G of a gentle set-down is typically <1.4g, well
//     under the 1.7g impact threshold.
const SAMPLE_RATE_MS = 50;             // ~20 Hz
const FREEFALL_G = 0.75;               // loosened — phone rotation during real falls
const FREEFALL_REQUIRED_MS = 60;       // ~60ms of freefall = a real drop, not a set-down
const FREEFALL_LOOKBACK_MS = 600;
const IMPACT_G = 1.7;                  // significantly more sensitive
const STILLNESS_BAND_G = 0.5;          // very loose for soft-surface bounce
const STILLNESS_REQUIRED_MS = 600;     // confirm fast — 30s cancel handles false positives
const POST_IMPACT_WINDOW_MS = 4000;
const COOLDOWN_MS = 12000;

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
          // v6.8.1 — the freefall pre-check now tracks the MAXIMUM
          // sub-0.6g streak length in the lookback window, not the
          // last-consecutive one. Couch-impact falls have ~100-200ms
          // of clean freefall followed by 1-2 transition samples
          // (~0.7-1.2g as the body starts decelerating into the
          // soft surface) BEFORE the impact spike. The previous
          // implementation reset the streak counter to 0 on those
          // transition samples — so even a perfectly valid 150ms
          // freefall got discarded if it didn't continue right up
          // to the impact sample. Tracking max-streak fixes this
          // without loosening the threshold itself (still 120ms /
          // sub-0.6g) and without re-introducing false positives
          // from phone-handling spikes (which never produce a
          // sub-0.6g window of any meaningful duration).
          let maxFreefallMs = 0;
          let curStart = 0;
          let curMs = 0;
          for (let i = 0; i < buf.length - 1; i++) {
            if (buf[i].t > now - 20) break;  // skip the impact sample
            if (buf[i].m < FREEFALL_G) {
              if (!curStart) curStart = buf[i].t;
              curMs = buf[i].t - curStart;
              if (curMs > maxFreefallMs) maxFreefallMs = curMs;
            } else {
              curStart = 0;
              curMs = 0;
            }
          }
          if (__DEV__) {
            // eslint-disable-next-line no-console
            console.log('[fall] impact', mag.toFixed(2), 'g — maxFreefall', maxFreefallMs, 'ms');
          }
          if (maxFreefallMs < FREEFALL_REQUIRED_MS) {
            // No qualifying freefall window → likely a phone-handling
            // spike. Ignore.
            return;
          }
          if (__DEV__) {
            // eslint-disable-next-line no-console
            console.log('[fall] freefall window passed — waiting for stillness');
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
