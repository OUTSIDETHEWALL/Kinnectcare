import { requireOptionalNativeModule } from 'expo';

type LifetimeNative = {
  headlessTaskCurrent?: (token: string) => boolean;
  headlessTaskEnd?: (token: string) => void;
};

/**
 * Native execution liveness only; callers still require all ownership fences.
 * Missing support is never interpreted as a live task (requires a new binary).
 * Local cancellation is sticky even if a promise or native query returns late.
 */
export function headlessTaskLifetime(event: { kcTaskLifetime?: unknown }) {
  const token = typeof event?.kcTaskLifetime === 'string' ? event.kcTaskLifetime : '';
  let native: LifetimeNative | null = null;
  try { native = requireOptionalNativeModule<LifetimeNative>('StartupDiagnostics'); } catch { /* fail closed */ }
  let ended = !token || !native?.headlessTaskCurrent || !native?.headlessTaskEnd;
  const isCurrent = () => {
    if (ended) return false;
    try {
      if (native?.headlessTaskCurrent?.(token) === true) return true;
    } catch { /* unavailable is not authority */ }
    ended = true;
    return false;
  };
  const cancel = () => {
    ended = true;
    try { if (token) native?.headlessTaskEnd?.(token); } catch { /* native deadline still applies */ }
  };
  return { isCurrent, cancel };
}
