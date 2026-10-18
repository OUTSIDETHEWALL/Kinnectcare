let active = false;

/** Synchronous and process-wide: covers capture, file creation and native sheet. */
export function beginDiagnosticsExport(): (() => void) | null {
  if (active) return null;
  active = true;
  let released = false;
  return () => {
    if (!released) { released = true; active = false; }
  };
}
