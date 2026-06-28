/**
 * Leonidas v1.0 — Kinnship Health Monitor public surface.
 *
 * One subsystem, one import path.  Designed so future v1.x can add
 * sibling responsibilities (push health, notification health, auth
 * health, dashboard sync, background service) without changing the
 * caller-facing API: layout calls `start()`; diagnostics calls
 * `getSnapshot()`.
 */
import { getPatrolStats, isPatrolActive } from './patrol';
import { LeonidasSnapshotForUI } from './types';

export { startPatrol as start, stopPatrol as stop, isPatrolActive, runOnePatrol, getPatrolStats } from './patrol';
export { getRecoveryLog, clearRecoveryLog } from './recoveryLog';
export type {
  HealthState,
  HealthSnapshot,
  RecoveryLogEntry,
  LeonidasSnapshotForUI,
  LeonidasEventType,
} from './types';

/** One-shot snapshot for the Diagnostics panel. */
export function getSnapshot(): LeonidasSnapshotForUI {
  const s = getPatrolStats();
  return {
    state: s.state,
    last_patrol: s.last_patrol,
    patrol_count: s.patrol_count,
    recoveries_today: s.recoveries_today,
    last_recovery: s.last_recovery,
    patrol_active: isPatrolActive(),
  };
}
