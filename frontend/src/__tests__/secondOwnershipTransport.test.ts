/* eslint-disable @typescript-eslint/no-require-imports */
import type { RequestOrigin } from '../requestOrigin';

// Exercise the REAL backgroundHttp -> XMLHttpRequest.send boundary. This is a
// transport handoff census, NOT a claim to have run Android/OkHttp on a phone.
describe('second ownership transport dispatch census', () => {
  const priorXhr = global.XMLHttpRequest;
  const priorFetch = global.fetch;
  const priorBase = process.env.EXPO_PUBLIC_BACKEND_URL;
  let recovery: typeof import('../androidTrackingRecovery');
  let sends: { url: string; respond: () => void }[];
  const flush = async () => { for (let i = 0; i < 150; i++) await Promise.resolve(); };
  const origin = (phase = 'second-ownership'): RequestOrigin => ({
    origin: 'sdk-headless', phase, operation: 'test-operation',
  });
  beforeEach(() => {
    jest.resetModules();
    sends = [];
    process.env.EXPO_PUBLIC_BACKEND_URL = 'https://example.test';
    const intent = JSON.stringify({
      version: 1, ownerUserId: 'owner', memberId: 'member',
      backendBaseUrl: 'https://example.test', nonce: 'intent',
    });
    jest.doMock('@react-native-async-storage/async-storage', () => ({
      getItem: jest.fn(async (key: string) => key === 'kc_android_tracking_intent_v1' ? intent : null),
    }));
    jest.doMock('../backgroundLocationDisclosure', () => ({ BACKGROUND_LOCATION_DISCLOSURE_TEXT: 'test' }));
    jest.doMock('../permissionCoordinator', () => ({
      readPermissionSnapshot: jest.fn(async () => ({ foreground: 'granted', background: 'granted' })),
    }));
    jest.doMock('../api', () => ({ getCurrentToken: jest.fn(async () => 'session') }));
    jest.doMock('../backgroundHttp', () => jest.requireActual('../backgroundHttp'));
    const native = require('../__mocks__/trackingNative').trackingNative;
    native.trackingAuthorize('owner:member', 0);
    global.fetch = jest.fn(() => { throw new Error('fetch must not replace the real XHR transport'); });
    global.XMLHttpRequest = class {
      status = 200;
      responseText = '';
      url = '';
      onload = () => {};
      onabort = () => {};
      open(_method: string, url: string) { this.url = url; }
      setRequestHeader() {}
      abort() { this.onabort(); }
      send() {
        sends.push({ url: this.url, respond: () => {
          this.responseText = JSON.stringify(this.url.endsWith('/auth/me') ? { id: 'owner' }
            : this.url.endsWith('/members')
              ? [{ id: 'member', user_id: 'owner', location_consent_generation: 4 }]
              : { location_sharing_enabled: true });
          this.onload();
        } });
      }
    } as any;
    recovery = require('../androidTrackingRecovery');
  });
  afterEach(() => {
    global.XMLHttpRequest = priorXhr;
    global.fetch = priorFetch;
    if (priorBase === undefined) delete process.env.EXPO_PUBLIC_BACKEND_URL;
    else process.env.EXPO_PUBLIC_BACKEND_URL = priorBase;
  });

  it.each([false, true])('30 consumers with sharing=%s hand off 90 or 3 actual XHR sends', async shared => {
    const pending = Array.from({ length: 30 }, () =>
      recovery.verifyWakeOwnership(() => true, origin(), shared ? 1 : undefined));
    await flush();
    expect(sends).toHaveLength(shared ? 3 : 90);
    const count = sends.length / 3;
    for (const endpoint of ['/auth/me', '/members', '/me/preferences']) {
      expect(sends.filter(r => r.url.endsWith(endpoint))).toHaveLength(count);
    }
    sends.forEach(r => r.respond());
    expect(await Promise.all(pending)).toEqual(Array(30).fill('allowed'));
    expect(global.fetch).not.toHaveBeenCalled();
    if (shared) {
      const next = recovery.verifyWakeOwnership(() => true, origin(), 1);
      await flush();
      expect(sends).toHaveLength(6); // No completed-response cache.
      sends.slice(3).forEach(r => r.respond());
      expect(await next).toBe('allowed');
    }
  });

  it('never uses an initial response to satisfy a concurrent second check', async () => {
    const initial = recovery.verifyWakeOwnership(() => true, origin('initial-ownership'), 1);
    const second = recovery.verifyWakeOwnership(() => true, origin(), 1);
    await flush();
    expect(sends).toHaveLength(6);
    sends.slice(0, 3).forEach(r => r.respond());
    let settled = false;
    void second.then(() => { settled = true; });
    await initial; await flush();
    expect(settled).toBe(false);
    sends.slice(3).forEach(r => r.respond());
    expect(await second).toBe('allowed');
  });
});
