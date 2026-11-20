import React from 'react';
import { act } from 'react-test-renderer';
import vm from 'node:vm';
import { setupSosInvestigation, incident, profile, deferred, flush } from './helpers/sosInvestigation';

class CaptureError extends React.Component<React.PropsWithChildren<{ errors: string[] }>, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { this.props.errors.push(error.message); }
  render() { return this.state.failed ? <div data-captured-error /> : this.props.children; }
}

describe('SOS incident investigation — controlled data and real map isolation', () => {
  let h: any;
  let consoleError: jest.SpyInstance;
  beforeEach(() => {
    jest.useFakeTimers(); jest.setSystemTime(new Date('2026-11-20T01:38:40Z'));
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    h = setupSosInvestigation({ realMap: true });
  });
  afterEach(async () => {
    try { await h.dispose(); } finally {
      consoleError.mockRestore(); jest.clearAllTimers(); jest.useRealTimers();
    }
  });
  it.each([
    ['active', {}, 'sos-banner-active'],
    ['acknowledged but unresolved', { acknowledged: true }, 'sos-banner-active'],
    ['resolved', { resolved: true }, 'sos-banner-resolved'],
    ['invalid coordinates', { latitude: NaN, longitude: Infinity }, 'sos-banner-active'],
  ])('mounts %s with return and emergency actions', async (_name, extra, banner) => {
    h.rows = [incident(extra as any)];
    await h.mount();
    expect(h.find(banner as string).length).toBeGreaterThan(0);
    expect(h.find('alert-back').length).toBeGreaterThan(0);
    expect(h.find('sos-call-911').length).toBeGreaterThan(0);
    expect(h.tree.root.findAllByType('ControlledWebView')).toHaveLength(0);
  });
  it.each(['absent', 'malformed collection', 'rejected'])('renders a message then returns on %s data', async mode => {
    h.rows = mode === 'absent' ? [] : {};
    if (mode === 'rejected') h.get.mockRejectedValue(new Error('Synthetic network rejection'));
    await h.mount();
    expect(JSON.stringify(h.tree.toJSON())).toContain('Alert no longer active');
    await h.advance(1500);
    expect(h.router.replace).toHaveBeenCalledWith('/(tabs)/dashboard');
  });
  it('records the initial nonsettling-read limitation: spinner, no return or emergency action', async () => {
    const request = deferred();
    h.get.mockReturnValue(request.promise);
    await h.mount();
    await h.advance(60_000);
    expect(h.find('alert-back')).toHaveLength(0);
    expect(h.find('sos-call-911')).toHaveLength(0);
    expect(h.tree.root.findAllByType('ActivityIndicator').length).toBeGreaterThan(0);
    // This models a promise that never rejects, NOT Axios's actual timeout.
    expect(h.get.mock.calls[0][1].timeout).toBeUndefined();
    await act(async () => { request.resolve({ data: [incident()] }); await flush(); });
    expect(h.find('sos-call-911').length).toBeGreaterThan(0);
  });
  it('keeps loading until a delayed read settles, then renders the incident', async () => {
    const request = deferred();
    h.get.mockImplementation((path: string) => path === '/alerts' ? request.promise : Promise.resolve({ data: [] }));
    await h.mount(); await h.advance(2000);
    expect(h.find('sos-call-911')).toHaveLength(0);
    await act(async () => { request.resolve({ data: [incident()] }); await flush(); });
    expect(h.find('sos-banner-active').length).toBeGreaterThan(0);
  });
  it.each(['originating account', 'recipient account'])('renders the same incident for the %s', async mode => {
    if (mode === 'originating account') h.auth.user.id = 'synthetic-owner';
    await h.mount();
    expect(h.find('sos-resolve').length).toBeGreaterThan(0);
    expect(h.find('alert-back').length).toBeGreaterThan(0);
  });
  it.each(['never settles', 'rejects', 'malformed'])('keeps incident actions when member lookup %s', async mode => {
    const normalGet = h.get.getMockImplementation();
    h.get.mockImplementation((path: string) => path !== '/members' ? normalGet(path)
      : mode === 'never settles' ? deferred().promise
        : mode === 'rejects' ? Promise.reject(new Error('Synthetic member failure'))
          : Promise.resolve({ data: {} }));
    await h.mount(); await h.advance(31_000);
    expect(h.find('sos-call-911').length).toBeGreaterThan(0);
    expect(h.find('sos-resolve').length).toBeGreaterThan(0);
    expect(h.tree.root.findAllByType('ControlledWebView')).toHaveLength(0);
  });
  it('provides a map-substituted control with the same authorized coordinates', async () => {
    await h.dispose();
    h = setupSosInvestigation();
    h.profiles = [profile()];
    await h.mount();
    expect(h.tree.root.findAllByType('SubstitutedMap')).toHaveLength(1);
    expect(h.find('sos-resolve').length).toBeGreaterThan(0);
  });
  it('aborts a pending initial load on disposal and ignores its completion', async () => {
    const request = deferred();
    h.get.mockReturnValue(request.promise);
    await h.mount();
    const signal = h.get.mock.calls[0][1].signal;
    await act(async () => h.tree.unmount());
    h.tree = null;
    expect(signal.aborted).toBe(true);
    await act(async () => { request.resolve({ data: [incident()] }); await flush(); });
    expect(h.post).not.toHaveBeenCalled();
  });
  it('mounts the real map around the controlled WebView and preserves actions across background return', async () => {
    h.profiles = [profile()];
    await h.mount();
    expect(h.tree.root.findAllByType('ControlledWebView')).toHaveLength(1);
    expect(h.find('sos-call-911').length).toBeGreaterThan(0);
    await h.appState('background');
    expect(h.tree.root.findAllByType('ControlledWebView')).toHaveLength(0);
    await h.appState('active');
    expect(h.tree.root.findAllByType('ControlledWebView')).toHaveLength(1);
    await act(async () => {
      h.find('alert-back')[0].props.onPress(); await flush();
    });
    expect(h.router.replace).toHaveBeenCalledWith('/(tabs)/dashboard');
    expect(h.tree.root.findAllByType('ControlledWebView')).toHaveLength(0);
  });
  it('executes the actual generated HTML offline: script failure and timeout stay inside the map', async () => {
    h.profiles = [profile()]; await h.mount();
    const webview = h.tree.root.findByType('ControlledWebView');
    const html = webview.props.source.html;
    const script = html.split('<scr' + 'ipt>')[1].split('</scr' + 'ipt>')[0];
    const fallback: any = { style: {}, textContent: '' };
    const map: any = { style: {} };
    let loader: any;
    const timers: Function[] = [];
    const window: any = { addEventListener: jest.fn() };
    window.parent = window;
    const context = vm.createContext({
      window, URL, setTimeout: (cb: Function) => timers.push(cb),
      document: {
        getElementById: (id: string) => id === 'fallback' ? fallback : map,
        createElement: () => ({}),
        head: { appendChild: (node: any) => { loader = node; } },
      },
    });
    vm.runInContext(script, context);
    expect(loader.src).toContain('https://maps.googleapis.com/maps/api/js');
    loader.onerror();
    expect(fallback.textContent).toContain('Could not load Google Maps script');
    expect(map.style.display).toBe('none');
    timers.forEach(cb => cb());
    expect(fallback.textContent).toContain('Google Maps did not load');
    // No network was dispatched: document.head is a controlled inert object.
    expect(h.find('sos-resolve').length).toBeGreaterThan(0);
    expect(h.find('alert-back').length).toBeGreaterThan(0);
    await act(async () => {
      webview.props.onMessage({ nativeEvent: { data: 'not JSON' } });
      webview.props.onMessage({ nativeEvent: { data: JSON.stringify({ type: 'kinn-map-ready', lat: 20, lng: 30 }) } });
    });
    expect(h.find('sos-call-911').length).toBeGreaterThan(0);
  });
  it('shows that an injected WebView render exception propagates beyond the incident without a local boundary', async () => {
    h.profiles = [profile()]; h.mapThrows = true;
    const Detail = h.Root; const errors: string[] = [];
    h.Root = () => <CaptureError errors={errors}><Detail /></CaptureError>;
    await h.mount();
    expect(errors).toEqual(['Synthetic native map mount error']);
    expect(h.find('alert-back')).toHaveLength(0);
    expect(h.find('sos-call-911')).toHaveLength(0);
    // A deliberately injected exception proves containment is absent;
    // it does NOT prove a native map exception happened on either phone.
  });
  it('ignores malformed and late map messages after Return without reopening the incident', async () => {
    h.profiles = [profile()]; await h.mount();
    const message = h.tree.root.findByType('ControlledWebView').props.onMessage;
    await act(async () => {
      h.find('alert-back')[0].props.onPress(); await flush();
      message({ nativeEvent: { data: 'invalid' } });
      message({ nativeEvent: { data: JSON.stringify({ type: 'kinn-map-ready', lat: 20, lng: 30 }) } });
      await flush();
    });
    expect(h.route).toBe('/(tabs)/dashboard');
    expect(h.tree.root.findAllByType('ControlledWebView')).toHaveLength(0);
    expect(h.router.replace).toHaveBeenCalledTimes(1);
  });
  it('shows that a malformed render field can throw after a successful incident read', async () => {
    h.rows = [incident({ member_name: { unexpected: 'object' } })];
    const Detail = h.Root; const errors: string[] = [];
    h.Root = () => <CaptureError errors={errors}><Detail /></CaptureError>;
    await h.mount();
    expect(errors.join(' ')).toContain('Objects are not valid as a React child');
    expect(h.find('sos-call-911')).toHaveLength(0);
    // Deliberately invalid data, not a claim about the production response.
  });
});
