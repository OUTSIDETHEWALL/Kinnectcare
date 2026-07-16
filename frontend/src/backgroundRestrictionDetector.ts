/**
 * Background Restriction Detector (Leonidas v1.1 companion).
 *
 * Positively detects OS-level conditions that restrict Kinnship's
 * background activity and can cause stale location updates.  Only
 * flags conditions for which there is concrete evidence — never
 * warns speculatively.
 *
 * Evidence sources:
 *   1. Live SDK query — lib.isPowerSaveMode() (Android only)
 *   2. Engine log — headless_engine_disabled_restart_error and
 *      restart_error events within the evidence window
 *   3. Leonidas recovery log — engine-restart-failed as the most
 *      recent restart outcome (not followed by engine-restart-succeeded)
 *
 * Evidence window: 24 hours.  Events older than this are not treated
 * as active evidence (the user may have already resolved the condition).
 *
 * This module has no side effects — it is a pure read of existing
 * ring buffers plus one optional live SDK call.  Safe to call from
 * any screen.
 */
import { Platform } from 'react-native';
import { getEngineLog } from './locationEngine';
import { getRecoveryLog } from './leonidas/recoveryLog';

const EVIDENCE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

export type RestrictionStatus = {
  /** True if at least one condition is positively confirmed */
  isRestricted: boolean;
  /** Android Power Save (battery-saver) mode is currently active */
  powerSaveActive: boolean;
  /**
   * The OS blocked at least one background engine restart attempt within
   * the evidence window.  Source: headless_engine_disabled_restart_error
   * or restart_error in the engine diagnostic log.
   */
  restartBlockedByOs: boolean;
  /**
   * Leonidas's most recent restart attempt within the evidence window
   * ended in failure and was not followed by a success.  Source:
   * engine-restart-failed in the Leonidas recovery log.
   */
  leonidasRestartFailed: boolean;
  /** Epoch ms of the most recent piece of evidence across all conditions */
  lastEvidenceAt: number | null;
};

/** Lazy-load the Transistor SDK without crashing on web / iOS simulator. */
function bgGeo(): any | null {
  if (Platform.OS !== 'android') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    return require('react-native-background-geolocation').default;
  } catch (_e) {
    return null;
  }
}

/**
 * Read the current restriction status.  Async but fast — reads from
 * in-memory ring buffers (AsyncStorage only on cold start) plus one
 * optional native SDK call.
 *
 * Returns a status object where `isRestricted === false` means no
 * confirmed evidence was found.  The component should render nothing
 * in that case.
 */
export async function getRestrictionStatus(): Promise<RestrictionStatus> {
  const now = Date.now();
  const windowStart = now - EVIDENCE_WINDOW_MS;

  // ── 1. Active power save mode (Android, live SDK query) ──────────────
  let powerSaveActive = false;
  if (Platform.OS === 'android') {
    try {
      const lib = bgGeo();
      if (lib && typeof lib.isPowerSaveMode === 'function') {
        powerSaveActive = await lib.isPowerSaveMode();
      }
    } catch (_e) {
      // SDK version doesn't support this call — leave false (no evidence)
    }
  }

  // ── 2. OS-blocked restart evidence (engine diagnostic log) ────────────
  let restartBlockedByOs = false;
  let lastRestartBlockAt: number | null = null;
  try {
    const engineLog = await getEngineLog();
    const blocking = engineLog.filter(
      (e) =>
        e.at >= windowStart &&
        (e.event === 'headless_engine_disabled_restart_error' ||
          e.event === 'restart_error'),
    );
    if (blocking.length > 0) {
      restartBlockedByOs = true;
      lastRestartBlockAt = Math.max(...blocking.map((e) => e.at));
    }
  } catch (_e) {
    // Ring buffer unavailable — treat as no evidence
  }

  // ── 3. Leonidas restart outcome (recovery log) ────────────────────────
  //
  // Only flag as failed if the most recent restart attempt (succeeded OR
  // failed) within the window ended in failure.  A subsequent success
  // clears the flag automatically — no manual reset needed.
  let leonidasRestartFailed = false;
  let lastLeonidasFailAt: number | null = null;
  try {
    const recoveryLog = await getRecoveryLog();
    const attempts = recoveryLog
      .filter(
        (e) =>
          e.at >= windowStart &&
          (e.event === 'engine-restart-succeeded' ||
            e.event === 'engine-restart-failed'),
      )
      .sort((a, b) => a.at - b.at); // oldest → newest

    if (attempts.length > 0) {
      const last = attempts[attempts.length - 1];
      if (last.event === 'engine-restart-failed') {
        leonidasRestartFailed = true;
        lastLeonidasFailAt = last.at;
      }
    }
  } catch (_e) {
    // Ring buffer unavailable
  }

  // ── Aggregate ─────────────────────────────────────────────────────────
  const isRestricted = powerSaveActive || restartBlockedByOs || leonidasRestartFailed;

  const evidenceTimes: number[] = [];
  if (powerSaveActive) evidenceTimes.push(now);
  if (lastRestartBlockAt != null) evidenceTimes.push(lastRestartBlockAt);
  if (lastLeonidasFailAt != null) evidenceTimes.push(lastLeonidasFailAt);

  return {
    isRestricted,
    powerSaveActive,
    restartBlockedByOs,
    leonidasRestartFailed,
    lastEvidenceAt: evidenceTimes.length > 0 ? Math.max(...evidenceTimes) : null,
  };
}
