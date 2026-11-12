jest.unmock('../backgroundHttp');
import { backgroundHttp } from '../backgroundHttp';

describe('background HTTP without running JavaScript timers', () => {
  const original = global.XMLHttpRequest;
  let requests: any[];
  beforeEach(() => {
    jest.useFakeTimers();
    requests = [];
    global.XMLHttpRequest = class {
      status = 200;
      responseText = '{"accepted":true}';
      timeout = 0;
      onload!: () => void;
      onerror!: () => void;
      ontimeout!: () => void;
      onabort!: () => void;
      headers: Record<string, string> = {};
      open = jest.fn();
      setRequestHeader = (name: string, value: string) => { this.headers[name] = value; };
      send = jest.fn();
      abort = jest.fn(() => this.onabort?.());
      constructor() { requests.push(this); }
    } as any;
  });
  afterEach(() => {
    global.XMLHttpRequest = original;
    jest.useRealTimers();
  });
  it('settles a native response and parses JSON with zero timer delivery', async () => {
    const result = backgroundHttp('https://example.test', {
      method: 'PUT', headers: { Authorization: 'Bearer fixture' }, body: '{}',
    });
    expect(requests[0].timeout).toBe(8000);
    expect(requests[0].send).toHaveBeenCalledWith('{}');
    requests[0].onload();
    const response = await result;
    expect(response.ok).toBe(true);
    expect(await response.json()).toEqual({ accepted: true });
    expect(jest.getTimerCount()).toBe(0);
  });
  it('native timeout rejects without advancing the JS clock', async () => {
    const result = backgroundHttp('https://example.test');
    requests[0].ontimeout();
    await expect(result).rejects.toThrow('background_http_timeout');
    // A late network success cannot revive the discarded request.
    requests[0].onload();
  });
  it.each([401, 403, 429, 500])('preserves HTTP %i for caller authorization/error decisions', async status => {
    const result = backgroundHttp('https://example.test');
    requests[0].status = status;
    requests[0].onload();
    expect(await result).toMatchObject({ ok: false, status });
  });
  it('rejects an invalid response body rather than silently accepting it', async () => {
    const result = backgroundHttp('https://example.test');
    requests[0].responseText = 'not-json';
    requests[0].onload();
    await expect((await result).json()).rejects.toThrow();
  });
  it('honors cancellation before and after dispatch', async () => {
    const before = new AbortController();
    before.abort();
    await expect(backgroundHttp('https://example.test', { signal: before.signal }))
      .rejects.toThrow('background_http_aborted');
    expect(requests).toHaveLength(0);
    const after = new AbortController();
    const result = backgroundHttp('https://example.test', { signal: after.signal });
    after.abort();
    await expect(result).rejects.toThrow('background_http_aborted');
    expect(requests[0].abort).toHaveBeenCalledTimes(1);
  });
  it('reports missing native transport explicitly, never falling back to fetch', async () => {
    global.XMLHttpRequest = undefined as any;
    await expect(backgroundHttp('https://example.test')).rejects.toThrow('background_xhr_unavailable');
  });
});
