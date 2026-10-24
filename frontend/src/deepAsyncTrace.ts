/**
 * Observation only: never await this recorder, never put secrets in its metadata.
 * Native code timestamps/enqueues; serialization, retention and disk IO are off-path.
 */
import type { RequestOrigin } from './requestOrigin';
type Trace = RequestOrigin & { asyncRequest?: string; flight?: string };
type Meta = { endpoint?: string; flight?: string; count?: number; reason?: string; eligible?: boolean };
type Native = {
  deepRecord?: (kind: string, id: string, stage: string, detail: string) => void;
  deepRead?: () => string;
  deepBodyBind?: (blob: string, request: string) => void;
};
let native: Native | null | undefined;
const runtime = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
function recorder(): Native | null {
  if (native !== undefined) return native;
  try { native = require('expo').requireOptionalNativeModule?.('StartupDiagnostics') ?? null; }
  catch { native = null; }
  return native ?? null;
}
export const diagnosticId = () => Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
export function deepStage(context: Trace | undefined, stage: string, meta: Meta = {}): void {
  try {
    if (!context) return;
    const id = context.asyncRequest ?? context.operation;
    recorder()?.deepRecord?.(context.asyncRequest ? 'request' : 'operation', id, stage,
      JSON.stringify({ operation: context.operation, origin: context.origin, phase: context.phase, runtime,
        wake: context.wake, generation: context.generation, request: context.asyncRequest, flight: context.flight, ...meta }));
  } catch { /* observer failure never changes application behavior */ }
}
export function flightStage(id: string, stage: string, context?: Trace, count?: number): void {
  try { recorder()?.deepRecord?.('flight', id, stage, JSON.stringify({
    operation: context?.operation, wake: context?.wake, origin: context?.origin, count,
  })); } catch {}
}
export function readDeepAsyncTrace(): unknown {
  try { return JSON.parse(recorder()?.deepRead?.() ?? '{"available":false}'); }
  catch { return { available: false, reason: 'observer_read_failed' }; }
}
// Dependency hooks call this at existing callbacks, never via an extra Promise.
const target = globalThis as typeof globalThis & {
  __kinnshipAsyncStage?: (request: string, stage: string, blob?: string) => void;
};
target.__kinnshipAsyncStage = (request, stage, blob) => {
  try {
    if (!/^[a-f0-9]{32}$/.test(request ?? '')) return;
    if (blob) recorder()?.deepBodyBind?.(blob, request);
    recorder()?.deepRecord?.('request', request, stage, '{}');
  } catch {}
};
