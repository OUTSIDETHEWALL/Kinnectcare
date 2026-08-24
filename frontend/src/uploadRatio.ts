import type { EngineLogEvent } from './locationEngine';

export type UploadRatio = {
  total: number;
  ok: number;
  fail: number;
  lastFailStatus: number | string | null;
};

/**
 * Summarize the upload attempts represented in the engine ring buffer.
 *
 * Each upload path emits one sdk_onHttp event, so named foreground/headless
 * events must not be counted here or the same upload would be counted twice.
 */
export function computeUploadRatio(engineLog: EngineLogEvent[]): UploadRatio {
  const httpEvents = engineLog.filter((e) => e.event === 'sdk_onHttp');
  const ok = httpEvents.filter((e) => e.detail?.success === true).length;
  const fail = httpEvents.filter((e) => e.detail?.success === false).length;
  const total = httpEvents.length;
  const lastFailEvt = [...httpEvents].reverse().find(
    (e) => e.detail?.success === false,
  ) ?? null;

  return {
    total,
    ok,
    fail,
    lastFailStatus: lastFailEvt?.detail?.status ?? null,
  };
}