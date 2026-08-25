/**
 * Regression guard for the Diagnostics health-items recovery call site.
 *
 * The upload row is derived from computeHealthItems(), separately from the
 * Diagnostics hero card.  This test mirrors the useMemo call in
 * app/diagnostics.tsx so a future change cannot silently drop
 * pipelineTs?.http_success from the detail-row calculation.
 */

import { computeDiagnosticsHealthItems } from '../diagnosticsHealthItems';
import type { EngineLogEvent, PipelineTimestamps } from '../locationEngine';

let seq = 0;

function makeEvent(
  event: string,
  atMs: number,
  detail?: Record<string, unknown>,
): EngineLogEvent {
  seq += 1;
  return { seq, src: 'engine', at: atMs, event, detail };
}

/** Simulate the ring buffer after a burst of failed upload attempts. */
function failureBuffer(count: number, now: number): EngineLogEvent[] {
  return Array.from({ length: count }, (_, index) =>
    makeEvent('sdk_onHttp', now - (count - index) * 10_000, { success: false }),
  );
}

describe('Diagnostics health-items upload row — failure burst then recovery', () => {
  beforeEach(() => {
    seq = 0;
  });

  const NOW = 12_000_000;

  it('shows the upload row as ok with a recent pipelineTs success timestamp', () => {
    const engineLog = failureBuffer(50, NOW);
    const pipelineTs: PipelineTimestamps = {
      http_success: NOW - 2 * 60_000,
      motion: null,
      activity: null,
      location: null,
      heartbeat_js: null,
      headless_invoked: null,
      headless_heartbeat: null,
      headless_battery: null,
      http_attempt: null,
      listeners_attached: null,
    };

    // This is the exact selector used by the healthItems useMemo in
    // diagnostics.tsx.
    const items = computeDiagnosticsHealthItems(
      engineLog,
      NOW,
      pipelineTs,
    );
    const uploadItem = items.find((item) => item.label.includes('Last location uploaded'));

    expect(uploadItem).toBeDefined();
    expect(uploadItem?.status).toBe('ok');
    expect(uploadItem?.icon).toBe('✅');
  });

  it('keeps the upload row honest as unknown when pipelineTs is absent', () => {
    const engineLog = failureBuffer(50, NOW);
    const pipelineTs = null as PipelineTimestamps | null;

    // Before reload() supplies pipeline timestamps, the selector used by
    // diagnostics.tsx must not invent a successful upload.
    const items = computeDiagnosticsHealthItems(
      engineLog,
      NOW,
      pipelineTs,
    );
    const uploadItem = items.find((item) =>
      item.label.includes('Location upload: waiting for first upload'),
    );

    expect(uploadItem).toBeDefined();
    expect(uploadItem?.status).toBe('unknown');
    expect(uploadItem?.icon).toBe('ℹ️');
  });
});