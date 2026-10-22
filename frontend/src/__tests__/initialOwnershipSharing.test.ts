/* eslint-disable @typescript-eslint/no-require-imports */
import type { RequestOrigin } from '../requestOrigin';

const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
type Read = ReturnType<typeof deferred<any>> & { url: string; signal: AbortSignal };

describe('real initial ownership verification with runtime-local pending reads', () => {
  let recovery: typeof import('../androidTrackingRecovery');
  let sharing: typeof import('../initialOwnershipReads');
  let native: typeof import('../__mocks__/trackingNative').trackingNative;
  let store: Map<string, string>;
  let token: string | null;
  let reads: Read[];
  let dispatch: jest.Mock;
  let active: boolean[];
  const priorFetch = global.fetch;
  const priorBase = process.env.EXPO_PUBLIC_BACKEND_URL;
  const intent = (owner = 'owner', member = 'member', nonce = 'intent-a') => JSON.stringify({
    version: 1, ownerUserId: owner, memberId: member,
    backendBaseUrl: 'https://example.test', nonce,
  });
  const origin = (label = 'sdk-headless', phase = 'initial-ownership'): RequestOrigin => ({
    operation: `operation-${active.length}`, origin: label, phase,
    wake: `wake-${active.length}`, generation: 0,
  });
  const verify = (label = 'sdk-headless', lifecycle = 1, phase = 'initial-ownership') => {
    const id = active.push(true) - 1;
    return recovery.evaluateWakeAuthorization(() => active[id], origin(label, phase), lifecycle);
  };
  const result = (read: Read, owner = 'owner', member = 'member', consent = 4) => ({
    ok: true, status: 200,
    json: async () => read.url.endsWith('/auth/me') ? { id: owner }
      : read.url.endsWith('/members') ? [{ id: member, user_id: owner, location_consent_generation: consent }]
        : { location_sharing_enabled: true },
  });
  const succeed = (from = 0, owner = 'owner', member = 'member', consent = 4) => {
    reads.slice(from).forEach(read => read.resolve(result(read, owner, member, consent)));
  };
  const replaceAuthority = (owner: string) => {
    native.trackingRevoke('signout');
    const generation = JSON.parse(native.trackingRead()).generation;
    native.trackingShutdownComplete(generation);
    native.trackingAuthorize(owner, generation);
  };

  beforeEach(() => {
    jest.resetModules();
    token = 'session-a'; reads = []; active = [];
    store = new Map([['kc_android_tracking_intent_v1', intent()]]);
    process.env.EXPO_PUBLIC_BACKEND_URL = 'https://example.test';
    jest.doMock('@react-native-async-storage/async-storage', () => ({
      getItem: jest.fn(async (key: string) => store.get(key) ?? null),
      setItem: jest.fn(async (key: string, value: string) => { store.set(key, value); }),
    }));
    jest.doMock('../permissionCoordinator', () => ({
      readPermissionSnapshot: jest.fn(async () => ({ foreground: 'granted', background: 'granted' })),
    }));
    jest.doMock('../backgroundLocationDisclosure', () => ({
      BACKGROUND_LOCATION_DISCLOSURE_TEXT: 'Test background disclosure',
    }));
    jest.doMock('../api', () => ({ getCurrentToken: jest.fn(async () => token) }));
    native = require('../__mocks__/trackingNative').trackingNative;
    native.trackingAuthorize('owner:member', 0);
    dispatch = jest.fn((url, options) => {
      const read = { ...deferred<any>(), url: String(url), signal: options.signal };
      read.signal.addEventListener('abort', () => read.reject(new Error('AbortError')));
      reads.push(read);
      return read.promise;
    });
    global.fetch = dispatch;
    recovery = require('../androidTrackingRecovery');
    sharing = require('../initialOwnershipReads');
  });
  afterEach(() => {
    global.fetch = priorFetch;
    process.env.EXPO_PUBLIC_BACKEND_URL = priorBase;
    jest.useRealTimers();
  });

  it.each([2, 4, 7, 10, 100])('%i equivalent consumers issue exactly three HTTP reads', async count => {
    const pending = Array.from({ length: count }, () => verify());
    await flush();
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(new Set(reads.map(r => r.url)).size).toBe(3);
    succeed();
    expect((await Promise.all(pending)).every(r => r.state === 'AUTHORIZED')).toBe(true);
    // Settled success is not cached.
    const next = verify(); await flush();
    expect(dispatch).toHaveBeenCalledTimes(6);
    succeed(3); expect((await next).state).toBe('AUTHORIZED');
  });

  it.each([
    ['sdk-headless', 'foreground-position'],
    ['sdk-headless', 'sdk-headless'],
    ['patrol', 'workmanager'],
  ])('shares equivalent %s / %s consumers, not their verdicts', async (a, b) => {
    const pending = [verify(a), verify(b)]; await flush(); succeed();
    expect((await Promise.all(pending)).map(v => v.state)).toEqual(['AUTHORIZED', 'AUTHORIZED']);
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  it.each([1, 2])('canceling %i consumers never aborts another consumer or publishes their result', async count => {
    const pending = [verify(), verify()]; await flush();
    for (let i = 0; i < count; i++) active[i] = false;
    expect(reads.every(r => !r.signal.aborted)).toBe(true);
    succeed();
    expect((await Promise.all(pending)).map(v => v.state)).toEqual(count === 1
      ? ['UNKNOWN', 'AUTHORIZED'] : ['UNKNOWN', 'UNKNOWN']);
    expect(dispatch).toHaveBeenCalledTimes(3);
    if (count === 2) expect(recovery.getVerifiedConsentGeneration('owner:member')).toBeNull();
  });

  it.each(['network', '401', '403', 'malformed', 'disabled'])('shares %s failure, never false-green', async kind => {
    const pending = [verify(), verify()]; await flush();
    for (const r of reads) {
      if (kind === 'network') r.reject(new Error('offline'));
      else if (kind === '401' || kind === '403') r.resolve({ ok: false, status: Number(kind) });
      else r.resolve({ ok: true, json: async () => kind === 'malformed' ? null
        : r.url.endsWith('/auth/me') ? { id: 'owner' }
          : r.url.endsWith('/members') ? [{ id: 'member', user_id: 'owner' }]
            : { location_sharing_enabled: false } });
    }
    const outcomes = await Promise.all(pending);
    const state = kind === '401' || kind === 'disabled' ? 'REVOKED' : 'UNKNOWN';
    expect(outcomes.map(v => v.state)).toEqual([state, state]);
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(recovery.getVerifiedConsentGeneration('owner:member')).toBeNull();
  });

  it('network failure is evicted and retry dispatches a fresh triplet', async () => {
    const first = verify(); await flush();
    reads.forEach(r => r.reject(new Error('offline')));
    expect((await first).state).toBe('UNKNOWN');
    const retry = verify(); await flush(); succeed(3);
    expect((await retry).state).toBe('AUTHORIZED');
    expect(dispatch).toHaveBeenCalledTimes(6);
  });

  it('keeps the existing 8-second timeout, with no retained timed-out result', async () => {
    jest.useFakeTimers();
    const pending = [verify(), verify()]; await flush();
    expect(dispatch).toHaveBeenCalledTimes(3);
    jest.advanceTimersByTime(7999); expect(reads.every(r => !r.signal.aborted)).toBe(true);
    jest.advanceTimersByTime(1);
    expect((await Promise.all(pending)).every(v => v.state === 'UNKNOWN')).toBe(true);
    const retry = verify(); await flush(); succeed(3);
    expect((await retry).state).toBe('AUTHORIZED');
    expect(dispatch).toHaveBeenCalledTimes(6);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['logout', 'same-token-login', 'different-user'])('%s invalidates late successful reads', async change => {
    const old = [verify(), verify()]; await flush();
    const finish = sharing.beginOwnershipSessionChange();
    if (change === 'logout') token = null;
    if (change === 'different-user') {
      token = 'session-b'; replaceAuthority('other:other-member');
      store.set(recovery.TRACKING_INTENT_KEY, intent('other', 'other-member'));
    }
    finish();
    const fresh = change === 'logout' ? null : verify(); await flush();
    expect(dispatch).toHaveBeenCalledTimes(change === 'logout' ? 3 : 6);
    reads.slice(0, 3).forEach(r => r.resolve(result(r)));
    expect((await Promise.all(old)).every(v => v.state === 'UNKNOWN')).toBe(true);
    if (fresh) {
      succeed(3, change === 'different-user' ? 'other' : 'owner',
        change === 'different-user' ? 'other-member' : 'member');
      expect((await fresh).state).toBe('AUTHORIZED');
    }
  });

  it('does not dispatch or share while a session mutation is pending', async () => {
    const finish = sharing.beginOwnershipSessionChange();
    expect((await verify()).state).toBe('UNKNOWN');
    expect(dispatch).not.toHaveBeenCalled(); finish();
    const next = verify(); await flush(); succeed();
    expect((await next).state).toBe('AUTHORIZED');
  });

  it('consent withdrawal wins over every late successful shared response', async () => {
    const pending = [verify(), verify()]; await flush();
    await recovery.revokeTrackingIntent('consent');
    succeed();
    expect((await Promise.all(pending)).every(v => v.state !== 'AUTHORIZED')).toBe(true);
    expect(JSON.parse(native.trackingRead()).revoked).toBe(true);
    expect(recovery.getVerifiedConsentGeneration('owner:member')).toBeNull();
  });

  it.each(['generation', 'intent', 'shutdown'])('%s changes prevent stale acceptance', async kind => {
    const pending = [verify(), verify()]; await flush();
    if (kind === 'generation') replaceAuthority('owner:member');
    if (kind === 'intent') store.set(recovery.TRACKING_INTENT_KEY, intent('owner', 'member', 'replacement'));
    if (kind === 'shutdown') {
      native.trackingRevoke('stopped');
      expect(native.trackingShutdownBegin(JSON.parse(native.trackingRead()).generation, 'shutdown')).toBe(true);
    }
    succeed();
    expect((await Promise.all(pending)).every(v => v.state !== 'AUTHORIZED')).toBe(true);
  });

  it('different lifecycle generations issue separate triplets and canceled old work is discarded', async () => {
    const old = verify('sdk-headless', 1); await flush();
    active[0] = false;
    const next = verify('sdk-headless', 2); await flush();
    expect(dispatch).toHaveBeenCalledTimes(6); succeed();
    expect((await old).state).toBe('UNKNOWN');
    expect((await next).state).toBe('AUTHORIZED');
  });

  it('new JS runtimes do not share the prior runtime map', async () => {
    const firstRuntime = sharing;
    let secondRuntime!: typeof sharing;
    jest.isolateModules(() => { secondRuntime = require('../initialOwnershipReads'); });
    const a = deferred<[unknown, unknown, unknown]>();
    const b = deferred<[unknown, unknown, unknown]>();
    const load = jest.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const first = firstRuntime.initialOwnershipReads('private-test-key', load);
    const second = secondRuntime.initialOwnershipReads('private-test-key', load);
    expect(load).toHaveBeenCalledTimes(2);
    a.resolve([1, 2, 3]); b.resolve([4, 5, 6]);
    expect(await first).toEqual([1, 2, 3]); expect(await second).toEqual([4, 5, 6]);
  });

  it('known consent generations prevent joining old reads or overwriting newer consent', async () => {
    const old = verify(); await flush();
    // A later, deliberately independent verification installs newer consent.
    const fresh = recovery.verifyWakeOwnership(() => true, origin('sdk-headless', 'second-ownership'));
    await flush(); succeed(3, 'owner', 'member', 8);
    expect(await fresh).toBe('allowed');
    const next = verify(); await flush();
    expect(dispatch).toHaveBeenCalledTimes(9);
    reads.slice(0, 3).forEach(r => r.resolve(result(r, 'owner', 'member', 4)));
    expect((await old).state).toBe('UNKNOWN');
    succeed(6, 'owner', 'member', 8);
    expect((await next).state).toBe('AUTHORIZED');
    expect(recovery.getVerifiedConsentGeneration('owner:member')).toBe(8);
  });

  it('later verification and dashboard traffic remain independent during initial sharing', async () => {
    const initial = [verify(), verify('foreground-position')];
    const second = recovery.verifyWakeOwnership(() => true, origin('sdk-headless', 'second-ownership'));
    const acquisition = recovery.verifyWakeOwnership(() => true, origin('gps-acquisition', 'acquisition-ownership'));
    // Nine unrelated Joyce-style operations are still real independent calls.
    const independent = Array.from({ length: 9 }, (_, i) => global.fetch(
      `https://example.test/api/independent-${i}`, { signal: new AbortController().signal },
    ));
    await flush(); expect(dispatch).toHaveBeenCalledTimes(18); succeed();
    expect((await Promise.all(initial)).every(v => v.state === 'AUTHORIZED')).toBe(true);
    expect(await second).toBe('allowed'); expect(await acquisition).toBe('allowed');
    await Promise.all(independent);
  });

  it.each(['missing-intent', 'missing-authority', 'pending-mutation'])('does not share an unproven %s context', async kind => {
    if (kind === 'missing-intent') store.delete(recovery.TRACKING_INTENT_KEY);
    if (kind === 'missing-authority') {
      native.trackingRevoke('stopped');
      // Test the low-level verifier's fallback, not evaluate's revocation gate.
    }
    if (kind === 'pending-mutation') native.trackingClaimConfiguration('owner:member', 0, 'configuration', Date.now());
    const pending = Array.from({ length: 2 }, () =>
      recovery.verifyWakeOwnership(() => true, origin(), 1));
    await flush(); expect(dispatch).toHaveBeenCalledTimes(6); succeed();
    await Promise.all(pending);
  });

  it('actual requests retain the initial owner/wake attribution', async () => {
    const requestOrigins = require('../requestOrigin');
    const scope = jest.spyOn(requestOrigins, 'withRequestOrigin');
    const pending = [verify(), verify('foreground-position')]; await flush();
    expect(scope).toHaveBeenCalledTimes(3);
    expect(scope.mock.calls.every(([o]: any) =>
      o.phase === 'initial-ownership' && o.origin === 'sdk-headless' && o.wake)).toBe(true);
    succeed(); await Promise.all(pending);
  });

  it('a configuration mutation starting during shared reads prevents their stale acceptance', async () => {
    const pending = [verify(), verify()]; await flush();
    expect(native.trackingClaimConfiguration('owner:member', 0, 'configuration', Date.now())).toBe(true);
    succeed();
    expect((await Promise.all(pending)).every(v => v.state !== 'AUTHORIZED')).toBe(true);
  });

  it.each([4, 7, 100])('measures real read reduction and synthetic five-slot queue impact for %i consumers', async count => {
    const measurements: { mode: string; ownership: number; independent: number; peakQueued: number }[] = [];
    for (const shared of [false, true]) {
      // Five unrelated calls already occupy the dispatcher, matching the
      // captured census. Their setup is not included in submitted-call counts.
      let running = 5;
      let peakQueued = 0;
      const queue: { read: Read; finish: (r: any) => void }[] = [];
      dispatch.mockImplementation((url, options) => new Promise(resolve => {
        const read = { ...deferred<any>(), url: String(url), signal: options.signal };
        queue.push({ read, finish: resolve });
        peakQueued = Math.max(peakQueued, queue.length);
      }));
      dispatch.mockClear();
      const consumers = Array.from({ length: count }, (_, i) => shared
        ? verify(i < 4 ? 'sdk-headless' : 'foreground-position')
        : recovery.evaluateWakeAuthorization(() => true, origin()));
      const independent = Array.from({ length: 9 }, (_, i) =>
        global.fetch(`https://example.test/api/independent-${i}`, { signal: new AbortController().signal }));
      await flush();
      const submitted = dispatch.mock.calls.length;
      expect(submitted).toBe((shared ? 3 : count * 3) + 9);
      measurements.push({ mode: shared ? 'shared' : 'independent',
        ownership: submitted - 9, independent: 9, peakQueued });
      // Release the held slots; drain the synthetic dispatcher in waves of five.
      running = 0;
      while (queue.length) {
        const wave = queue.splice(0, 5 - running); running += wave.length;
        wave.forEach(({ read, finish }) => finish(result(read)));
        running -= wave.length; await flush();
      }
      expect((await Promise.all(consumers)).every(v => v.state === 'AUTHORIZED')).toBe(true);
      await Promise.all(independent);
    }
    expect(measurements).toEqual([
      { mode: 'independent', ownership: count * 3, independent: 9, peakQueued: count * 3 + 9 },
      { mode: 'shared', ownership: 3, independent: 9, peakQueued: 12 },
    ]);
    console.info('OWNERSHIP_BURST', JSON.stringify({ consumers: count, measurements }));
  });
});
