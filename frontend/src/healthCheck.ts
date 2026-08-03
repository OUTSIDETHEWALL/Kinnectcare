/**
 * healthCheck.ts — shared health-status computation used by both the
 * Diagnostics screen (full panel) and the Me tab (compact indicator).
 *
 * Extracted so neither screen duplicates the logic.
 */
import { EngineLogEvent } from './locationEngine';

export type HealthStatus = 'ok' | 'warn' | 'error' | 'unknown';
export type HealthItem = { icon: string; label: string; status: HealthStatus };

export function healthIcon(s: HealthStatus): string {
  if (s === 'ok')   return '✅';
  if (s === 'warn') return '⚠️';
  if (s === 'error') return '❌';
  return '⚪';
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

  // 1 — Background service: most recent sdk_onEnabledChange
  const enabledEvt = rev.find((e) => e.event === 'sdk_onEnabledChange') ?? null;
  const bgStatus: HealthStatus =
    enabledEvt === null ? 'unknown'
    : enabledEvt.detail?.enabled ? 'ok'
    : 'error';

  // 2 — Last heartbeat: sdk_onHeartbeat or headless_task_invoked
  //     ✅ < 2 min  ⚠ 2–10 min  ❌ > 10 min / no entry
  const hbEvt = rev.find(
    (e) => e.event === 'sdk_onHeartbeat' || e.event === 'headless_task_invoked',
  ) ?? null;
  const hbAge = hbEvt ? now - hbEvt.at : null;
  const hbStatus: HealthStatus =
    hbAge === null         ? 'error'
    : hbAge < 2 * 60_000  ? 'ok'
    : hbAge < 10 * 60_000 ? 'warn'
    : 'error';

  // 3 — Last location upload: sdk_onHttp with success=true
  //     ✅ < 5 min  ⚠ 5–15 min  ❌ > 15 min / no entry
  const uploadEvt = rev.find(
    (e) => e.event === 'sdk_onHttp' && e.detail?.success === true,
  ) ?? null;
  const uploadAge = uploadEvt ? now - uploadEvt.at : null;
  const uploadStatus: HealthStatus =
    uploadAge === null          ? 'error'
    : uploadAge < 5 * 60_000   ? 'ok'
    : uploadAge < 15 * 60_000  ? 'warn'
    : 'error';

  // 4 — Battery listener: battery_listeners_attached event present
  const battListenerEvt = rev.find((e) => e.event === 'battery_listeners_attached') ?? null;
  const battStatus: HealthStatus = battListenerEvt ? 'ok' : 'unknown';

  // 5 — Power Saver: most recent sdk_onPowerSaveChange
  //     ✅ isPowerSaveMode=false  ❌ isPowerSaveMode=true  ⚪ no entry
  const powerEvt = rev.find((e) => e.event === 'sdk_onPowerSaveChange') ?? null;
  const powerStatus: HealthStatus =
    powerEvt === null                  ? 'unknown'
    : powerEvt.detail?.isPowerSaveMode ? 'error'
    : 'ok';

  return [
    {
      icon:  healthIcon(bgStatus),
      label: bgStatus === 'ok'      ? 'Background service running'
             : bgStatus === 'error' ? 'Background service stopped'
             : 'Background service: no data yet',
      status: bgStatus,
    },
    {
      icon:  healthIcon(hbStatus),
      label: `Last heartbeat: ${hbAge === null ? 'none recorded' : formatAgeMs(hbAge)}`,
      status: hbStatus,
    },
    {
      icon:  healthIcon(uploadStatus),
      label: `Last location upload: ${uploadAge === null ? 'none recorded' : formatAgeMs(uploadAge)}`,
      status: uploadStatus,
    },
    {
      icon:  healthIcon(battStatus),
      label: battStatus === 'ok' ? 'Battery listener active' : 'Battery listener: not confirmed',
      status: battStatus,
    },
    {
      icon:  healthIcon(powerStatus),
      label: powerStatus === 'ok'      ? 'Power Saver off'
             : powerStatus === 'error' ? 'Power Saver detected'
             : 'Power Saver: no data yet',
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
