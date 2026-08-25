import { computeHealthItems } from './healthCheck';
import type { EngineLogEvent, PipelineTimestamps } from './locationEngine';

/**
 * Diagnostics' health-items selector.
 *
 * Keep the pipeline timestamp extraction here so the detail panel and its
 * regression tests share the same call-site contract.
 */
export function computeDiagnosticsHealthItems(
  engineLog: EngineLogEvent[],
  nowTick: number,
  pipelineTs: PipelineTimestamps | null,
) {
  return computeHealthItems(engineLog, nowTick, pipelineTs?.http_success ?? null);
}