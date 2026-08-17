/**
 * effectiveSnapshotAgeMs.test.ts  — Task #93
 *
 * Unit tests for the pure utilities that drive the Device Comparison table's
 * age columns in app/diagnostics.tsx.
 *
 * Under test:
 *   effectiveSnapshotAgeMs   — effective age = stageAge@push + elapsedSincePush
 *   ageCellColor             — maps an age in ms to the green/amber/red/grey hex
 *   computeSnapshotElapsedMs — how long ago the device_snapshot was pushed
 *
 * Key invariant (Task #93):
 *   With Joyce uploading every ~60 s and the heartbeat pushing a snapshot every
 *   ~60 s, the worst-case effective age for any stage is:
 *     snapshotElapsed (≤ 60 s) + stageAgeAtPush (≤ 60 s) ≤ 120 s
 *   The green threshold is 5 min (300 000 ms), so 120 s is comfortably green.
 *   These tests pin that calculation so a threshold change or arithmetic change
 *   surfaces immediately.
 *
 * No React Native imports — runs in the plain Node test environment.
 */

import {
  effectiveSnapshotAgeMs,
  ageCellColor,
  computeSnapshotElapsedMs,
} from '../deviceComparisonUtils';

// ─── Constants used across tests ─────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 60_000;  // SDK heartbeat cadence
const UPLOAD_INTERVAL_MS    = 60_000;  // Joyce's nominal upload cadence

const WARN_MS = 5  * 60_000;  // 300 000 ms — green→amber boundary
const CRIT_MS = 15 * 60_000;  // 900 000 ms — amber→red   boundary

const NOW = 1_700_000_000_000; // fixed epoch ms for deterministic tests

// ─── effectiveSnapshotAgeMs ───────────────────────────────────────────────────

describe('effectiveSnapshotAgeMs', () => {

  // ── 1. Fresh snapshot, fresh stage ──────────────────────────────────────────
  it('returns a small positive value for a fresh snapshot with a fresh stage field', () => {
    // Snapshot was pushed 5 s ago; the stage was 3 s old at push time.
    const snapshotPushedAt = new Date(NOW - 5_000).toISOString();
    const stageAgeAtPush   = 3_000; // ms

    const result = effectiveSnapshotAgeMs(snapshotPushedAt, undefined, NOW, stageAgeAtPush);

    expect(result).not.toBeNull();
    expect(result).toBe(8_000); // 5 000 + 3 000
  });

  // ── 2. Worst-case heartbeat boundary — must stay green ──────────────────────
  it('stays within the green threshold at the worst-case 60s+60s heartbeat boundary', () => {
    // Both cycles are at their maximum: snapshot was pushed exactly one
    // heartbeat ago, and the stage was exactly one upload-cycle old at push.
    const snapshotPushedAt = new Date(NOW - HEARTBEAT_INTERVAL_MS).toISOString();
    const stageAgeAtPush   = UPLOAD_INTERVAL_MS;

    const result = effectiveSnapshotAgeMs(snapshotPushedAt, undefined, NOW, stageAgeAtPush);

    // Effective age = 60 000 + 60 000 = 120 000 ms (2 min)
    expect(result).toBe(120_000);

    // Must render green — well inside the 5-min warn threshold
    const color = ageCellColor(result, WARN_MS, CRIT_MS);
    expect(color).toBe('#10B981');
    expect(result).toBeLessThan(WARN_MS);
  });

  // ── 3. Snapshot older than one full cycle — must turn amber ─────────────────
  it('turns amber when the snapshot is older than one cycle and the stage is also stale', () => {
    // Snapshot pushed 4 min ago; stage was 2 min old at push → total 6 min → amber.
    const snapshotPushedAt = new Date(NOW - 4 * 60_000).toISOString();
    const stageAgeAtPush   = 2 * 60_000;

    const result = effectiveSnapshotAgeMs(snapshotPushedAt, undefined, NOW, stageAgeAtPush);

    expect(result).toBe(6 * 60_000); // 360 000 ms

    const color = ageCellColor(result, WARN_MS, CRIT_MS);
    expect(color).toBe('#F59E0B'); // amber
    expect(result).toBeGreaterThanOrEqual(WARN_MS);
    expect(result).toBeLessThan(CRIT_MS);
  });

  // ── 4. Snapshot extremely stale — must turn red ──────────────────────────────
  it('turns red when the effective age exceeds the 15-min crit threshold', () => {
    const snapshotPushedAt = new Date(NOW - 10 * 60_000).toISOString();
    const stageAgeAtPush   = 6 * 60_000;

    const result = effectiveSnapshotAgeMs(snapshotPushedAt, undefined, NOW, stageAgeAtPush);

    expect(result).toBe(16 * 60_000);

    const color = ageCellColor(result, WARN_MS, CRIT_MS);
    expect(color).toBe('#EF4444'); // red
    expect(result).toBeGreaterThanOrEqual(CRIT_MS);
  });

  // ── 5. Missing device_snapshot — must return null (renders "—") ─────────────
  it('returns null when both snapshotAt and snapshotStoredAt are absent', () => {
    const result = effectiveSnapshotAgeMs(undefined, undefined, NOW, 30_000);
    expect(result).toBeNull();
  });

  it('returns null when snapshotAt is null', () => {
    const result = effectiveSnapshotAgeMs(null, null, NOW, 30_000);
    expect(result).toBeNull();
  });

  // ── 6. Missing stageAgeMs — must return null ─────────────────────────────────
  it('returns null when stageAgeMs is undefined', () => {
    const snapshotPushedAt = new Date(NOW - 5_000).toISOString();
    const result = effectiveSnapshotAgeMs(snapshotPushedAt, undefined, NOW, undefined);
    expect(result).toBeNull();
  });

  it('returns null when stageAgeMs is null', () => {
    const snapshotPushedAt = new Date(NOW - 5_000).toISOString();
    const result = effectiveSnapshotAgeMs(snapshotPushedAt, undefined, NOW, null);
    expect(result).toBeNull();
  });

  // ── 7. Falls back to stored_at when at is absent ────────────────────────────
  it('uses snapshotStoredAt as a fallback when snapshotAt is absent', () => {
    const storedAt       = new Date(NOW - 10_000).toISOString();
    const stageAgeAtPush = 5_000;

    const result = effectiveSnapshotAgeMs(undefined, storedAt, NOW, stageAgeAtPush);

    expect(result).toBe(15_000); // 10 000 + 5 000
  });

  // ── 8. Accepts numeric epoch ms in addition to ISO strings ──────────────────
  it('accepts a numeric epoch timestamp for snapshotAt', () => {
    const snapshotPushedAt = NOW - 20_000; // numeric
    const stageAgeAtPush   = 10_000;

    const result = effectiveSnapshotAgeMs(snapshotPushedAt, undefined, NOW, stageAgeAtPush);

    expect(result).toBe(30_000);
  });

  // ── 9. Exact green boundary (WARN_MS - 1 ms) ────────────────────────────────
  it('is still green at exactly one millisecond below the warn threshold', () => {
    const effectiveAge = WARN_MS - 1;
    const snapshotPushedAt = NOW - Math.floor(effectiveAge / 2);
    const stageAgeAtPush   = Math.ceil(effectiveAge / 2);

    const result = effectiveSnapshotAgeMs(snapshotPushedAt, undefined, NOW, stageAgeAtPush);
    expect(result).toBe(effectiveAge);

    const color = ageCellColor(result, WARN_MS, CRIT_MS);
    expect(color).toBe('#10B981');
  });

  // ── 10. Exact warn boundary (WARN_MS) — first amber millisecond ─────────────
  it('is amber at exactly the warn threshold', () => {
    const color = ageCellColor(WARN_MS, WARN_MS, CRIT_MS);
    expect(color).toBe('#F59E0B');
  });
});

// ─── ageCellColor ─────────────────────────────────────────────────────────────

describe('ageCellColor', () => {
  it('returns grey for null', () => {
    expect(ageCellColor(null)).toBe('#9CA3AF');
  });

  it('returns grey for undefined', () => {
    expect(ageCellColor(undefined)).toBe('#9CA3AF');
  });

  it('returns grey for NaN', () => {
    expect(ageCellColor(NaN)).toBe('#9CA3AF');
  });

  it('returns green for 0 ms', () => {
    expect(ageCellColor(0)).toBe('#10B981');
  });

  it('returns green for a fresh age well below warn', () => {
    expect(ageCellColor(120_000)).toBe('#10B981'); // 2 min
  });

  it('returns green for WARN_MS - 1', () => {
    expect(ageCellColor(WARN_MS - 1, WARN_MS, CRIT_MS)).toBe('#10B981');
  });

  it('returns amber for exactly WARN_MS', () => {
    expect(ageCellColor(WARN_MS, WARN_MS, CRIT_MS)).toBe('#F59E0B');
  });

  it('returns amber for CRIT_MS - 1', () => {
    expect(ageCellColor(CRIT_MS - 1, WARN_MS, CRIT_MS)).toBe('#F59E0B');
  });

  it('returns red for exactly CRIT_MS', () => {
    expect(ageCellColor(CRIT_MS, WARN_MS, CRIT_MS)).toBe('#EF4444');
  });

  it('returns red for an age far above crit', () => {
    expect(ageCellColor(60 * 60_000, WARN_MS, CRIT_MS)).toBe('#EF4444'); // 1 hour
  });
});

// ─── computeSnapshotElapsedMs ─────────────────────────────────────────────────

describe('computeSnapshotElapsedMs', () => {
  it('returns null when both at and stored_at are absent', () => {
    expect(computeSnapshotElapsedMs(undefined, undefined, NOW)).toBeNull();
    expect(computeSnapshotElapsedMs(null, null, NOW)).toBeNull();
  });

  it('computes elapsed correctly from an ISO string snapshotAt', () => {
    const pushedAt = new Date(NOW - 45_000).toISOString();
    expect(computeSnapshotElapsedMs(pushedAt, undefined, NOW)).toBe(45_000);
  });

  it('falls back to snapshotStoredAt when snapshotAt is absent', () => {
    const storedAt = new Date(NOW - 30_000).toISOString();
    expect(computeSnapshotElapsedMs(undefined, storedAt, NOW)).toBe(30_000);
  });

  it('prefers snapshotAt over snapshotStoredAt', () => {
    const at       = new Date(NOW - 10_000).toISOString();
    const storedAt = new Date(NOW - 50_000).toISOString();
    expect(computeSnapshotElapsedMs(at, storedAt, NOW)).toBe(10_000);
  });

  it('accepts a numeric epoch ms for snapshotAt', () => {
    expect(computeSnapshotElapsedMs(NOW - 7_000, undefined, NOW)).toBe(7_000);
  });

  it('returns null for an unparseable string', () => {
    expect(computeSnapshotElapsedMs('not-a-date', undefined, NOW)).toBeNull();
  });
});
