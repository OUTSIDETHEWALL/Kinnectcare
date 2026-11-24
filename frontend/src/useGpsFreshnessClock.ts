import { useEffect, useReducer } from 'react';
import { AppState } from 'react-native';
import { gpsFreshnessBoundaryDelay } from './gpsFreshness';

/**
 * One pending display deadline, not an interval/poll: re-arm at 30 minutes
 * for the 60-minute boundary, even without a store update. Re-evaluate on resume.
 * No GPS, networking, or background wake is requested by this display clock.
 */
export function useGpsFreshnessClock(capturedAt: string | null | undefined, enabled: boolean): number {
  const [, redraw] = useReducer(value => value + 1, 0);
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (timer) clearTimeout(timer);
      const delay = gpsFreshnessBoundaryDelay(capturedAt);
      if (delay !== null) timer = setTimeout(() => { redraw(); arm(); }, delay);
    };
    arm();
    const listener = AppState.addEventListener('change', state => {
      if (state === 'active') { redraw(); arm(); }
    });
    return () => { if (timer) clearTimeout(timer); listener.remove(); };
  }, [capturedAt, enabled]);
  return Date.now();
}
