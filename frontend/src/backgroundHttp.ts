/**
 * Background fetch must not depend on React Native's paused timer frames.
 * whatwg-fetch settles XHR responses through setTimeout(0); even an HTTP 200
 * can consequently remain pending for hours while the Activity is paused.
 * XHR events and its native timeout do not require that completion timer.
 * Keep this transport interceptor-free: its callers already bind and recheck
 * the exact owner, consent generation and execution lifetime.
 */
export type BackgroundResponse = {
  status: number;
  ok: boolean;
  json(): Promise<any>;
};
type Options = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal | null;
  timeoutMs?: number;
};

export function backgroundHttp(url: string, options: Options = {}): Promise<BackgroundResponse> {
  return new Promise((resolve, reject) => {
    if (typeof XMLHttpRequest === 'undefined') {
      reject(new Error('background_xhr_unavailable'));
      return;
    }
    if (options.signal?.aborted) {
      reject(new Error('background_http_aborted'));
      return;
    }
    const xhr = new XMLHttpRequest();
    let settled = false;
    const cleanup = () => options.signal?.removeEventListener('abort', abort);
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(message));
    };
    const abort = () => {
      fail('background_http_aborted');
      xhr.abort();
    };
    xhr.open(options.method ?? 'GET', url, true);
    xhr.timeout = options.timeoutMs ?? 8_000;
    xhr.responseType = 'text';
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      xhr.setRequestHeader(name, value);
    }
    xhr.onload = () => {
      if (settled) return;
      if (xhr.status === 0) return fail('background_http_network_error');
      settled = true;
      cleanup();
      const status = xhr.status;
      const text = xhr.responseText;
      resolve({
        status,
        ok: status >= 200 && status < 300,
        json: async () => JSON.parse(text),
      });
    };
    xhr.onerror = () => fail('background_http_network_error');
    xhr.ontimeout = () => fail('background_http_timeout');
    xhr.onabort = () => fail('background_http_aborted');
    options.signal?.addEventListener('abort', abort);
    // Catch cancellation that occurred between the first check and registration.
    if (options.signal?.aborted) return abort();
    try { xhr.send(options.body ?? null); }
    catch (error) {
      if (!settled) {
        settled = true;
        cleanup();
        reject(error);
      }
    }
  });
}
