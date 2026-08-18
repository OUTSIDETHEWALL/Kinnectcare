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
import { Colors } from './theme';

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
  /** Optional: epoch-ms of the last confirmed successful upload, read from the
   *  dedicated persistent AsyncStorage key (getLastHttpSuccessTs()).
   *
   *  Why this exists: the ring buffer (50 entries) is shared by ALL event types.
   *  During a network-error storm the buffer can fill with failure entries and
   *  evict the most recent success.  computeOverallHealth() would then find no
   *  success in the buffer and fall back to warn or starting even though
   *  kc_pts_http_ok proves a successful upload just happened.
   *
   *  This mirrors the lastHttpSuccessMs pattern already used by computeHealthItems().
   *  When provided, the function takes the most-recent of all three evidence
   *  streams (ring buffer, lastSeenMs, lastHttpSuccessMs).
   */
  lastHttpSuccessMs?: number | null,
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

  // ── Tertiary signal: persistent AsyncStorage key kc_pts_http_ok ───────────
  // Immune to ring-buffer eviction.  Written by both the foreground onHttp
  // listener and the headless HTTP event handler (recordPipelineTs).
  const httpSuccessAge = (lastHttpSuccessMs != null && lastHttpSuccessMs > 0 && lastHttpSuccessMs <= now)
    ? now - lastHttpSuccessMs
    : null;

  // Combine all three evidence streams — pick the freshest (lowest age).
  const candidateAges = [logUploadAge, lastSeenAge, httpSuccessAge].filter(
    (a): a is number => a !== null,
  );
  const uploadAge = candidateAges.length > 0 ? Math.min(...candidateAges) : null;

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
      subline: `Last heartbeat: ${formatAgeMs(hbAge)} — upload confirmation expected within the next minute`,
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
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

export function computeHealthItems(
  log: EngineLogEvent[],
  now: number,
  /** Optional: epoch-ms of the last confirmed successful upload, read from the
   *  dedicated persistent AsyncStorage key (getLastHttpSuccessTs()).
   *
   *  Why this exists: the ring buffer (50 entries) is shared by ALL event types.
   *  After PR #74 the headless path also writes sdk_onHttp on failure, so during
   *  a network-error storm the buffer can fill with failure entries and evict the
   *  most recent success.  computeHealthItems() would then find no success in the
   *  buffer and flip the upload row to ❌ even though uploads are actually working.
   *
   *  This key is written by both the foreground onHttp listener and the headless
   *  HTTP event handler (getLastHttpSuccessTs / PTS_KEYS.http_success) and is
   *  immune to eviction.  When provided, the function takes the more-recent of
   *  the ring-buffer evidence and this persistent timestamp, ensuring the upload
   *  row stays green whenever the device has recently confirmed a successful upload.
   */
  lastHttpSuccessMs?: number | null,
): HealthItem[] {
  const rev = [...log].reverse();

  // 1 — Background service: most recent sdk_onEnabledChange.
  //     null → 'unknown' (not yet seen, normal on fresh start — not an error).
  const enabledEvt = rev.find((e) => e.event === 'sdk_onEnabledChange') ?? null;
  const bgStatus: HealthStatus =
    enabledEvt === null             ? 'unknown'
    : enabledEvt.detail?.enabled   ? 'ok'
    : 'error';

  // 2 — Last location upload: sdk_onHttp with success=true.
  //     ✅ < 5 min  ⚠ 5–15 min  ❌ > 15 min  ℹ no entry yet
  //
  //     Computed FIRST so item 3 (heartbeat) can use uploadAge to avoid a
  //     false-negative.  See the heartbeat comment below for full reasoning.
  //
  //     Two evidence streams are combined with Math.min (pick the fresher):
  //       a) Ring buffer: scan for the most recent sdk_onHttp with success=true.
  //          Can be evicted when the buffer fills with failure entries.
  //       b) lastHttpSuccessMs: a dedicated persistent AsyncStorage key that is
  //          immune to ring-buffer eviction.  Written by both the foreground
  //          onHttp listener and the headless HTTP event handler.
  const uploadEvt = rev.find(
    (e) => e.event === 'sdk_onHttp' && e.detail?.success === true,
  ) ?? null;
  const bufferUploadAge = uploadEvt ? now - uploadEvt.at : null;
  const persistedUploadAge =
    lastHttpSuccessMs != null && lastHttpSuccessMs > 0 && lastHttpSuccessMs <= now
      ? now - lastHttpSuccessMs
      : null;
  const uploadAge =
    bufferUploadAge !== null && persistedUploadAge !== null
      ? Math.min(bufferUploadAge, persistedUploadAge)
      : bufferUploadAge ?? persistedUploadAge;
  const uploadStatus: HealthStatus =
    uploadAge === null          ? 'unknown'
    : uploadAge < 5 * 60_000   ? 'ok'
    : uploadAge < 15 * 60_000  ? 'warn'
    : 'error';

  // 3 — Last heartbeat: sdk_onHeartbeat or headless_task_invoked.
  //     ✅ < 2 min  ⚠ 2–10 min  ❌ > 10 min  ℹ no entry yet (not an error)
  //
  //     IMPORTANT — SDK motion-path suppression:
  //     The Transistor BackgroundGeolocation SDK only fires heartbeat events
  //     when the device is STATIONARY.  When the device is moving, the SDK
  //     sends continuous location events via the motion path instead.  Those
  //     events produce sdk_onHttp entries (captured by uploadAge above) but do
  //     NOT produce sdk_onHeartbeat entries.
  //
  //     Consequence: a device that has been driving for >10 minutes will show a
  //     stale heartbeat timestamp even though the engine is perfectly healthy.
  //     Without accounting for this, hbStatus evaluates to 'error' (❌) while
  //     the upload row simultaneously shows ✅ — an apparent contradiction that
  //     is actually consistent with normal motion-path operation.
  //
  //     Fix: when uploadAge < 5 min the device is demonstrably uploading
  //     locations.  A stale heartbeat in that window means the device is moving
  //     (heartbeat correctly suppressed by the SDK), not that the engine failed.
  //     Cap hbStatus at 'ok' in that case.  Only surface 'error' when both the
  //     heartbeat AND uploads are stale — that is the genuine failure state.
  const hbEvt = rev.find(
    (e) => e.event === 'sdk_onHeartbeat' || e.event === 'headless_task_invoked',
  ) ?? null;
  const hbAge = hbEvt ? now - hbEvt.at : null;
  const uploadRecent = uploadAge !== null && uploadAge < 5 * 60_000;
  const hbStatus: HealthStatus =
    hbAge === null                                  ? 'unknown'
    : hbAge < 2 * 60_000                           ? 'ok'
    : hbAge < 10 * 60_000                          ? 'warn'
    : uploadRecent                                  ? 'ok'   // motion path active — heartbeat correctly suppressed
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
              : (uploadRecent && hbAge >= 10 * 60_000)
                ? `Background tracking active — last heartbeat: ${formatAgeMs(hbAge)}`
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

// ─── Hero card visual theme ────────────────────────────────────────────────
// Exported so both the Diagnostics screen (diagnostics.tsx) and its tests can
// share a single source of truth.  Any palette change here propagates to both
// the rendered card and the regression guards in diagnosticsHeroCard.test.ts.

export const heroTheme: Record<
  OverallHealthLevel,
  { bg: string; border: string; headline: string; sub: string; icon: string }
> = {
  ok:       { bg: '#ECFDF5', border: '#6EE7B7', headline: '#065F46', sub: '#047857', icon: '🛡️' },
  warn:     { bg: '#FFFBEB', border: '#FDE68A', headline: '#92400E', sub: '#B45309', icon: '⚠️' },
  error:    { bg: '#FEF2F2', border: '#FECACA', headline: '#991B1B', sub: '#DC2626', icon: '❌' },
  starting: { bg: '#F9FAFB', border: '#E5E7EB', headline: '#374151', sub: '#6B7280', icon: '⏳' },
};

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
