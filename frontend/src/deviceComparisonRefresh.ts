/**
 * Starts the auto-refresh interval for the Device Comparison section.
 *
 * Called from the Diagnostics screen useEffect:
 *
 *   useEffect(
 *     () => startDeviceComparisonRefresh(!!expanded['device-comparison'], fetchFamilySnapshot),
 *     [expanded['device-comparison'], fetchFamilySnapshot],
 *   );
 *
 * Contract
 * ─────────
 * • isExpanded=false  → no-op; returns undefined (React "no cleanup needed" path).
 * • isExpanded=true   → schedules fetchFamilySnapshot every
 *   DEVICE_COMPARISON_INTERVAL_MS.  Returns a cleanup that clears the interval
 *   when the section is collapsed or the component unmounts.
 *
 * Errors from fetchFamilySnapshot are swallowed here; the Device Comparison
 * section renders its own error state from the familySnapshot.err field.
 *
 * @param isExpanded          Current value of expanded['device-comparison'].
 * @param fetchFamilySnapshot The callback that fetches the latest snapshot.
 * @returns A cleanup function (clearInterval wrapper) if the interval was
 *          started, or `undefined` if the section is collapsed.
 */
export function startDeviceComparisonRefresh(
  isExpanded: boolean,
  fetchFamilySnapshot: () => Promise<void>,
): (() => void) | undefined {
  if (!isExpanded) return undefined;

  const tick = setInterval(() => {
    fetchFamilySnapshot().catch(() => {
      // Swallow — fetchFamilySnapshot sets its own error state on the component.
    });
  }, DEVICE_COMPARISON_INTERVAL_MS);

  return () => clearInterval(tick);
}

/** How often the Device Comparison table is re-fetched while expanded (ms). */
export const DEVICE_COMPARISON_INTERVAL_MS = 60_000;
