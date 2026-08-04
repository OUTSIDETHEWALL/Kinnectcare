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
): OverallHealthResult {
  const rev = [...log].reverse();

  const uploadEvt = rev.find(
    (e) => e.event === 'sdk_onHttp' && e.detail?.success === true,
  ) ?? null;
  const uploadAge = uploadEvt ? now - uploadEvt.at : null;

  const enabledEvt = rev.find((e) => e.event === 'sdk_onEnabledChange') ?? null;
  const engineExplicitlyDisabled =
    enabledEvt !== null && enabledEvt.detail?.enabled === false;

  // Upload happened recently → healthy regardless of heartbeat/bg-service status.
  if (uploadAge !== null && uploadAge < 5 * 60_000) {
    return {
      level: 'ok',
      headline: 'Kinnship is working normally',
      subline: `Last location uploaded ${formatAgeMs(uploadAge)}`,
      uploadAgeMs: uploadAge,
    };
  }

  // Upload is a bit late but not critically so → warn.
  if (uploadAge !== null && uploadAge < 15 * 60_000) {
    return {
      level: 'warn',
      headline: 'Monitoring may be delayed',
      subline: `Last upload ${formatAgeMs(uploadAge)} — usually self-correcting`,
      uploadAgeMs: uploadAge,
    };
  }

  // Upload is critically old → error.
  if (uploadAge !== null) {
    return {
      level: 'error',
      headline: 'Location updates have stopped',
      subline: `No upload in ${formatAgeMs(uploadAge)} — check background permissions`,
      uploadAgeMs: uploadAge,
    };
  }

  // No upload in the log at all.  If the engine was explicitly disabled, that
  // is a confirmed failure.  Otherwise this is a fresh start — not an error.
  if (engineExplicitlyDisabled) {
    return {
      level: 'error',
      headline: 'Background tracking is off',
      subline: 'The location engine is not running — check permissions',
      uploadAgeMs: null,
    };
  }

  return {
    level: 'starting',
    headline: 'Kinnship is starting up',
    subline: 'Waiting for first location upload — normal on a fresh start',
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
