/**
 * deviceComparisonAutoRefresh.test.ts  — Task #89
 *
 * Verifies that the Device Comparison table's 60-second auto-refresh
 * interval behaves correctly across the full expand/collapse/re-expand
 * lifecycle.
 *
 * Under test:  startDeviceComparisonRefresh  (src/deviceComparisonRefresh.ts)
 * Used by:     DiagnosticsScreen's Task #52 useEffect (app/diagnostics.tsx)
 *
 * The function is the exact body that DiagnosticsScreen's useEffect
 * delegates to — so these tests have direct linkage to the production
 * interval logic.  If the function is deleted, its interval value changes,
 * or its early-return branch is broken, these tests fail.
 *
 * The function mirrors a React useEffect body:
 *   • When isExpanded=false: returns undefined (React no-op cleanup path).
 *   • When isExpanded=true:  starts a setInterval and returns the clearInterval
 *     wrapper that React calls on effect teardown.
 *
 * Tests drive the lifecycle with Jest fake timers:
 *   expand → tick fires every 60 s
 *   collapse (invoke cleanup) → ticks stop
 *   re-expand → new interval starts from zero, ticks resume
 *
 * No React Native modules are imported; the suite runs in the plain Node
 * test environment configured by jest.config.js.
 */

import {
  startDeviceComparisonRefresh,
  DEVICE_COMPARISON_INTERVAL_MS,
} from '../deviceComparisonRefresh';

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('startDeviceComparisonRefresh — Device Comparison interval lifecycle', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ── Test 1 ──────────────────────────────────────────────────────────────────
  it('fires fetchFamilySnapshot exactly once after DEVICE_COMPARISON_INTERVAL_MS while expanded', () => {
    const fetchFamilySnapshot = jest.fn().mockResolvedValue(undefined);

    // Simulate the useEffect running with the section expanded
    const cleanup = startDeviceComparisonRefresh(true, fetchFamilySnapshot);

    // setInterval — should not have fired yet at t=0
    expect(fetchFamilySnapshot).toHaveBeenCalledTimes(0);

    // Advance just under the interval — still no tick
    jest.advanceTimersByTime(DEVICE_COMPARISON_INTERVAL_MS - 1);
    expect(fetchFamilySnapshot).toHaveBeenCalledTimes(0);

    // Reach exactly the interval boundary — first tick
    jest.advanceTimersByTime(1);
    expect(fetchFamilySnapshot).toHaveBeenCalledTimes(1);

    // Advance another full interval — second tick
    jest.advanceTimersByTime(DEVICE_COMPARISON_INTERVAL_MS);
    expect(fetchFamilySnapshot).toHaveBeenCalledTimes(2);

    cleanup?.();
  });

  // ── Test 2 ──────────────────────────────────────────────────────────────────
  it('stops firing after collapse — cleanup clears the interval', () => {
    const fetchFamilySnapshot = jest.fn().mockResolvedValue(undefined);

    // Expand: start the interval
    const cleanup = startDeviceComparisonRefresh(true, fetchFamilySnapshot);

    // Let one tick complete
    jest.advanceTimersByTime(DEVICE_COMPARISON_INTERVAL_MS);
    expect(fetchFamilySnapshot).toHaveBeenCalledTimes(1);

    // Collapse: React calls the cleanup returned by the previous effect run
    cleanup?.();

    // React then re-runs the effect with isExpanded=false — returns undefined (no new interval)
    const noopCleanup = startDeviceComparisonRefresh(false, fetchFamilySnapshot);
    expect(noopCleanup).toBeUndefined();

    // Advance far past multiple cycles — call count must not grow
    jest.advanceTimersByTime(DEVICE_COMPARISON_INTERVAL_MS * 5);
    expect(fetchFamilySnapshot).toHaveBeenCalledTimes(1);
  });

  // ── Test 3 ──────────────────────────────────────────────────────────────────
  it('restarts correctly after re-expand following a collapse', () => {
    const fetchFamilySnapshot = jest.fn().mockResolvedValue(undefined);

    // ── First expansion ──
    const cleanup1 = startDeviceComparisonRefresh(true, fetchFamilySnapshot);
    jest.advanceTimersByTime(DEVICE_COMPARISON_INTERVAL_MS);
    expect(fetchFamilySnapshot).toHaveBeenCalledTimes(1);

    // ── Collapse ──
    cleanup1?.();
    startDeviceComparisonRefresh(false, fetchFamilySnapshot); // no-op path

    // Advance past another cycle while collapsed — nothing should fire
    jest.advanceTimersByTime(DEVICE_COMPARISON_INTERVAL_MS);
    expect(fetchFamilySnapshot).toHaveBeenCalledTimes(1);

    // ── Re-expand ──
    const cleanup2 = startDeviceComparisonRefresh(true, fetchFamilySnapshot);

    // Interval resets from zero — must not fire before DEVICE_COMPARISON_INTERVAL_MS
    jest.advanceTimersByTime(DEVICE_COMPARISON_INTERVAL_MS - 1);
    expect(fetchFamilySnapshot).toHaveBeenCalledTimes(1);

    // Now fires
    jest.advanceTimersByTime(1);
    expect(fetchFamilySnapshot).toHaveBeenCalledTimes(2);

    // And again on the next cycle
    jest.advanceTimersByTime(DEVICE_COMPARISON_INTERVAL_MS);
    expect(fetchFamilySnapshot).toHaveBeenCalledTimes(3);

    cleanup2?.();
  });

  // ── Collapsed-on-mount edge case ─────────────────────────────────────────────
  it('returns undefined and creates no interval when the section starts collapsed', () => {
    const fetchFamilySnapshot = jest.fn().mockResolvedValue(undefined);

    const cleanup = startDeviceComparisonRefresh(false, fetchFamilySnapshot);

    // No interval was created
    expect(cleanup).toBeUndefined();

    // Confirm even after many cycles
    jest.advanceTimersByTime(DEVICE_COMPARISON_INTERVAL_MS * 10);
    expect(fetchFamilySnapshot).toHaveBeenCalledTimes(0);
  });
});
