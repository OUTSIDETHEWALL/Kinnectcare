import {
  startBackgroundLocation,
  stopBackgroundLocation,
} from './backgroundLocation';
import * as locationEngine from './locationEngine';
import type { LocationEngineConfig } from './locationEngine';

type InFlightTransistorStart = {
  key: string;
  promise: Promise<boolean>;
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
): Promise<boolean> {
  if (!locationEngine.isAvailable()) return false;
  const key = `${config.backendBaseUrl}\u0000${config.memberId}\u0000${config.jwt}`;
  if (transistorStartInFlight) {
    if (transistorStartInFlight.key === key) {
      return transistorStartInFlight.promise;
    }
    await transistorStartInFlight.promise;
    return ensureTransistorLocationEngine(config);
  }

  const startPromise = (async () => {
    const legacyStopped = await stopBackgroundLocation();
    if (!legacyStopped) return false;

    await locationEngine.start(config);
    return true;
  })();
  transistorStartInFlight = { key, promise: startPromise };

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

  return startBackgroundLocation(memberId);
}