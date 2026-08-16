/**
 * Device Comparison auto-refresh helper.
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
 * • isExpanded=false  → no-op; returns an empty cleanup so the effect always
 *   returns a valid cleanup function.
 * • isExpanded=true   → fires fetchFn() immediately (so the table is fresh the
 *   moment the user opens the section), then schedules it every 60 seconds (one
 *   full Transistor SDK heartbeat cycle).  Returns a cleanup that clears the
 *   interval when the section is collapsed or the component unmounts.
 *
 * Errors from fetchFn are swallowed here; the Device Comparison section
 * renders its own error state from the familySnapshot.err field.
 */
export function startDeviceComparisonRefresh(
  isExpanded: boolean,
  fetchFn: () => Promise<void>,
): () => void {
  if (!isExpanded) return () => {};

  // Fire immediately so the panel doesn't show stale data while the first
  // 60-second tick is still counting down.
  fetchFn().catch(() => {});

  const id = setInterval(() => {
    fetchFn().catch(() => {});
  }, 60_000);

  return () => clearInterval(id);
}
