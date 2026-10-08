import {
  startBackgroundLocation,
  stopBackgroundLocation,
} from './backgroundLocation';
import * as locationEngine from './locationEngine';
import type { LocationEngineConfig, LocationStartupOutcome } from './locationEngine';

type InFlightTransistorStart = {
  key: string;
  isCurrent?: () => boolean;
  promise: Promise<LocationStartupOutcome>;
};

let transistorStartInFlight: InFlightTransistorStart | null = null;

export function needsLocationEngineBootstrap(
  bootedForUserId: string | null,
  userId: string,
): boolean {
  return bootedForUserId !== userId;
}

/**
 * Start Transistor only after removing any persisted Expo Location task.
 * Returns false when this binary does not contain the Transistor module.
 */
export async function ensureTransistorLocationEngine(
  config: LocationEngineConfig,
): Promise<LocationStartupOutcome> {
  if (!locationEngine.isAvailable()) return 'failed';
  const key = `${config.backendBaseUrl}\u0000${config.memberId}\u0000${config.jwt}`;
  if (transistorStartInFlight) {
    if (transistorStartInFlight.key === key && transistorStartInFlight.isCurrent === config.isCurrent) {
      return transistorStartInFlight.promise;
    }
    await transistorStartInFlight.promise;
    return ensureTransistorLocationEngine(config);
  }

  const startPromise = (async () => {
    const legacyStopped = await stopBackgroundLocation();
    if (!legacyStopped) return 'failed' as const;

    return locationEngine.start(config);
  })();
  transistorStartInFlight = { key, isCurrent: config.isCurrent, promise: startPromise };

  try {
    return await startPromise;
  } finally {
    if (transistorStartInFlight?.promise === startPromise) {
      transistorStartInFlight = null;
    }
  }
}

/**
 * Start Expo Location only on binaries where Transistor is unavailable.
 * On Transistor-capable binaries, also reconciles away any persisted legacy task.
 */
export async function startLegacyLocationFallback(memberId: string): Promise<boolean> {
  if (locationEngine.isAvailable()) {
    await stopBackgroundLocation();
    return false;
  }

  // Automatic bootstrap is passive. Explicit SOS cadence calls retain the
  // legacy helper's existing permission behavior.
  return startBackgroundLocation(memberId, false);
}