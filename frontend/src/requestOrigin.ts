/**
 * Local-only scope at the synchronous fetch/XHR dispatch boundary. Never hold a
 * global origin across an await: concurrent callers must retain separate parents.
 * The RN source hook reads this scope when allocating its numeric request ID.
 */
type NativeObserver = {
  originVersion?: () => number;
  originBind?: (request: number, detail: string) => void;
  originRecord?: (kind: string, id: string, stage: string, detail: string) => void;
  originRead?: () => string;
};
export type RequestOrigin = {
  operation: string; origin: string; phase?: string; wake?: string | null; generation?: number;
};
const opaqueId = () => Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
const runtime = opaqueId();
let current: RequestOrigin | undefined;
type OriginGlobal = typeof globalThis & {
  __kinnshipBindRequestOrigin?: (request: number) => void;
  __kinnshipTaskSettled?: (wake: string, task: number, reason?: string) => void;
};
function observer(): NativeObserver | null {
  try {
    // Optional methods: older binaries remain usable; no header fallback.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const value = require('expo').requireOptionalNativeModule?.('StartupDiagnostics') as NativeObserver | null;
    return value?.originVersion?.() === 1 ? value : null;
  } catch { return null; }
}
export function requestOriginAvailable(): boolean { return observer() !== null; }
function installBinding(): void {
  const target = globalThis as OriginGlobal;
  if (target.__kinnshipBindRequestOrigin) return;
  target.__kinnshipBindRequestOrigin = request => {
    try {
      const native = observer();
      if (native) native.originBind?.(request, JSON.stringify({
        ...(current ?? { origin: 'unattributed' }), runtime, request: opaqueId(),
      }));
    } catch { /* No observer failure changes dispatch. */ }
  };
  target.__kinnshipTaskSettled = (wake, taskId, reason) => {
    try {
      if (typeof wake === 'string') observer()?.originRecord?.('task', wake, 'js_settled',
        JSON.stringify({ wake, taskId, runtime,
          reason: reason === 'rejected' ? 'rejected' : 'fulfilled' }));
    } catch { /* observation only */ }
  };
}
export function operationOrigin(origin: string, wake?: string | null, generation?: number): RequestOrigin {
  installBinding();
  const context = { operation: opaqueId(), origin, wake, generation };
  originEvent(context, 'created');
  return context;
}
export function originEvent(context: RequestOrigin, stage: string): void {
  try { observer()?.originRecord?.('operation', context.operation, stage, JSON.stringify({ ...context, runtime })); }
  catch { /* observation only */ }
}
export function withRequestOrigin<T>(context: RequestOrigin | undefined, dispatch: () => T): T {
  installBinding();
  const previous = current;
  current = context;
  try { return dispatch(); } finally { current = previous; }
}
export function originPhase(context: RequestOrigin | undefined, phase: string): RequestOrigin | undefined {
  return context ? { ...context, phase } : undefined;
}
export function readRequestOrigins(): unknown {
  try {
    const native = observer();
    return native?.originRead ? JSON.parse(native.originRead())
      : { available: false, reason: 'native_request_origin_extension_required' };
  } catch { return { available: false, reason: 'request_origin_read_failed' }; }
}
// Install the optional callback before a headless task's early-return path.
installBinding();
