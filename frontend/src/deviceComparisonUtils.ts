/**
 * deviceComparisonUtils.ts
 *
 * Pure utility functions for the Device Comparison table
 * (app/diagnostics.tsx — "Device Comparison" CollapsibleSection).
 *
 * Extracted here so they can be unit-tested without importing
 * any React Native modules.
 */

// ─── Age colour picker ────────────────────────────────────────────────────────

/**
 * Returns the hex colour that the Device Comparison table uses for an age.
 *
 *   • null / undefined / non-finite → grey  (#9CA3AF)  — no data
 *   • < warnMs                      → green (#10B981)  — healthy
 *   • < critMs                      → amber (#F59E0B)  — degraded
 *   • ≥ critMs                      → red   (#EF4444)  — stale
 *
 * Default thresholds match the ageCell() helper inside the component:
 *   warn = 5 min, crit = 15 min.
 */
export function ageCellColor(
  ageMs: number | null | undefined,
  warnMs = 5 * 60_000,
  critMs = 15 * 60_000,
): string {
  if (ageMs === null || ageMs === undefined || !Number.isFinite(ageMs)) {
    return '#9CA3AF'; // grey — no data
  }
  if (ageMs < warnMs) return '#10B981'; // green
  if (ageMs < critMs) return '#F59E0B'; // amber
  return '#EF4444';                     // red
}

// ─── Snapshot elapsed time ────────────────────────────────────────────────────

/**
 * Returns how many milliseconds have elapsed since the device_snapshot was
 * pushed to the backend, measured from `nowMs`.
 *
 * Accepts either the `at` or `stored_at` field that the backend sets on
 * the snapshot document.  Returns null when no timestamp is available or
 * when the ISO-string cannot be parsed.
 */
export function computeSnapshotElapsedMs(
  snapshotAt: string | number | null | undefined,
  snapshotStoredAt: string | number | null | undefined,
  nowMs: number,
): number | null {
  const raw = snapshotAt ?? snapshotStoredAt;
  if (raw === null || raw === undefined) return null;
  try {
    const ts = typeof raw === 'number' ? raw : new Date(raw).getTime();
    if (!Number.isFinite(ts)) return null;
    return nowMs - ts;
  } catch {
    return null;
  }
}

// ─── Effective snapshot age ───────────────────────────────────────────────────

/**
 * Effective age of a pipeline stage as seen RIGHT NOW.
 *
 * All `*_age_ms` values stored inside `device_snapshot` represent the age of
 * the stage AT THE MOMENT the snapshot was pushed — not "now".  To get the
 * current age you must add how long ago the snapshot was pushed:
 *
 *   effectiveAge = stageAgeAtSnapshotPush + elapsedSinceSnapshotPush
 *
 * Returns null when either component is missing (the table renders "—").
 *
 * @param snapshotAt        ISO string or epoch ms from `device_snapshot.at`
 * @param snapshotStoredAt  ISO string or epoch ms from `device_snapshot.stored_at` (fallback)
 * @param nowMs             Current epoch ms (pass `Date.now()` or the `nowTick` state value)
 * @param stageAgeMs        Age of the stage at snapshot-push time (e.g. `device_snapshot.http_ok_age_ms`)
 */
export function effectiveSnapshotAgeMs(
  snapshotAt: string | number | null | undefined,
  snapshotStoredAt: string | number | null | undefined,
  nowMs: number,
  stageAgeMs: number | null | undefined,
): number | null {
  if (stageAgeMs === null || stageAgeMs === undefined) return null;
  const elapsed = computeSnapshotElapsedMs(snapshotAt, snapshotStoredAt, nowMs);
  if (elapsed === null) return null;
  return elapsed + stageAgeMs;
}

// ─── HTTP-ok row presentation model ──────────────────────────────────────────

/**
 * Returns the hex colour for the "HTTP success (device)" row in the Device
 * Comparison table.
 *
 * This is the extracted presentation model for that row.  `app/diagnostics.tsx`
 * calls it as:
 *
 *   httpOkCellColor(member, nowTick)
 *
 * where `nowTick` is the component's 1-second state clock.  The explicit `nowMs`
 * parameter makes the dependency on the live clock testable: a test that advances
 * `nowMs` from T+0 to T+5min verifies the colour transitions from green → amber
 * without mounting the full screen.
 *
 * Effective age formula:
 *   http_ok_age_at_snapshot_push + elapsed_since_snapshot_push
 *
 * Thresholds (match `ageCell()` defaults in diagnostics.tsx):
 *   green  < 5 min (300 000 ms)
 *   amber  5 – 15 min
 *   red    ≥ 15 min (900 000 ms)
 *   grey   null / no data
 *
 * @param member  A member object from the family-snapshot API response.
 * @param nowMs   Current epoch ms — pass `nowTick` state from the component.
 */
export function httpOkCellColor(member: { device_snapshot?: any } | null | undefined, nowMs: number): string {
  const ds = member?.device_snapshot;
  const ageMs = effectiveSnapshotAgeMs(
    ds?.at,
    ds?.stored_at,
    nowMs,
    ds?.http_ok_age_ms,
  );
  return ageCellColor(ageMs, 5 * 60_000, 15 * 60_000);
}
