/** GPS evidence is independent of communication and stored motion state. */
export const GPS_STALE_AFTER_MS = 15 * 60_000;
const MAX_CLOCK_SKEW_MS = 5_000;

export function getGpsFreshness(capturedAt: string | null | undefined, nowMs = Date.now()) {
  const at = capturedAt ? new Date(capturedAt).getTime() : NaN;
  if (!Number.isFinite(at) || at > nowMs + MAX_CLOCK_SKEW_MS) {
    return { kind: 'unknown' as const, ageMs: null };
  }
  const ageMs = Math.max(0, nowMs - at);
  return { kind: ageMs >= GPS_STALE_AFTER_MS ? 'stale' as const : 'fresh' as const, ageMs };
}

export function gpsFreshnessBoundaryDelay(capturedAt: string | null | undefined, nowMs = Date.now()): number | null {
  const freshness = getGpsFreshness(capturedAt, nowMs);
  if (freshness.kind !== 'fresh') return null;
  // Include the tolerated small future skew, so the actual boundary is exact.
  return Math.max(1, new Date(capturedAt!).getTime() + GPS_STALE_AFTER_MS - nowMs);
}
