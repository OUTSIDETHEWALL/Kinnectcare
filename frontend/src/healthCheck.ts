/**
 * healthCheck.ts — shared health-status computation used by both the
 * Diagnostics screen (full panel) and the Me tab (compact indicator).
 *
 * Extracted so neither screen duplicates the logic.
 *
 * Status semantics:
 *   ok      — confirmed working
 *   warn    — working but degraded (upload late, power saver active)
 *   error   — actionable failure (for example, engine explicitly disabled)
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
// Derived from correlated capture/publication evidence, never transport alone.
// Used by the Diagnostics hero card to answer "is Kinnship protecting my
// loved one right now?" before the user scrolls into any detail panel.

export type OverallHealthLevel = 'ok' | 'warn' | 'error' | 'starting';

export type OverallHealthResult = {
  level: OverallHealthLevel;
  headline: string;
  subline: string;
  uploadAgeMs: number | null;
};

// A small clock correction can briefly put the persisted upload timestamp
// ahead of the Diagnostics ticker.  Treat that bounded skew as "just now",
// while still rejecting timestamps that are implausibly far in the future.
const CLOCK_SKEW_TOLERANCE_MS = 5_000;

export function computeOverallHealth(
  log: EngineLogEvent[],
  now: number,
  /** Contact/HTTP are supplied only for an honest communication fallback. */
  lastSeenMs?: number | null,
  lastHttpSuccessMs?: number | null,
): OverallHealthResult {
  const valid = log.filter(e => e.at <= now + CLOCK_SKEW_TOLERANCE_MS)
    .sort((a, b) => a.at - b.at);
  const latestState = [...valid].reverse().find(e =>
    e.event === 'sdk_state_observed' || e.event === 'sdk_onEnabledChange');
  const disabled = latestState?.detail?.enabled === false && now - latestState.at < 60_000;
  if (disabled) return {
    level: 'error', headline: 'Native location service is disabled',
    subline: 'Current native state; no claim about earlier delivery', uploadAgeMs: null,
  };
  const lastBoundary = [...valid].reverse().find(e => e.event === 'tracking_authority_boundary'
    || e.event === 'stop_ok')?.at ?? 0;
  const background = valid.filter(e => e.at >= lastBoundary
    && e.event === 'verified_coordinate_publication'
    && (e.detail?.origin === 'background' || (e.detail?.origin === 'native-receipt'
      && typeof e.detail.captureId === 'string' && valid.some(c =>
        c.event === 'native_capture_observed' && c.detail?.captureId === e.detail?.captureId
        && c.detail?.capturedAt === e.detail?.capturedAt && c.detail?.origin === 'background'
        && (c.detail?.consentGeneration ?? 0) === (e.detail?.consentGeneration ?? 0)
        && c.detail?.owner === e.detail?.owner && c.detail?.generation === e.detail?.generation)))
    && (!latestState?.detail?.owner || (e.detail?.owner === latestState.detail.owner
      && e.detail?.generation === latestState.detail.generation))
    && (latestState?.detail?.consentGeneration == null
      || (e.detail?.consentGeneration ?? 0) === latestState.detail.consentGeneration)
    && typeof e.detail?.capturedAt === 'number' && e.detail.capturedAt <= now + 5000);
  const last = background.at(-1);
  const uploadAge = last ? Math.max(0, now - Number(last.detail?.capturedAt)) : null;
  // Two distinct captures spanning a minute establish repeated delivery, not
  // the physical road-test acceptance criterion (which remains unchanged).
  const hasRepeated = (maxAge: number) => last && background.some(e =>
    e.detail?.generation === last.detail?.generation
    && e.detail?.owner === last.detail?.owner
    && (e.detail?.consentGeneration ?? 0) === (last.detail?.consentGeneration ?? 0)
    && last.detail!.capturedAt - e.detail!.capturedAt >= 60_000 && now - e.at < maxAge);
  if (hasRepeated(15 * 60_000) && latestState?.detail?.enabled === true && now - latestState.at < 60_000
    && typeof latestState.detail.owner === 'string' && typeof latestState.detail.generation === 'number'
    && uploadAge !== null && uploadAge < 5 * 60_000) return {
    level: 'ok', headline: 'Repeated background delivery verified',
    subline: `Last verified background coordinate: ${formatAgeMs(uploadAge)}`,
    uploadAgeMs: uploadAge,
  };
  if (last) return {
    level: 'starting', headline: hasRepeated(Infinity) ? 'Background delivery recorded earlier' : 'One background location delivery recorded',
    subline: `Last verified background coordinate: ${formatAgeMs(uploadAge)}; this is not a claim of current tracking health`,
    uploadAgeMs: uploadAge,
  };
  const contact = [lastSeenMs, lastHttpSuccessMs].some(t =>
    typeof t === 'number' && t > 0 && t <= now + 5000 && now - t < 5 * 60_000);
  return {
    level: 'starting',
    headline: 'Background GPS evidence unavailable',
    subline: contact ? 'Device communicating; no retained background GPS proof in this diagnostic window'
      : 'No retained background GPS proof in this diagnostic window; this does not invalidate earlier road tests',
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
  const rev = log.filter(e => e.at > 0 && e.at <= now + CLOCK_SKEW_TOLERANCE_MS)
    .sort((a, b) => b.at - a.at);

  // 1 — Background service: most recent sdk_onEnabledChange.
  //     null → 'unknown' (not yet seen, normal on fresh start — not an error).
  const enabledEvt = rev.find((e) => e.event === 'sdk_onEnabledChange' || e.event === 'sdk_state_observed') ?? null;
  const startup = rev.find(e => e.event === 'startup_outcome')?.detail?.outcome;
  const bgStatus: HealthStatus =
    enabledEvt?.event === 'sdk_state_observed' && now - enabledEvt.at < 60_000
      ? (enabledEvt.detail?.enabled === true ? 'ok' : 'error')
    : startup === 'denied' || startup === 'failed' ? 'error'
    : startup === 'foreground-only' ? 'warn'
    : startup === 'background-ready' && enabledEvt === null ? 'ok'
    : enabledEvt === null             ? 'unknown'
    : enabledEvt.detail?.enabled   ? 'ok'
    : 'error';

  // 2 — Successful location-transport contact, not GPS capture freshness.
  //     Recent success is evidence of contact; old/absent success alone does
  //     not prove a failed upload, stale GPS or a noncommunicating device.
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
    : 'unknown'; // Age alone does not prove a failed upload or broken device.

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
    (e) => e.event === 'sdk_onHeartbeat'
      || (e.event === 'headless_task_invoked' && e.detail?.eventName === 'heartbeat'),
  ) ?? null;
  const hbAge = hbEvt ? now - hbEvt.at : null;
  const uploadRecent = uploadAge !== null && uploadAge < 5 * 60_000;
  const hbStatus: HealthStatus =
    hbAge === null                                  ? 'unknown'
    : hbAge < 2 * 60_000                           ? 'ok'
    : hbAge < 10 * 60_000                          ? 'warn'
    : 'warn'; // HTTP success cannot replace an absent/stale heartbeat.

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
      label:  startup === 'foreground-only' ? 'Background location not authorized — foreground only'
              : startup === 'denied' ? 'Location permission not granted'
              : bgStatus === 'ok'      ? 'Background service running'
              : bgStatus === 'error' ? 'Background service stopped'
              : 'Background service: waiting for first event',
      status: bgStatus,
    },
    {
      icon:   healthIcon(hbStatus),
      label:  hbAge === null
              ? 'Background heartbeat: waiting for first event'
              : (uploadRecent && hbAge >= 10 * 60_000)
                ? `Last background heartbeat: ${formatAgeMs(hbAge)} (upload is not heartbeat evidence)`
                : `Last background heartbeat: ${formatAgeMs(hbAge)}`,
      status: hbStatus,
    },
    {
      icon:   healthIcon(uploadStatus),
      label:  uploadAge === null
               ? 'Location upload: no retained confirmation'
               : `Location upload last confirmed: ${formatAgeMs(uploadAge)}`,
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
