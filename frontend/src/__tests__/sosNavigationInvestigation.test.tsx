import { act } from 'react-test-renderer';
import { setupSosInvestigation, incident, deferred, flush, NOW } from './helpers/sosInvestigation';

describe('SOS navigation investigation — real RootNav, response queue and mounted destination', () => {
  let h: any;
  let consoleError: jest.SpyInstance;
  beforeEach(() => {
    jest.useFakeTimers(); jest.setSystemTime(NOW);
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    h = setupSosInvestigation({ root: true });
  });
  afterEach(async () => {
    try { await h.dispose(); } finally {
      consoleError.mockRestore(); jest.clearAllTimers(); jest.useRealTimers();
    }
  });
  const response = () => ({
    actionIdentifier: 'default',
    notification: { request: { identifier: 'synthetic-response', content: {
      data: { type: 'sos', alert_id: 'synthetic-sos' },
    } } },
  });
  function incidentMounted() {
    expect(h.route).toBe('/alert/synthetic-sos');
    expect(h.find('sos-banner-active').length).toBeGreaterThan(0);
    expect(h.find('alert-back').length).toBeGreaterThan(0);
    expect(h.find('sos-call-911').length).toBeGreaterThan(0);
  }
  it('commits the shared incident after the 800ms startup check and data response', async () => {
    await h.mount();
    expect(h.find('committed:/(tabs)/dashboard').length).toBeGreaterThan(0);
    await h.advance(799);
    expect(h.find('sos-banner-active')).toHaveLength(0);
    await h.advance(1);
    incidentMounted();
  });
  it('commits a cold push response through the real queue after launch gates settle', async () => {
    h.rows = [incident({ created_at: new Date(NOW - 600_000).toISOString() })];
    h.lastResponse = response();
    await h.mount(); await h.advance(1);
    incidentMounted();
    expect(h.storage.get('@kinnship/notification_response_consumed_v1')).toContain('synthetic-response');
    expect(h.lastResponse).toBeNull();
  });
  it('commits a warm notification response and preserves incident actions', async () => {
    h.rows = [incident({ acknowledged: true })]; // excludes automatic resume
    await h.mount();
    expect(typeof h.responseListener).toBe('function');
    await act(async () => { await h.responseListener(response()); await flush(); });
    await h.advance(1);
    incidentMounted();
  });
  it('holds a pending push across a warm-root remount until the new auth gate clears', async () => {
    h.rows = [incident({ acknowledged: true })];
    await h.mount();
    await act(async () => h.tree.unmount());
    h.tree = null;
    h.auth.loading = true;
    h.lastResponse = response();
    await h.mount(); await h.advance(1);
    expect(h.route).toBe('/(tabs)/dashboard');
    expect(h.storage.get('@kinnship/notification_response_consumed_v1')).toBeUndefined();
    h.auth.loading = false;
    await act(async () => { h.tree.update(require('react').createElement(h.Root)); await flush(); });
    await h.advance(1);
    incidentMounted();
  });
  it('shows early Alerts navigation postpones the initial timer rather than proving a repair', async () => {
    await h.mount(); await h.advance(500);
    await act(async () => { h.navigate('/(tabs)/alerts'); await flush(); });
    await h.advance(300);
    expect(h.route).toBe('/(tabs)/alerts');
    await h.advance(500);
    incidentMounted();
  });
  it.each([
    ['acknowledged', { acknowledged: true }],
    ['resolved', { resolved: true }],
    ['older than five minutes', { created_at: new Date(NOW - 300_001).toISOString() }],
  ])('does not auto-open %s SOS without a push response', async (_label, extra) => {
    h.rows = [incident(extra as any)];
    await h.mount(); await h.advance(2000);
    expect(h.route).toBe('/(tabs)/dashboard');
    expect(h.find('sos-banner-active')).toHaveLength(0);
  });
  it('performs the real foreground lifecycle check and mounts its destination', async () => {
    h.rows = []; await h.mount(); await h.advance(1000);
    expect(h.listeners.size).toBeGreaterThan(0);
    await h.appState('background');
    await h.advance(4000); h.rows = [incident()];
    await h.appState('active'); await h.advance(400);
    incidentMounted();
  });
  it('separates initial route commitment from an incident request still loading', async () => {
    const request = deferred();
    let reads = 0;
    h.get.mockImplementation(async (path: string) => {
      if (path === '/alerts') return ++reads === 1 ? { data: h.rows } : request.promise;
      return { data: [] };
    });
    await h.mount(); await h.advance(800);
    expect(h.route).toBe('/alert/synthetic-sos');
    expect(h.find('sos-call-911')).toHaveLength(0);
    await act(async () => { request.resolve({ data: h.rows }); await flush(); });
    incidentMounted();
  });
});
