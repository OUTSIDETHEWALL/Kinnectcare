/**
 * Build 78 passive observers. Prebound by the existing deep observer; no module
 * initialization, JSON, tasks, timers or network on a scheduling producer.
 */
type Native = {
  schedulingBegin?: (request: string, operation: string, flight: string, js: string, kind: number) => number;
  schedulingEnd?: (registration: number, handle: number) => void;
  schedulingCallback?: (registration: number) => void;
  schedulingProgress?: (category: number) => void;
  schedulingRead?: () => string;
};
type Context = { operation: string; flight?: string; asyncRequest?: string };
let native: Native | null = null;
const contexts = new Map<string, Context>();
let runtime = '';
let contextDrops = 0;
let unboundSchedules = 0;
export function bindSchedulingObserver(value: Native | null, js: string): void {
  native = value; runtime = js;
}
export function rememberSchedulingContext(context: Context, stage: string): void {
  if (!context.asyncRequest) return;
  if (stage === 'helper_entered') {
    if (contexts.size < 128) contexts.set(context.asyncRequest, context);
    else contextDrops++;
  }
  if (stage === 'helper_exited') contexts.delete(context.asyncRequest);
}
export function timerBegin(request: string | undefined, kind: number): number {
  try {
    if (!request) return 0;
    const context = contexts.get(request);
    if (!context) { unboundSchedules++; return 0; }
    const bridgeless = (globalThis as typeof globalThis & { RN$Bridgeless?: boolean }).RN$Bridgeless === true;
    return native?.schedulingBegin?.(request, context.operation, context.flight ?? '', runtime,
      kind | (bridgeless ? 256 : 0)) ?? 0;
  } catch { return 0; }
}
export function timerEnd(registration: number, handle: number): void {
  try { if (registration) native?.schedulingEnd?.(registration, handle); } catch {}
}
export function timerCallback(registration: number): void {
  try { if (registration > 0) native?.schedulingCallback?.(registration); } catch {}
}
export function naturalJsProgress(category: number): void {
  try { native?.schedulingProgress?.(category); } catch {}
}
export function readSchedulingTrace(): unknown {
  try { return { ...JSON.parse(native?.schedulingRead?.() ?? '{"available":false,"schema":78}'),
    jsContextDrops: contextDrops, jsUnboundSchedules: unboundSchedules }; }
  catch { return { available: false, schema: 78, reason: 'read_failed' }; }
}
const target = globalThis as typeof globalThis & {
  __kinnshipTimerBegin?: typeof timerBegin;
  __kinnshipTimerEnd?: typeof timerEnd;
  __kinnshipTimerCallback?: typeof timerCallback;
};
target.__kinnshipTimerBegin = timerBegin;
target.__kinnshipTimerEnd = timerEnd;
target.__kinnshipTimerCallback = timerCallback;
