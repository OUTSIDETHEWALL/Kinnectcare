/**
 * Shutdown is an interrupt, not another entry in the startup FIFO. The FIFO
 * remains quarantined while a native promise is pending; we never race it with
 * a timeout and let a replacement configure the same service concurrently.
 */
type NativeSdk = { stop: () => Promise<unknown> };
let shutdown: Promise<void> | null = null;

export function interruptNativeTracking(sdk: NativeSdk, force = false): Promise<void> {
  if (shutdown && !force) return shutdown;
  let result: Promise<void>;
  try {
    // Invoke BEFORE any storage/logging await. A lost startup callback cannot
    // prevent the already-linked SDK's independent stop command being issued.
    result = Promise.resolve(sdk.stop()).then(() => {});
  } catch (error) {
    result = Promise.reject(error);
  }
  shutdown = result;
  void result.then(
    () => { if (shutdown === result) shutdown = null; },
    () => { if (shutdown === result) shutdown = null; },
  );
  return result;
}

/** Every late native completion is fenced before another await or operation. */
export function fenceNativeSdk<T extends NativeSdk>(
  sdk: T, current: () => Promise<boolean>, synchronouslyCurrent: () => boolean = () => true,
): T {
  const guarded = new Set(['ready', 'setConfig', 'start', 'getState']);
  return new Proxy(sdk, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      if (!guarded.has(String(key))) return value.bind(target);
      return async (...args: unknown[]) => {
        const authorized = async () => {
          try { return synchronouslyCurrent() && await current(); }
          catch (error) {
            await interruptNativeTracking(target, true);
            throw error;
          }
        };
        if (!await authorized()) {
          await interruptNativeTracking(target, true);
          throw new Error('native_operation_obsolete');
        }
        try {
          return await value.apply(target, args);
        } finally {
          if (!synchronouslyCurrent() || !await authorized()) {
            // Do not reuse a pending stop callback: this late operation may
            // have enabled tracking AFTER that stop took effect.
            await interruptNativeTracking(target, true);
          }
        }
      };
    },
  });
}
