/* eslint-disable @typescript-eslint/no-require-imports */
import type { RequestOrigin } from '../requestOrigin';

const flush = async () => { for (let i = 0; i < 400; i++) await Promise.resolve(); };
type Send = { phase?: string; url: string; done: (status?: number) => void; fail: () => void; expire: () => void };

describe('real SDK ownership admission and XHR transport', () => {
  let recovery: typeof import('../androidTrackingRecovery');
  let gate: typeof import('../ownershipAdmission');
  let session: typeof import('../initialOwnershipReads');
  let native: any;
  let sdk: any;
  let token: string | null;
  let store: Map<string, string>;
  let sends: Send[];
  let pending: Set<Send>;
  let peak: number;
  let remote: 'enabled' | 'withdrawn' | 'replaced';
  let bound: RequestOrigin | undefined;
  const priorXhr = global.XMLHttpRequest;
  const priorBase = process.env.EXPO_PUBLIC_BACKEND_URL;
  const origin = (phase = 'second-ownership', priority: 'motion' | 'other' = 'other'): RequestOrigin => ({
    operation: Math.random().toString(), origin: 'sdk-headless', phase, ownershipPriority: priority,
  });
  const verify = (current = () => true, phase = 'second-ownership') =>
    recovery.verifyWakeOwnership(current, origin(phase), phase === 'initial-ownership' ? 1 : undefined);
  const settle = () => [...pending].forEach(s => s.done());
  const drain = async () => {
    for (let i = 0; i < 200 && (pending.size || gate.ownershipAdmissionStats().queued
      || gate.ownershipAdmissionStats().active); i++) { settle(); await flush(); }
    expect(gate.ownershipAdmissionStats()).toMatchObject({ active: 0, queued: 0 });
  };
  beforeEach(async () => {
    jest.resetModules();
    token = 'session'; sends = []; pending = new Set(); peak = 0; remote = 'enabled'; bound = undefined;
    process.env.EXPO_PUBLIC_BACKEND_URL = 'https://example.test';
    store = new Map([['kc_android_tracking_intent_v1', JSON.stringify({
      version: 1, ownerUserId: 'owner', memberId: 'member', backendBaseUrl: 'https://example.test', nonce: 'intent',
    })]]);
    jest.doMock('../ownershipAdmission', () => jest.requireActual('../ownershipAdmission'));
    jest.doMock('../backgroundHttp', () => jest.requireActual('../backgroundHttp'));
    jest.doMock('react-native', () => ({ Platform: { OS: 'android' }, AppState: { currentState: 'background' } }));
    jest.doMock('@react-native-async-storage/async-storage', () => ({
      getItem: jest.fn(async (key: string) => store.get(key) ?? null),
      setItem: jest.fn(async (key: string, value: string) => { store.set(key, value); }),
      removeItem: jest.fn(async (key: string) => { store.delete(key); }),
    }));
    jest.doMock('../permissionCoordinator', () => ({
      readPermissionSnapshot: jest.fn(async () => ({ foreground: 'granted', background: 'granted' })),
      serializePermissionOperation: (run: () => Promise<unknown>) => run(),
    }));
    jest.doMock('../backgroundLocationDisclosure', () => ({ BACKGROUND_LOCATION_DISCLOSURE_TEXT: 'test' }));
    jest.doMock('../api', () => ({ getCurrentToken: jest.fn(async () => token), api: { patch: jest.fn() } }));
    native = require('../__mocks__/trackingNative').trackingNative;
    native.trackingAuthorize('owner:member', 0);
    sdk = {
      getState: jest.fn(async () => ({ enabled: true, url: 'https://example.test/api/members/member/location',
        authorization: { accessToken: token }, extras: { consent_generation: 4 } })),
      ready: jest.fn(async () => ({ enabled: true })), setConfig: jest.fn(async () => {}),
      start: jest.fn(async () => ({ enabled: true })), stop: jest.fn(async () => {}),
    };
    for (const name of ['onLocation', 'onMotionChange', 'onProviderChange', 'onHttp',
      'onHeartbeat', 'onActivityChange', 'onEnabledChange']) sdk[name] = jest.fn(() => ({ remove: jest.fn() }));
    jest.doMock('react-native-background-geolocation', () => ({ default: sdk }));
    const origins = require('../requestOrigin');
    const dispatch = origins.withRequestOrigin;
    jest.spyOn(origins, 'withRequestOrigin').mockImplementation((o: any, run: any) => {
      bound = o; try { return dispatch(o, run); } finally { bound = undefined; }
    });
    global.XMLHttpRequest = class {
      url = ''; status = 200; responseText = '';
      onload = () => {}; onerror = () => {}; ontimeout = () => {}; onabort = () => {};
      open(_method: string, url: string) { this.url = url; }
      setRequestHeader() {}
      abort() { this.onabort(); }
      send() {
        const snapshot = remote;
        const body = this.url.endsWith('/auth/me') ? { id: 'owner' }
          : this.url.endsWith('/members') ? (snapshot === 'replaced' ? []
            : [{ id: 'member', user_id: 'owner', location_consent_generation: 4 }])
            : { location_sharing_enabled: snapshot !== 'withdrawn' };
        const end = (event: () => void) => { if (pending.delete(row)) event(); };
        const row: Send = { url: this.url, phase: bound?.phase,
          done: (status = 200) => end(() => { this.status = status; this.responseText = JSON.stringify(body); this.onload(); }),
          fail: () => end(() => this.onerror()), expire: () => end(() => this.ontimeout()) };
        sends.push(row); pending.add(row); peak = Math.max(peak, pending.size);
      }
    } as any;
    recovery = require('../androidTrackingRecovery'); gate = require('../ownershipAdmission');
    session = require('../initialOwnershipReads');
    // Establish the same verified consent generation that real initial recovery
    // establishes before second-stage verification. This seed is not budgeted.
    const seed = recovery.verifyWakeOwnership(() => true, { operation: 'seed', origin: 'direct' });
    await flush(); settle(); expect(await seed).toBe('allowed');
    sends = []; peak = 0;
  });
  afterEach(() => {
    global.XMLHttpRequest = priorXhr;
    if (priorBase === undefined) delete process.env.EXPO_PUBLIC_BACKEND_URL;
    else process.env.EXPO_PUBLIC_BACKEND_URL = priorBase;
    jest.useRealTimers();
  });

  it.each(['withdrawn', 'replaced'] as const)('fresh B detects server-only %s while A has an old pending body', async change => {
    const a = verify(); await flush();
    // Complete A auth so its third request captures pre-change server state.
    sends[0].done(); await flush();
    expect(sends).toHaveLength(3);
    remote = change;
    const b = verify(); await flush();
    sends[1].done(); await flush(); // B can now begin, A preferences still held.
    expect(sends).toHaveLength(4);
    sends[2].done(); await flush();
    await drain();
    expect(await a).toBe('allowed');
    expect(await b).toBe(change === 'withdrawn' ? 'sharing_disabled' : 'invalid_owner');
    expect(sends).toHaveLength(6);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it.each(['logout', 'switch', 'same-token', 'lifecycle', 'consent', 'owner', 'expiry'])(
    '%s while queued never dispatches stale work or leaks permits', async change => {
      let alive = true;
      const a = verify(); await flush();
      const b = verify(() => alive); await flush();
      if (['logout', 'switch', 'same-token'].includes(change)) {
        const end = session.beginOwnershipSessionChange();
        if (change === 'logout') token = null;
        if (change === 'switch') token = 'other-session';
        end();
      }
      if (change === 'lifecycle' || change === 'expiry') alive = false;
      if (change === 'consent') await recovery.revokeTrackingIntent('consent');
      if (change === 'owner') native.trackingRevoke('signout');
      const before = sends.length;
      await drain();
      expect(await b).not.toBe('allowed');
      if (change !== 'lifecycle' && change !== 'expiry') expect(sends).toHaveLength(before);
      await a;
      expect(peak).toBeLessThanOrEqual(2);
    },
  );

  it('initial leader expiry preserves a live follower and sends only one triplet', async () => {
    let alive = true;
    const a = verify(() => alive, 'initial-ownership');
    const b = verify(() => true, 'initial-ownership');
    await flush(); expect(sends).toHaveLength(2);
    alive = false;
    await drain();
    expect(await a).toBe('obsolete_owner'); expect(await b).toBe('allowed');
    expect(sends).toHaveLength(3);
  });

  it('an in-flight cancellation cannot release a live transport or authorize its consumer', async () => {
    let alive = true;
    const a = verify(() => alive); await flush();
    alive = false;
    const b = verify(); await flush();
    expect(sends).toHaveLength(2); // The canceled consumer still owns two live transports.
    sends[0].expire(); await flush();
    expect(pending.size).toBe(2);
    await drain();
    expect(await a).not.toBe('allowed'); expect(await b).toBe('allowed');
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('a hung pre-dispatch validation is bounded and its late result cannot dispatch', async () => {
    jest.useFakeTimers();
    const api = require('../api');
    let release!: (value: string) => void;
    const hang = new Promise<string>(resolve => { release = resolve; });
    // First token read admits the consumer; subsequent validation token reads hang.
    api.getCurrentToken.mockResolvedValueOnce(token).mockImplementation(() => hang);
    const a = verify(); await flush();
    expect(sends).toHaveLength(0);
    jest.advanceTimersByTime(8000); await flush(); // Third queued helper now validates.
    jest.advanceTimersByTime(8000); await flush();
    release('session'); await flush();
    expect(await a).not.toBe('allowed');
    expect(sends).toHaveLength(0);
    expect(gate.ownershipAdmissionStats()).toMatchObject({ active: 0, queued: 0 });
  });

  it.each(['failure', 'timeout', 'http'])('%s does not release a sibling transport permit', async kind => {
    const a = verify(); await flush();
    const held = sends[1];
    if (kind === 'failure') sends[0].fail();
    if (kind === 'timeout') sends[0].expire();
    if (kind === 'http') sends[0].done(500);
    await flush();
    expect(await a).toBe('ownership_unavailable');
    expect(pending.has(held)).toBe(true);
    const b = verify(); await flush();
    expect(pending.size).toBe(2); // NOT two new calls plus the held sibling.
    await drain(); await b;
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('foreground and acquisition HTTP bypass a saturated recovery budget', async () => {
    const a = verify(); await flush();
    const independent = recovery.verifyWakeOwnership(() => true,
      { operation: 'foreground', origin: 'foreground-position', phase: 'acquisition-ownership' });
    await flush();
    expect(sends).toHaveLength(5); // Two budgeted plus three independent reads.
    await drain(); expect(await independent).toBe('allowed'); await a;
  });

  it('measures a 30-consumer burst through the real engine, gate and backgroundHttp/XHR boundary', async () => {
    jest.useFakeTimers({ now: 0 });
    const engine = require('../locationEngine') as typeof import('../locationEngine');
    const start = performance.now();
    const completedAt: number[] = [];
    const work = Array.from({ length: 30 }, (_, i) => engine.recoverFromIndependentWake(
      i === 29 ? 'sdk-motionchange' : 'sdk-terminate',
    ).then(value => { completedAt.push(performance.now() - start); return value; }));
    await flush();
    for (let i = 0; i < 250 && completedAt.length < 30; i++) {
      jest.advanceTimersByTime(5); settle(); await flush();
    }
    expect((await Promise.all(work)).every(value => value === 'already_enabled')).toBe(true);
    const counts = Object.fromEntries(['initial-ownership', 'second-ownership', 'recovery-cache-miss']
      .map(phase => [phase, sends.filter(s => s.phase === phase).length]));
    expect(counts).toEqual({ 'initial-ownership': 3, 'second-ownership': 90, 'recovery-cache-miss': 3 });
    expect(peak).toBe(2);
    expect(gate.ownershipAdmissionStats()).toMatchObject({ active: 0, queued: 0, submitted: 96 });
    console.info('SIMULATED real engine/XHR census', { counts, peak,
      admission: gate.ownershipAdmissionStats(), firstRecoveryMs: Math.min(...completedAt),
      lastRecoveryMs: Math.max(...completedAt), serviceWaveMs: 5, nativeAndroid: false });
    expect(sdk.stop).not.toHaveBeenCalled();
    expect(sdk.start).not.toHaveBeenCalled();
  });

  it('uses FIFO within classes with bounded motion overtaking, never strict-priority starvation', async () => {
    const starts: string[] = []; const releases: (() => void)[] = [];
    const submit = (name: string, priority: 'motion' | 'other') => gate.admitOwnershipHttp(priority,
      () => new Promise<void>(resolve => { starts.push(name); releases.push(resolve); }));
    const tasks = [submit('o0', 'other'), submit('o1', 'other'), submit('o2', 'other'),
      ...Array.from({ length: 5 }, (_, i) => submit(`m${i}`, 'motion'))];
    await flush();
    while (releases.length) { releases.shift()!(); await flush(); }
    await Promise.all(tasks);
    expect(starts.slice(2, 5)).toEqual(['m0', 'm1', 'o2']);
    expect(starts.filter(x => x.startsWith('m'))).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
  });
});
