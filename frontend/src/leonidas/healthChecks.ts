/**
 * Leonidas health classifiers — pure functions only.
 *
 * Given a current health snapshot (engine state, auth, upload age),
 * decide which HealthState applies and what RecoveryAction (if any)
 * to take.  No side effects here — the patrol loop is responsible for
 * issuing the actual SDK calls.
 */
import {
  HealthSnapshot,
  HealthState,
  RecoveryAction,
  RecoveryReason,
  MOVING_RECOVERY_MINUTES,
  MOVING_CRITICAL_MINUTES,
  STATIONARY_RECOVERY_MIN_MINUTES,
} from './types';

const MIN_TO_MS = 60 * 1000;

/**
 * Decide the current health state from a snapshot.
 * Pure function — same input always produces the same output.
 */
export function classifyHealth(s: Omit<HealthSnapshot, 'health_state' | 'recovery_reason' | 'recovery_action' | 'recovery_result' | 'recovery_duration_ms'>): {
  state: HealthState;
  reason: RecoveryReason;
  action: RecoveryAction;
} {
  // ----- Hardest-fail conditions first -----
  if (!s.engine_available) {
    return { state: 'critical', reason: 'engine-not-available', action: 'restart-engine' };
  }
  if (!s.has_jwt) {
    // Without a JWT the engine can't upload at all.  We can't fix this
    // from Leonidas — the auth flow has to re-run.  Log as critical
    // but take NO action; let the next patrol re-check after auth
    // resolves.
    return { state: 'critical', reason: 'no-jwt', action: 'none' };
  }
  if (!s.engine_enabled) {
    return { state: 'critical', reason: 'engine-not-enabled', action: 'restart-engine' };
  }

  // ----- Upload-freshness ladder -----
  // If we have no last_upload_at, treat as unknown rather than panic
  // (e.g. cold start before the first heartbeat lands).
  const ageMs = s.last_upload_age_ms;
  if (ageMs === null) {
    return { state: 'unknown', reason: null, action: 'none' };
  }

  if (s.engine_is_moving === true) {
    // -------- MOVING --------
    if (ageMs >= MOVING_CRITICAL_MINUTES * MIN_TO_MS) {
      return { state: 'critical', reason: 'moving-critical-10m+', action: 'restart-engine+request-fresh-location' };
    }
    if (ageMs >= MOVING_RECOVERY_MINUTES * MIN_TO_MS) {
      return { state: 'degraded', reason: 'moving-stale-2to10m', action: 'request-fresh-location' };
    }
    return { state: 'standing-guard', reason: null, action: 'none' };
  }

  // -------- STATIONARY (isMoving=false or unknown) --------
  // Per product directive: stationary alone NEVER triggers restart.
  // A phone on a kitchen table is expected behaviour.
  if (ageMs >= STATIONARY_RECOVERY_MIN_MINUTES * MIN_TO_MS) {
    return { state: 'degraded', reason: 'stationary-stale-15to30m', action: 'request-fresh-location' };
  }
  // Within the expected-quiet window — "watching" rather than fully
  // healthy, but no action needed.
  if (ageMs >= 5 * MIN_TO_MS) {
    return { state: 'watching', reason: null, action: 'none' };
  }
  return { state: 'standing-guard', reason: null, action: 'none' };
}
