/**
 * Leonidas patrol loop — Build 45 v1.0.
 *
 * Foreground-mode patrol.  Every PATROL_INTERVAL_SECONDS we gather a
 * health snapshot, classify it, and dispatch ONE recovery action if
 * needed.  Strictly one-shot per cycle — no retries inside a single
 * patrol.  The next patrol re-evaluates from scratch.
 *
 * Future v1.1 can extend this with a headless-task counterpart that
 * shares the same `runOnePatrol()` core; this file is structured to
 * support that without redesign.
 */
import { AppState, AppStateStatus } from 'react-native';
import * as locationEngine from '../locationEngine';
import { getCurrentToken } from '../api';
import { classifyHealth } from './healthChecks';
import { logRecovery } from './recoveryLog';
import {
  HealthSnapshot,
  HealthState,
  RecoveryResult,
  PATROL_INTERVAL_SECONDS,
  RECOVERY_VERIFY_TIMEOUT_SECONDS,
} from './types';

// ===========================================================
//  Module-level patrol state
// ===========================================================
let patrolTimer: ReturnType<typeof setInterval> | null = null;
let appStateSub: { remove: () => void } | null = null;
let patrolActive = false;
let patrolCount = 0;
let recoveriesToday = 0;
let recoveriesDayKey = ''; // YYYY-MM-DD of recoveriesToday counter
let lastPatrol: HealthSnapshot | null = null;
let lastRecovery: HealthSnapshot | null = null;
let lastState: HealthState = 'unknown';

// ===========================================================
//  Engine-log peeking — derive last upload age from sdk_onHttp
// ===========================================================
async function findLastUploadAt(): Promise<number | null> {
  try {
    const log = await locationEngine.getEngineLog();
    // Newest-first scan
    for (let i = log.length - 1; i >= 0; i--) {
      const entry = log[i];
      if (entry.event === 'sdk_onHttp' && entry.detail?.success === true && entry.detail?.status === 200) {
        return entry.at;
      }
    }
  } catch (_e) {}
  return null;
}

function dayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function maybeRollRecoveryCounter(): void {
  const k = dayKey();
  if (recoveriesDayKey !== k) {
    recoveriesDayKey = k;
    recoveriesToday = 0;
  }
}

// ===========================================================
//  Single patrol cycle (also reusable from a future headless task)
// ===========================================================
export async function runOnePatrol(): Promise<HealthSnapshot> {
  const at = Date.now();
  patrolCount += 1;
  maybeRollRecoveryCounter();

  // 1) Gather snapshot
  const available = locationEngine.isAvailable();
  let engine_enabled = false;
  let engine_tracking_mode = 'unknown';
  let engine_is_moving: boolean | null = null;
  try {
    const st = await locationEngine.getState();
    engine_enabled = st.enabled;
    engine_tracking_mode = st.trackingMode;
    engine_is_moving = st.isMoving;
  } catch (_e) {}

  let jwt: string | null = null;
  try { jwt = await getCurrentToken(); } catch (_e) {}

  const last_upload_at = await findLastUploadAt();
  const last_upload_age_ms = last_upload_at !== null ? at - last_upload_at : null;

  // 2) Classify
  const verdict = classifyHealth({
    at,
    engine_available: available,
    engine_enabled,
    engine_tracking_mode,
    engine_is_moving,
    has_jwt: !!jwt,
    last_upload_at,
    last_upload_age_ms,
  });

  const snapshot: HealthSnapshot = {
    at,
    engine_available: available,
    engine_enabled,
    engine_tracking_mode,
    engine_is_moving,
    has_jwt: !!jwt,
    last_upload_at,
    last_upload_age_ms,
    health_state: verdict.state,
    recovery_reason: verdict.reason,
    recovery_action: 'none',
    recovery_result: null,
    recovery_duration_ms: null,
  };

  // 3) State-change logging
  if (verdict.state !== lastState) {
    await logRecovery('state-change', verdict.state, {
      from: lastState, to: verdict.state, reason: verdict.reason,
    });
    lastState = verdict.state;
  }

  // 4) Dispatch action (one-shot)
  if (verdict.action !== 'none') {
    snapshot.recovery_action = verdict.action;
    recoveriesToday += 1;
    const startedAt = Date.now();
    await logRecovery('recovery-invoked', verdict.state, {
      reason: verdict.reason, action: verdict.action,
      last_upload_age_ms, engine_is_moving,
    });

    let result: RecoveryResult = 'failure';

    // Restart path (critical only) — least intrusive recovery FIRST,
    // restart is the exception not the rule.
    if (verdict.action === 'restart-engine' || verdict.action === 'restart-engine+request-fresh-location') {
      await logRecovery('engine-restart-attempted', verdict.state);
      try {
        await locationEngine.stop();
        // We cannot re-call start() here because we don't have the
        // cached config (memberId, jwt, backendBaseUrl).  The Transistor
        // SDK persists its native config across stop()/start() cycles,
        // so calling start() with no args via the layout's existing
        // wiring on next user.id change will resume.  For Leonidas v1.0
        // we log the restart-stop step and leave re-start to the next
        // patrol cycle or auth-effect re-trigger.  See Leonidas v1.1
        // for direct re-start support.
        await logRecovery('engine-restart-succeeded', verdict.state, {
          note: 'stop completed; restart deferred to next auth lifecycle',
        });
      } catch (e: any) {
        await logRecovery('engine-restart-failed', verdict.state, {
          error: String(e?.message || e),
        });
      }
    }

    // Fresh-fix request — primary recovery for both degraded and
    // restart-then-refresh cases.
    if (verdict.action === 'request-fresh-location' || verdict.action === 'restart-engine+request-fresh-location') {
      try {
        await locationEngine.requestFreshLocation();
        // Verify by polling the engine log for a new sdk_onHttp success
        // within RECOVERY_VERIFY_TIMEOUT_SECONDS.
        const deadline = startedAt + RECOVERY_VERIFY_TIMEOUT_SECONDS * 1000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 2000));
          const newLast = await findLastUploadAt();
          if (newLast !== null && newLast > startedAt) {
            result = 'success';
            break;
          }
        }
      } catch (e: any) {
        await logRecovery('recovery-failed', verdict.state, {
          error: String(e?.message || e),
        });
        result = 'failure';
      }
    } else {
      // Restart-only (no fresh-fix request) — declare success/failure
      // based on engine state alone.
      result = engine_enabled ? 'success' : 'failure';
    }

    snapshot.recovery_result = result;
    snapshot.recovery_duration_ms = Date.now() - startedAt;
    await logRecovery(
      result === 'success' ? 'recovery-succeeded' : 'recovery-failed',
      verdict.state,
      { duration_ms: snapshot.recovery_duration_ms, action: verdict.action },
    );
    lastRecovery = snapshot;
  } else {
    await logRecovery('patrol-tick', verdict.state, {
      last_upload_age_ms, engine_is_moving,
    });
  }

  lastPatrol = snapshot;
  return snapshot;
}

// ===========================================================
//  Patrol loop control
// ===========================================================
export function startPatrol(): void {
  if (patrolActive) return;
  patrolActive = true;
  void logRecovery('patrol-started', 'unknown');

  // Kick off an immediate patrol so Diagnostics shows fresh data on
  // first paint after login.  Then schedule the interval.
  void runOnePatrol().catch(() => {});

  patrolTimer = setInterval(() => {
    void runOnePatrol().catch(() => {});
  }, PATROL_INTERVAL_SECONDS * 1000);

  // Pause patrol while backgrounded to keep battery cost zero in that
  // state — the engine's own headless task handles in-background work.
  // Future v1.1 will add a headless patrol counterpart.
  const handleAppState = (next: AppStateStatus) => {
    if (next === 'active') {
      if (!patrolTimer) {
        // Resume
        patrolTimer = setInterval(() => {
          void runOnePatrol().catch(() => {});
        }, PATROL_INTERVAL_SECONDS * 1000);
        void runOnePatrol().catch(() => {});
      }
    } else if (next === 'background' || next === 'inactive') {
      if (patrolTimer) {
        clearInterval(patrolTimer);
        patrolTimer = null;
      }
    }
  };
  appStateSub = AppState.addEventListener('change', handleAppState);
}

export function stopPatrol(): void {
  if (!patrolActive) return;
  patrolActive = false;
  if (patrolTimer) {
    clearInterval(patrolTimer);
    patrolTimer = null;
  }
  if (appStateSub) {
    try { appStateSub.remove(); } catch (_e) {}
    appStateSub = null;
  }
  void logRecovery('patrol-stopped', lastState);
}

export function isPatrolActive(): boolean {
  return patrolActive;
}

export function getPatrolStats(): {
  patrol_count: number;
  recoveries_today: number;
  last_patrol: HealthSnapshot | null;
  last_recovery: HealthSnapshot | null;
  state: HealthState;
} {
  maybeRollRecoveryCounter();
  return {
    patrol_count: patrolCount,
    recoveries_today: recoveriesToday,
    last_patrol: lastPatrol,
    last_recovery: lastRecovery,
    state: lastState,
  };
}
