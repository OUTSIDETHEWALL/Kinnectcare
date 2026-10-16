/** Real SOS screen, offline native/API mocks: never sends a live alarm. */
describe('SOS remains usable after permission startup changes', () => {
  let React: any;
  let renderer: any;
  let Screen: any;
  let post: jest.Mock;
  let foreground: jest.Mock;
  let position: jest.Mock;
  let boost: jest.Mock;
  let replace: jest.Mock;
  let tree: any;
  let canDial: jest.Mock;
  let openDialer: jest.Mock;
  let showAlert: jest.Mock;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    React = require('react');
    renderer = require('react-test-renderer');
    tree = null;
    post = jest.fn().mockResolvedValue({ data: { id: 'offline-test-alert' } });
    foreground = jest.fn().mockResolvedValue({ status: 'granted' });
    position = jest.fn().mockResolvedValue({ coords: { latitude: 1, longitude: 2 } });
    boost = jest.fn().mockResolvedValue(undefined);
    replace = jest.fn();
    const router = { replace };
    canDial = jest.fn().mockResolvedValue(true);
    openDialer = jest.fn().mockResolvedValue(undefined);
    showAlert = jest.fn();
    jest.doMock('react-native', () => ({
      View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity',
      ActivityIndicator: 'ActivityIndicator', Platform: {
        OS: 'android', select: (options: any) => options.android ?? options.default,
      },
      Linking: { canOpenURL: canDial, openURL: openDialer }, Alert: { alert: showAlert },
      StyleSheet: { create: (styles: unknown) => styles },
    }));
    jest.doMock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
    jest.doMock('expo-router', () => ({ useRouter: () => router }));
    jest.doMock('expo-location', () => ({
      requestForegroundPermissionsAsync: foreground,
      getCurrentPositionAsync: position,
      Accuracy: { Balanced: 3 },
    }));
    jest.doMock('expo-haptics', () => ({
      notificationAsync: jest.fn().mockResolvedValue(undefined),
      NotificationFeedbackType: { Success: 'success' },
    }));
    jest.doMock('../api', () => ({ api: { post } }));
    jest.doMock('../backgroundLocation', () => ({ beginSosBoost: boost }));
    Screen = require('../../app/sos-sending').default;
  });

  afterEach(async () => {
    if (tree) await renderer.act(async () => { tree.unmount(); });
    jest.useRealTimers();
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
    delete (globalThis as any).__kinnshipAlertsBump;
  });

  async function send() {
    await renderer.act(async () => { tree = renderer.create(React.createElement(Screen)); });
    await renderer.act(async () => { jest.advanceTimersByTime(350); });
    await renderer.act(async () => { jest.advanceTimersByTime(1000); });
  }

  async function advance(ms: number) {
    await renderer.act(async () => { jest.advanceTimersByTime(ms); });
  }

  function expectOneLocationlessSos() {
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('/sos', { latitude: undefined, longitude: undefined });
    expect(openDialer).toHaveBeenCalledTimes(1);
    expect(openDialer).toHaveBeenCalledWith('tel:911');
  }

  it('sends the existing SOS payload and preserves location boost and confirmation', async () => {
    await send();
    expect(post).toHaveBeenCalledWith('/sos', { latitude: 1, longitude: 2 });
    expect(boost).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('/sos-confirmation');
    expect(post).toHaveBeenCalledTimes(1);
    expect(openDialer).toHaveBeenCalledTimes(1);
  });

  it('still sends SOS when foreground location is denied', async () => {
    foreground.mockResolvedValue({ status: 'denied' });
    await send();
    expect(position).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith('/sos', { latitude: undefined, longitude: undefined });
    expect(replace).toHaveBeenCalledWith('/sos-confirmation');
    expectOneLocationlessSos();
  });

  it('does not claim success when the server rejects SOS', async () => {
    post.mockRejectedValue(new Error('offline test rejection'));
    await send();
    expect(replace).not.toHaveBeenCalled();
    expect(boost).not.toHaveBeenCalled();
    expect(openDialer).not.toHaveBeenCalled();
    expect(tree.root.findAll((node: any) => node.props.testID === 'sos-retry').length).toBeGreaterThan(0);
  });

  it.each(['GPS acquisition', 'Android settings/provider interaction'])(
    'sends and dials despite indefinitely pending %s', async () => {
      position.mockImplementation(() => new Promise(() => {}));
      await send();
      expect(position).toHaveBeenCalledTimes(1);
      expect(post).not.toHaveBeenCalled(); // Still within the 1.5-second total budget.
      await advance(500);
      expectOneLocationlessSos();
      await advance(120_000);
      expectOneLocationlessSos();
      expect(replace).toHaveBeenCalledTimes(1);
      expect(replace).toHaveBeenCalledWith('/sos-confirmation');
    },
  );

  it('permission dialog may remain pending without preventing SOS or dialer', async () => {
    let grant!: (value: any) => void;
    foreground.mockImplementation(() => new Promise(resolve => { grant = resolve; }));
    await send();
    await advance(500);
    expectOneLocationlessSos();
    await renderer.act(async () => { grant({ status: 'granted' }); });
    expect(position).not.toHaveBeenCalled(); // No late settings/GPS request after fallback.
    await advance(1000);
    expect(replace).toHaveBeenCalledWith('/sos-confirmation');
  });

  it.each(['GPS error', 'permission error'])('%s still sends and dials without location', async kind => {
    if (kind === 'GPS error') position.mockRejectedValue(new Error('provider unavailable'));
    else foreground.mockRejectedValue(new Error('permission unavailable'));
    await send();
    expectOneLocationlessSos();
    expect(replace).toHaveBeenCalledWith('/sos-confirmation');
  });

  it.each(['resolve', 'reject'])('late GPS %s cannot resend or redial after fallback', async kind => {
    let complete!: (value: any) => void;
    let reject!: (reason: any) => void;
    position.mockImplementation(() => new Promise((resolve, fail) => { complete = resolve; reject = fail; }));
    await send();
    await advance(500);
    expectOneLocationlessSos();
    await renderer.act(async () => {
      if (kind === 'resolve') complete({ coords: { latitude: 77, longitude: 88 } });
      else reject(new Error('late provider failure'));
    });
    await advance(1000);
    expectOneLocationlessSos();
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('old GPS cannot contaminate a retry, including rapid repeated Retry taps', async () => {
    let oldFix!: (value: any) => void;
    position.mockImplementationOnce(() => new Promise(resolve => { oldFix = resolve; }));
    post.mockRejectedValueOnce(new Error('first send failed'));
    await send();
    await advance(500);
    expect(post).toHaveBeenCalledTimes(1);
    const retry = tree.root.findAll((node: any) => node.props.testID === 'sos-retry')[0].props.onPress;
    await renderer.act(async () => { retry(); retry(); });
    await renderer.act(async () => { oldFix({ coords: { latitude: 77, longitude: 88 } }); });
    await advance(350);
    await advance(1000);
    expect(post).toHaveBeenCalledTimes(2); // One failed attempt, one deliberate retry.
    expect(post.mock.calls[0][1]).toEqual({ latitude: undefined, longitude: undefined });
    expect(post.mock.calls[1][1]).toEqual({ latitude: 1, longitude: 2 });
    expect(openDialer).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('unmounted SOS cannot publish an old fix into a newly mounted SOS', async () => {
    let oldFix!: (value: any) => void;
    position.mockImplementationOnce(() => new Promise(resolve => { oldFix = resolve; }));
    await send();
    await renderer.act(async () => { tree.unmount(); });
    tree = null;
    await send();
    await renderer.act(async () => { oldFix({ coords: { latitude: 77, longitude: 88 } }); });
    await advance(2000);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('/sos', { latitude: 1, longitude: 2 });
    expect(openDialer).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('rerenders do not duplicate an in-flight SOS or dialer', async () => {
    await send();
    await renderer.act(async () => { tree.update(React.createElement(Screen)); });
    await advance(5000);
    expect(post).toHaveBeenCalledTimes(1);
    expect(openDialer).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('pending optional location boost cannot delay dialer or confirmation', async () => {
    boost.mockImplementation(() => new Promise(() => {}));
    await send();
    expect(post).toHaveBeenCalledTimes(1);
    expect(openDialer).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('/sos-confirmation');
  });

  it.each(['unavailable', 'rejected'])('dialer %s preserves accepted SOS and manual-call warning', async kind => {
    if (kind === 'unavailable') canDial.mockResolvedValue(false);
    else openDialer.mockRejectedValue(new Error('no dialer'));
    await send();
    expect(post).toHaveBeenCalledTimes(1);
    expect(showAlert).toHaveBeenCalledWith('🆘 Call 911 Now', expect.any(String), [{ text: 'OK' }]);
    expect(replace).toHaveBeenCalledWith('/sos-confirmation');
  });
});
