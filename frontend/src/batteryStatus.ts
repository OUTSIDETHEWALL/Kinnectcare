export type BatteryDisplay = {
  statusText: string;
  ageLabel: string;
  tone: 'charging' | 'low' | 'ok';
};

function formatBatteryAge(isoString: string | null | undefined): string {
  if (!isoString) return '';
  try {
    const ms = Date.now() - new Date(isoString).getTime();
    if (!Number.isFinite(ms) || ms < 0) return '';
    const seconds = Math.round(ms / 1000);
    if (seconds < 10) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  } catch {
    return '';
  }
}

/**
 * Build the caregiver-facing battery row from the last reading.
 *
 * A recorded reading remains visible even when it is old.  The age label gives
 * the caregiver the freshness context; hiding the row after a short stationary
 * period would incorrectly suggest that battery telemetry disappeared.
 */
export function getBatteryDisplay(
  batteryLevel: number | null | undefined,
  isCharging: boolean | null | undefined,
  updatedAt: string | null | undefined,
): BatteryDisplay | null {
  if (batteryLevel == null) return null;

  const pct = Math.round(batteryLevel * 100);
  if (isCharging) {
    return {
      statusText: `🔌 Charging · ${pct}%`,
      ageLabel: updatedAt
        ? `Updated ${formatBatteryAge(updatedAt)}`
        : 'Last update unknown',
      tone: 'charging',
    };
  }

  if (batteryLevel <= 0.20) {
    return {
      statusText: `🔴 ${pct}% · Low`,
      ageLabel: updatedAt
        ? `Updated ${formatBatteryAge(updatedAt)}`
        : 'Last update unknown',
      tone: 'low',
    };
  }

  return {
    statusText: `🟢 ${pct}%`,
    ageLabel: updatedAt
      ? `Updated ${formatBatteryAge(updatedAt)}`
      : 'Last update unknown',
    tone: 'ok',
  };
}