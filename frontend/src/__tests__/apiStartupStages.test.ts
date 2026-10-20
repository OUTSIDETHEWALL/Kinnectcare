jest.mock('react-native', () => ({ Platform: { OS: 'android' }, AppState: { currentState: 'active' } }));
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(), setItem: jest.fn(), removeItem: jest.fn(),
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(), setItemAsync: jest.fn(), AFTER_FIRST_UNLOCK: 'AFTER_FIRST_UNLOCK',
}));
const mockMark = jest.fn();
const mockEvidenceId = jest.fn((): string | null => null);
jest.mock('../startupDiagnostics', () => ({ markStartupMilestone: (...args: any[]) => mockMark(...args) }));
jest.mock('../evidenceTrace', () => ({
  startupTraceId: () => mockEvidenceId(), recordEvidence: jest.fn(),
}));

import * as SecureStore from 'expo-secure-store';
import { api, subscribeToTokenChanges } from '../api';
import { beginStartupApiTiming } from '../startupApiTiming';
import axios from 'axios';

function deferred<T = any>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const result = () => mockMark.mock.calls.find(([event]) => event === 'startup_api_stage_timing')?.[1];

describe('real API startup stage boundaries', () => {
  let close: () => void;
  beforeEach(() => {
    jest.useFakeTimers(); jest.clearAllMocks();
    mockEvidenceId.mockReturnValue(null);
    (SecureStore.getItemAsync as jest.Mock).mockResolvedValue('original-test-token');
    (SecureStore.setItemAsync as jest.Mock).mockResolvedValue(undefined);
    close = beginStartupApiTiming();
  });
  afterEach(() => { close(); expect(jest.getTimerCount()).toBe(0); jest.useRealTimers(); });

  it('adds correlation only for a supported native startup observation', async () => {
    mockEvidenceId.mockReturnValue('a'.repeat(32));
    const adapter = jest.fn(async config => ({ config, data: [], headers: {}, status: 200, statusText: 'OK' }));
    const observed = await api.get('/members', { adapter });
    expect(observed.config.headers.get('X-Kinnship-Startup-Trace')).toBe('a'.repeat(32));
    const background = await api.get('/members/test/location', { adapter });
    expect(background.config.headers.get('X-Kinnship-Startup-Trace')).toBeUndefined();
    expect(background.config.adapter).toBe(adapter);
  });

  it('sends no new header when the existing binary lacks the extension', async () => {
    const adapter = jest.fn(async config => ({ config, data: [], headers: {}, status: 200, statusText: 'OK' }));
    const response = await api.get('/members', { adapter });
    expect(response.config.headers.get('X-Kinnship-Startup-Trace')).toBeUndefined();
  });

  it('separates token wait, adapter lifetime and refreshed-token persistence without releasing the response early', async () => {
    const token = deferred<string>();
    const transport = deferred();
    const persistence = deferred<void>();
    (SecureStore.getItemAsync as jest.Mock).mockReturnValue(token.promise);
    (SecureStore.setItemAsync as jest.Mock).mockReturnValue(persistence.promise);
    let config: any;
    const adapter = jest.fn(c => { config = c; return transport.promise; });
    const notify = jest.fn();
    const unsubscribe = subscribeToTokenChanges(notify);
    let settled = false;
    const pending = api.get('/members', { adapter }).then(r => { settled = true; return r; });
    await flush();
    await jest.advanceTimersByTimeAsync(100);
    expect(adapter).not.toHaveBeenCalled();
    token.resolve('original-test-token'); await flush();
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(config.headers.Authorization).toBe('Bearer original-test-token');
    await jest.advanceTimersByTimeAsync(600);
    const response = {
      config, data: [], status: 200, statusText: 'OK',
      headers: { date: 'Mon, 19 Oct 2026 22:16:49 GMT', 'x-refresh-token': 'refreshed-test-token-long-enough' },
    };
    transport.resolve(response); await flush();
    expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(300);
    persistence.resolve(); const received = await pending;
    expect(received).toBe(response);
    expect(received.headers.date).toBe(response.headers.date);
    expect(notify).toHaveBeenCalledWith('refreshed-test-token-long-enough');
    expect(result()).toEqual(expect.objectContaining({
      endpoint: '/members', outcome: 'completed', tokenReadMs: 100,
      tokenToAdapterMs: 0, adapterMs: 600, adapterToResponseMs: 0,
      responseTokenPersistenceMs: 300, totalMs: 1_000,
      refreshedToken: true, persistenceFailed: false, maxJsTimerDelayMs: 0,
    }));
    expect(JSON.stringify(result())).not.toContain('test-token');
    unsubscribe();
  });

  it('records no token-persistence stage when the response has no refresh token', async () => {
    const response = await api.get('/summary', {
      adapter: async config => ({ config, data: { members: [] }, headers: {}, status: 200, statusText: 'OK' }),
    });
    expect(response.data).toEqual({ members: [] });
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
    expect(result()).toEqual(expect.objectContaining({
      responseTokenPersistenceMs: null, refreshedToken: false, outcome: 'completed',
    }));
  });

  it('preserves config-specific adapter resolution and transformed request headers', async () => {
    const fetch = jest.fn(async (request: RequestInfo | URL) => {
      expect((request as Request).headers.get('Authorization')).toBe('Bearer original-test-token');
      return new Response('[]', { status: 200 });
    });
    const response = await api.get('/members', {
      baseURL: 'https://example.invalid', adapter: 'fetch', env: { fetch },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBeDefined();
    expect(response.data).toEqual([]);
    expect(result()).toEqual(expect.objectContaining({ outcome: 'completed' }));
  });

  it('preserves adapter rejection identity and the existing no-retry policy for members', async () => {
    let failure: Error;
    const adapter = jest.fn(async config => {
      failure = Object.assign(new Error('transport rejected'), { config });
      throw failure;
    });
    const rejected = await api.get('/members', { adapter }).catch(e => e);
    expect(rejected).toBe(failure!);
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(result()).toEqual(expect.objectContaining({ outcome: 'failed', status: null }));
  });

  it('preserves secure-read rejection identity and does not invoke transport', async () => {
    const failure = new Error('secure read failed');
    (SecureStore.getItemAsync as jest.Mock).mockRejectedValue(failure);
    const adapter = jest.fn();
    expect(await api.get('/members', { adapter }).catch(e => e)).toBe(failure);
    expect(adapter).not.toHaveBeenCalled();
    expect(result()).toEqual(expect.objectContaining({ outcome: 'token_failed', adapterMs: null }));
  });

  it('preserves cancellation identity and does not retry a canceled members request', async () => {
    const source = axios.CancelToken.source();
    const transport = deferred();
    const adapter = jest.fn(() => transport.promise);
    const pending = api.get('/members', { adapter, cancelToken: source.token }).catch(e => e);
    await flush();
    source.cancel('test cancellation');
    transport.reject(source.token.reason);
    expect(await pending).toBe(source.token.reason);
    expect(adapter).toHaveBeenCalledTimes(1);
    // CancelToken's reason may lack config; bounded observation cleanup must
    // still leave no timer, without replacing that original cancellation.
    close();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('preserves existing successful-response behavior when refresh persistence fails', async () => {
    (SecureStore.setItemAsync as jest.Mock).mockRejectedValue(new Error('secure write failed'));
    const response = await api.get('/auth/me', {
      adapter: async config => ({
        config, data: { refreshed_token: 'body-refresh-token-long-enough' },
        headers: {}, status: 200, statusText: 'OK',
      }),
    });
    expect(response.status).toBe(200);
    expect(result()).toEqual(expect.objectContaining({ outcome: 'completed', persistenceFailed: true }));
  });

  it('does not wrap or observe tracking requests or requests outside a mounted startup window', async () => {
    const adapter = jest.fn(async config => ({ config, data: [], headers: {}, status: 200, statusText: 'OK' }));
    const background = await api.get('/members/test/location', { adapter });
    expect(background.config.adapter).toBe(adapter);
    close();
    const outside = await api.get('/members', { adapter });
    expect(outside.config.adapter).toBe(adapter);
    expect(result()).toBeUndefined();
  });
});
