/** Operational recovery evidence: keep independent of user-facing display ages. */
export const GPS_STALE_AFTER_MS = 15 * 60_000;
/** Display-only thresholds; these never control GPS acquisition or recovery. */
export const GPS_DISPLAY_NEUTRAL_AFTER_MS = 30 * 60_000;
export const GPS_DISPLAY_OUTDATED_AFTER_MS = 60 * 60_000;
const MAX_CLOCK_SKEW_MS = 5_000;

export function getGpsFreshness(capturedAt: string | null | undefined, nowMs = Date.now()) {
  const at = capturedAt ? new Date(capturedAt).getTime() : NaN;
  if (!Number.isFinite(at) || at > nowMs + MAX_CLOCK_SKEW_MS) {
    return { kind: 'unknown' as const, ageMs: null };
  }
  const ageMs = Math.max(0, nowMs - at);
  const kind = ageMs >= GPS_DISPLAY_OUTDATED_AFTER_MS ? 'stale' as const
    : ageMs >= GPS_DISPLAY_NEUTRAL_AFTER_MS ? 'neutral' as const : 'fresh' as const;
  return { kind, ageMs };
}

export function gpsFreshnessBoundaryDelay(capturedAt: string | null | undefined, nowMs = Date.now()): number | null {
  const freshness = getGpsFreshness(capturedAt, nowMs);
  if (freshness.kind === 'unknown' || freshness.kind === 'stale') return null;
  const threshold = freshness.kind === 'fresh'
    ? GPS_DISPLAY_NEUTRAL_AFTER_MS : GPS_DISPLAY_OUTDATED_AFTER_MS;
  // Include the tolerated small future skew, so the actual boundary is exact.
  return Math.max(1, new Date(capturedAt!).getTime() + threshold - nowMs);
}
