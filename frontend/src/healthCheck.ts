/**
 * healthCheck.ts — shared health-status computation used by both the
 * Diagnostics screen (full panel) and the Me tab (compact indicator).
 *
 * Extracted so neither screen duplicates the logic.
 *
 * Status semantics:
 *   ok      — confirmed working
 *   warn    — working but degraded (upload late, power saver active)
 *   error   — confirmed broken (engine explicitly disabled, upload > 15 min)
 *   unknown — no data recorded yet; informational, not a failure
 *
 * The critical distinction: 'unknown' means the event log is empty for this
 * signal, which is normal right after a fresh start or a log clear.  It must
 * never render the same way as 'error'.  'error' means we have positive
 * evidence something is wrong.
 */
import { EngineLogEvent } from './locationEngine';

export type HealthStatus = 'ok' | 'warn' | 'error' | 'unknown';
export type HealthItem = { icon: string; label: string; status: HealthStatus };

export function healthIcon(s: HealthStatus): string {
  if (s === 'ok')    return '✅';
  if (s === 'warn')  return '⚠️';
  if (s === 'error') return '❌';
  // 'unknown' — informational, not a failure.  Rendered muted.
  return 'ℹ️';
}

// ─── Overall health verdict ────────────────────────────────────────────────
// Derived primarily from upload recency — the most direct evidence that the
// full pipeline (SDK → background task → network → backend) is working.
// Used by the Diagnostics hero card to answer "is Kinnship protecting my
// loved one right now?" before the user scrolls into any detail panel.

export type OverallHealthLevel = 'ok' | 'warn' | 'error' | 'starting';

export type OverallHealthResult = {
  level: OverallHealthLevel;
  headline: string;
  subline: string;
  uploadAgeMs: number | null;
};

export function computeOverallHealth(
  log: EngineLogEvent[],
  now: number,
  /** Optional: member.last_seen epoch ms from memberStore (populated by /members API).
   *  Captures native background uploads that never produce a JS sdk_onHttp event
   *  because onHttp() is only subscribed inside attachSdkListeners() / startEngine()
   *  and headless task contexts do not call startEngine().  When present, this acts
   *  as a second upload-evidence stream with identical freshness thresholds.
   *  See Task #18 for the full headless logging gap investigation.
   */
  lastSeenMs?: number | null,
): OverallHealthResult {
  const rev = [...log].reverse();

  // ── Primary signal: JS engine log sdk_onHttp success events ──────────────
  const uploadEvt = rev.find(
    (e) => e.event === 'sdk_onHttp' && e.detail?.success === true,
  ) ?? null;
  const logUploadAge = uploadEvt ? now - uploadEvt.at : null;

  // ── Secondary signal: member.last_seen from the backend /members API ──────
  // The dashboard reads this field via memberStore and it updates whenever the
  // Transistor SDK delivers a location to the backend — including headless
  // native uploads.  Use the more recent of the two sources.
  const lastSeenAge = (lastSeenMs != null && lastSeenMs > 0 && lastSeenMs <= now)
    ? now - lastSeenMs
    : null;

  const uploadAge = (logUploadAge !== null && lastSeenAge !== null)
    ? Math.min(logUploadAge, lastSeenAge)
    : logUploadAge ?? lastSeenAge;

  const enabledEvt = rev.find((e) => e.event === 'sdk_onEnabledChange') ?? null;
  const engineExplicitlyDisabled =
    enabledEvt !== null && enabledEvt.detail?.enabled === false;

  // Upload happened recently → healthy regardless of heartbeat/bg-service status.
  if (uploadAge !== null && uploadAge < 5 * 60_000) {
    return {
      level: 'ok',
      headline: 'Background monitoring is healthy',
      subline: `Last location confirmed: ${formatAgeMs(uploadAge)}`,
      uploadAgeMs: uploadAge,
    };
  }

  // Upload is a bit late but not critically so → warn.
  if (uploadAge !== null && uploadAge < 15 * 60_000) {
    return {
      level: 'warn',
      headline: 'Monitoring may be delayed',
      subline: `Last location confirmed: ${formatAgeMs(uploadAge)} — usually self-correcting`,
      uploadAgeMs: uploadAge,
    };
  }

  // Upload is critically old → error.
  if (uploadAge !== null) {
    return {
      level: 'error',
      headline: 'Monitoring appears to have stopped',
      subline: `Last location confirmed: ${formatAgeMs(uploadAge)} — check background permissions`,
      uploadAgeMs: uploadAge,
    };
  }

  // No upload in the log at all.  If the engine was explicitly disabled, that
  // is a confirmed failure.  Otherwise this is a fresh start — not an error.
  if (engineExplicitlyDisabled) {
    return {
      level: 'error',
      headline: 'Monitoring appears to have stopped',
      subline: 'The location engine is not running — check permissions',
      uploadAgeMs: null,
    };
  }

  // ── Heartbeat fallback ────────────────────────────────────────────────────
  //
  // Why sdk_onHttp may be absent even on a healthy device:
  //   lib.onHttp() is subscribed inside attachSdkListeners(), which is only
  //   called by startEngine().  The headless task handler runs in a minimal
  //   JS context that does NOT call startEngine() / attachSdkListeners().
  //   When the Transistor native SDK uploads location during a headless
  //   wakeup (the normal background path), no onHttp JS callback fires and
  //   therefore no sdk_onHttp entry lands in the ring buffer.
  //
  //   The heartbeat IS logged by the headless task via an explicit
  //   logEvent('headless_task_invoked') call, so heartbeat evidence is
  //   reliable even when upload evidence is absent.
  //
  // Consequence: returning 'starting' whenever sdk_onHttp is absent
  //   misrepresents an engine that has been running for minutes as
  //   "just launched."  A caregiver sees the hourglass while the heartbeat
  //   row shows green — which looks like a contradiction.
  //
  // Fix: if a heartbeat is present, return 'warn' (amber) instead of
  //   'starting' (gray).  Amber correctly communicates "engine is alive
  //   but we haven't confirmed a location upload yet" — honest and not
  //   falsely alarming.
  const hbEvt = rev.find(
    (e) => e.event === 'sdk_onHeartbeat' || e.event === 'headless_task_invoked',
  ) ?? null;
  if (hbEvt !== null) {
    const hbAge = now - hbEvt.at;
    return {
      level: 'warn',
      headline: 'Engine running, no upload confirmed yet',
      subline: `Last heartbeat: ${formatAgeMs(hbAge)} — location uploads are confirmed when the app is in the foreground`,
      uploadAgeMs: null,
    };
  }

  return {
    level: 'starting',
    headline: 'Kinnship is starting up',
    subline: 'Waiting for first successful upload',
    uploadAgeMs: null,
  };
}

export function formatAgeMs(ms: number | null): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

export function computeHealthItems(log: EngineLogEvent[], now: number): HealthItem[] {
  const rev = [...log].reverse();

  // 1 — Background service: most recent sdk_onEnabledChange.
  //     null → 'unknown' (not yet seen, normal on fresh start — not an error).
  const enabledEvt = rev.find((e) => e.event === 'sdk_onEnabledChange') ?? null;
  const bgStatus: HealthStatus =
    enabledEvt === null             ? 'unknown'
    : enabledEvt.detail?.enabled   ? 'ok'
    : 'error';

  // 2 — Last heartbeat: sdk_onHeartbeat or headless_task_invoked.
  //     ✅ < 2 min  ⚠ 2–10 min  ❌ > 10 min  ℹ no entry yet (not an error)
  //
  //     Crucially: absence of a heartbeat in the log does NOT mean the
  //     engine is broken.  Heartbeats only fire ~60 s after start, and
  //     the log is cleared between sessions.  Treat null as 'unknown',
  //     not 'error' — the upload age check (item 3) is the real signal.
  const hbEvt = rev.find(
    (e) => e.event === 'sdk_onHeartbeat' || e.event === 'headless_task_invoked',
  ) ?? null;
  const hbAge = hbEvt ? now - hbEvt.at : null;
  const hbStatus: HealthStatus =
    hbAge === null         ? 'unknown'
    : hbAge < 2 * 60_000  ? 'ok'
    : hbAge < 10 * 60_000 ? 'warn'
    : 'error';

  // 3 — Last location upload: sdk_onHttp with success=true.
  //     ✅ < 5 min  ⚠ 5–15 min  ❌ > 15 min  ℹ no entry yet
  const uploadEvt = rev.find(
    (e) => e.event === 'sdk_onHttp' && e.detail?.success === true,
  ) ?? null;
  const uploadAge = uploadEvt ? now - uploadEvt.at : null;
  const uploadStatus: HealthStatus =
    uploadAge === null          ? 'unknown'
    : uploadAge < 5 * 60_000   ? 'ok'
    : uploadAge < 15 * 60_000  ? 'warn'
    : 'error';

  // 4 — Battery listener: battery_listeners_attached event present.
  //     Absence is informational — the listener attaches early but may not
  //     have fired before the user opens diagnostics.
  const battListenerEvt = rev.find((e) => e.event === 'battery_listeners_attached') ?? null;
  const battStatus: HealthStatus = battListenerEvt ? 'ok' : 'unknown';

  // 5 — Power Saver: most recent sdk_onPowerSaveChange.
  //     ✅ off  ❌ on (confirmed active)  ℹ no event yet
  const powerEvt = rev.find((e) => e.event === 'sdk_onPowerSaveChange') ?? null;
  const powerStatus: HealthStatus =
    powerEvt === null                  ? 'unknown'
    : powerEvt.detail?.isPowerSaveMode ? 'warn'   // warn, not error — Power Saver slows uploads, doesn't stop them
    : 'ok';

  return [
    {
      icon:   healthIcon(bgStatus),
      label:  bgStatus === 'ok'      ? 'Background service running'
              : bgStatus === 'error' ? 'Background service stopped'
              : 'Background service: waiting for first event',
      status: bgStatus,
    },
    {
      icon:   healthIcon(hbStatus),
      label:  hbAge === null
              ? 'Background heartbeat: waiting for first event'
              : `Last background heartbeat: ${formatAgeMs(hbAge)}`,
      status: hbStatus,
    },
    {
      icon:   healthIcon(uploadStatus),
      label:  uploadAge === null
              ? 'Location upload: waiting for first upload'
              : `Last location uploaded: ${formatAgeMs(uploadAge)}`,
      status: uploadStatus,
    },
    {
      icon:   healthIcon(battStatus),
      label:  battStatus === 'ok' ? 'Battery monitoring active' : 'Battery monitoring: starting up',
      status: battStatus,
    },
    {
      icon:   healthIcon(powerStatus),
      label:  powerStatus === 'ok'   ? 'Power Saver off'
              : powerStatus === 'warn' ? 'Power Saver is on — may slow updates'
              : 'Power Saver: not yet detected',
      status: powerStatus,
    },
  ];
}

/**
 * Returns the worst status across all items, in order: error > warn > unknown > ok.
 * Used by the Me tab indicator to decide whether to show anything.
 */
export function worstHealthStatus(items: HealthItem[]): HealthStatus {
  if (items.some((i) => i.status === 'error'))   return 'error';
  if (items.some((i) => i.status === 'warn'))    return 'warn';
  if (items.some((i) => i.status === 'unknown')) return 'unknown';
  return 'ok';
}
