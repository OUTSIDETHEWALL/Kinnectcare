export type BatteryDisplay = {
  statusText: string;
  ageLabel: string;
  tone: 'charging' | 'low' | 'ok';
};

export type BatteryCondition = 'critical' | 'low' | null;

function formatBatteryAge(
  isoString: string | null | undefined,
  nowMs: number,
): string | null {
  if (!isoString) return null;
  try {
    const ms = nowMs - new Date(isoString).getTime();
    if (!Number.isFinite(ms)) return null;
    if (ms < 0) return 'just now';
    const seconds = Math.round(ms / 1000);
    if (seconds < 10) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  } catch {
    return null;
  }
}

function batteryAgeLabel(
  updatedAt: string | null | undefined,
  nowMs: number,
): string {
  const age = formatBatteryAge(updatedAt, nowMs);
  return age ? `Updated ${age}` : 'Last update unknown';
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
  freshness: 'current' | 'last-known' = 'current',
  condition: BatteryCondition = null,
  nowMs: number = Date.now(),
): BatteryDisplay | null {
  if (batteryLevel == null) return null;

  const pct = Math.round(batteryLevel * 100);
  const isLastKnown = freshness === 'last-known';
  if (condition === 'critical' || condition === 'low') {
    const label = condition === 'critical' ? 'Battery Critical' : 'Battery Low';
    return {
      statusText: isLastKnown
        ? `${label} · last known ${pct}%${isCharging ? ' · was charging' : ''}`
        : `${label} · ${pct}%${isCharging ? ' · Charging' : ''}`,
      ageLabel: batteryAgeLabel(updatedAt, nowMs),
      tone: 'low',
    };
  }

  if (isCharging) {
    return {
      statusText: isLastKnown
        ? `Last known battery: ${pct}% · was charging`
        : `Charging · ${pct}%`,
      ageLabel: batteryAgeLabel(updatedAt, nowMs),
      tone: isLastKnown ? 'ok' : 'charging',
    };
  }

  if (isLastKnown) {
    return {
      statusText: `Last known battery: ${pct}%`,
      ageLabel: batteryAgeLabel(updatedAt, nowMs),
      tone: 'ok',
    };
  }

  return {
    statusText: `Battery ${pct}%`,
    ageLabel: batteryAgeLabel(updatedAt, nowMs),
    tone: 'ok',
  };
}