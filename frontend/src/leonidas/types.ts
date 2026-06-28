/**
 * Leonidas v1.0 — Kinnship Health Monitor types & constants.
 *
 * Single source of truth for every tunable knob.  Per the Build 45 spec,
 * thresholds must NOT be buried throughout the code so we can tune
 * behaviour after observing field data without rewriting logic.
 *
 * Philosophy reminder (do not change without product approval):
 *   Leonidas optimises for CAREGIVER CONFIDENCE, not GPS frequency.
 *   A stationary phone on a kitchen table is expected behaviour and
 *   must NOT trigger aggressive recovery.  Movement always carries
 *   more weight than idle time.
 */

import { DIAG_BUFFER_SIZES } from '../diagBufferConfig';

// ===========================================================
//  TUNABLE CONSTANTS
// ===========================================================

/** Patrol cadence — how often Leonidas evaluates app health. */
export const PATROL_INTERVAL_SECONDS = 60;

/**
 * Moving-state freshness ladder.
 * If isMoving=true and last upload age >= MOVING_RECOVERY_MINUTES → request fresh fix.
 * If age >= MOVING_CRITICAL_MINUTES → restart engine.
 */
export const MOVING_HEALTHY_MAX_MINUTES = 2;
export const MOVING_RECOVERY_MINUTES = 2;     // ≥2 min → fresh-fix request
export const MOVING_CRITICAL_MINUTES = 10;    // ≥10 min → restart consideration

/**
 * Stationary-state freshness ladder.
 * Phone is at rest → expected quiet → resist aggressive intervention.
 * Stationary state never auto-restarts the engine.
 */
export const STATIONARY_HEALTHY_MAX_MINUTES = 15;
export const STATIONARY_RECOVERY_MIN_MINUTES = 15;  // ≥15 min → fresh-fix request
export const STATIONARY_RECOVERY_MAX_MINUTES = 30;  // ≥30 min → still just fresh-fix
// NB: no STATIONARY_CRITICAL — stationary alone never triggers restart.

/** How long Leonidas waits after a recovery action before declaring success/failure. */
export const RECOVERY_VERIFY_TIMEOUT_SECONDS = 30;

/** Recovery ring buffer size — keeps the last N Leonidas events. */
export const RECOVERY_LOG_MAX = DIAG_BUFFER_SIZES.leonidas;

// ===========================================================
//  HEALTH STATE MACHINE
// ===========================================================

export type HealthState =
  | 'standing-guard'    // everything healthy; no action this cycle
  | 'watching'          // stationary + last upload in the "expected quiet" window
  | 'degraded'          // recovery action required (fresh-fix request)
  | 'critical'          // engine restart required (moving + no upload, or engine offline)
  | 'unknown';          // not enough info yet (e.g. cold start)

/** Why Leonidas chose its most recent action. */
export type RecoveryReason =
  | 'engine-not-enabled'
  | 'engine-not-available'
  | 'no-jwt'
  | 'no-member-resolved'
  | 'moving-stale-2to10m'
  | 'moving-critical-10m+'
  | 'stationary-stale-15to30m'
  | 'stationary-stale-30m+'
  | null;

/** What Leonidas did in response. */
export type RecoveryAction =
  | 'none'
  | 'request-fresh-location'
  | 'restart-engine'
  | 'restart-engine+request-fresh-location';

export type RecoveryResult =
  | 'success'           // fresh upload observed within the verify window
  | 'failure'           // verify window elapsed without a fresh upload
  | 'skipped'           // action started but engine unavailable mid-flight
  | 'pending'           // verify window still open at log time
  | null;

// ===========================================================
//  HEALTH SNAPSHOT (one row per patrol)
// ===========================================================

export type HealthSnapshot = {
  at: number;                          // patrol timestamp (epoch ms)
  // Engine
  engine_available: boolean;
  engine_enabled: boolean;
  engine_tracking_mode: string;        // 'foreground' | 'background' | 'unknown'
  engine_is_moving: boolean | null;
  // Auth
  has_jwt: boolean;
  // Upload freshness — derived from the most-recent sdk_onHttp success in the engine log
  last_upload_at: number | null;       // epoch ms or null
  last_upload_age_ms: number | null;   // now - last_upload_at
  // Verdict
  health_state: HealthState;
  // Recovery outcome from THIS patrol (null if no action this cycle)
  recovery_reason: RecoveryReason;
  recovery_action: RecoveryAction;
  recovery_result: RecoveryResult;
  recovery_duration_ms: number | null;
};

// ===========================================================
//  RECOVERY LOG ENTRY (recoveryLog ring buffer)
// ===========================================================

export type LeonidasEventType =
  | 'patrol-tick'
  | 'state-change'
  | 'recovery-invoked'
  | 'recovery-succeeded'
  | 'recovery-failed'
  | 'engine-restart-attempted'
  | 'engine-restart-succeeded'
  | 'engine-restart-failed'
  | 'patrol-started'
  | 'patrol-stopped';

export type RecoveryLogEntry = {
  seq: number;                         // shared global counter from diagSeq
  src: 'leonidas';
  at: number;                          // epoch ms
  event: LeonidasEventType;
  health_state: HealthState;
  detail?: Record<string, any>;
};

// ===========================================================
//  PUBLIC API SHAPE (consumed by Diagnostics panel)
// ===========================================================

export type LeonidasSnapshotForUI = {
  /** Current live health state. */
  state: HealthState;
  /** Most recent patrol summary. */
  last_patrol: HealthSnapshot | null;
  /** Patrols completed since process start. */
  patrol_count: number;
  /** Recoveries invoked since UTC-local midnight. */
  recoveries_today: number;
  /** Most recent successful or failed recovery (any kind). */
  last_recovery: HealthSnapshot | null;
  /** Whether the patrol loop is currently running. */
  patrol_active: boolean;
};
