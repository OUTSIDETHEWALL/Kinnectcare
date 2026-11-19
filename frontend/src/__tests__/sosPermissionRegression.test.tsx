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
  let params: Record<string, string>;
  let receiptStore: any;
  let authUser: { id: string; family_group_id: string } | null;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    React = require('react');
    renderer = require('react-test-renderer');
    tree = null;
    post = jest.fn().mockImplementation(async (_path: string, payload: any) => ({
      data: {
        ok: true, alert_id: 'offline-test-alert', timestamp: new Date().toISOString(),
        coordinates: payload.latitude === undefined ? null : payload, fanout_mode: 'background',
      },
    }));
    foreground = jest.fn().mockResolvedValue({ status: 'granted' });
    position = jest.fn().mockResolvedValue({ coords: { latitude: 1, longitude: 2 } });
    boost = jest.fn().mockResolvedValue(undefined);
    replace = jest.fn();
    const router = { replace };
    canDial = jest.fn().mockResolvedValue(true);
    openDialer = jest.fn().mockResolvedValue(undefined);
    showAlert = jest.fn();
    params = { receiptId: 'offline-test-alert' };
    authUser = { id: 'synthetic-sender', family_group_id: 'synthetic-family' };
    jest.doMock('react-native', () => ({
      View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity',
      ScrollView: 'ScrollView',
      Animated: {
        View: 'View', Value: jest.fn(),
        spring: jest.fn(() => ({ start: jest.fn() })),
      },
      ActivityIndicator: 'ActivityIndicator', Platform: {
        OS: 'android', select: (options: any) => options.android ?? options.default,
      },
      Linking: { canOpenURL: canDial, openURL: openDialer }, Alert: { alert: showAlert },
      StyleSheet: { create: (styles: unknown) => styles },
    }));
    jest.doMock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
    jest.doMock('expo-router', () => ({ useRouter: () => router, useLocalSearchParams: () => params }));
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
    jest.doMock('../AuthContext', () => ({ useAuth: () => ({ user: authUser }) }));
    jest.doMock('../backgroundLocation', () => ({ beginSosBoost: boost }));
    Screen = require('../../app/sos-sending').default;
    const actual = require('../sosSendReceipt');
    receiptStore = { ...actual, readSosSendReceipt: (id: unknown) => actual.readSosSendReceipt(id, actual.sosAccountScope(authUser)) };
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

  function expectConfirmation() {
    expect(replace).toHaveBeenCalledWith({
      pathname: '/sos-confirmation', params: { receiptId: 'offline-test-alert' },
    });
  }

  async function call911() {
    const button = tree.root.findAllByType('TouchableOpacity')
      .find((node: any) => node.props.testID === 'sos-call-911');
    expect(button).toBeDefined();
    await renderer.act(async () => { await button.props.onPress(); });
  }

  function screenText() {
    return JSON.stringify(tree.toJSON());
  }

  function expectOneLocationlessSos() {
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('/sos', { latitude: undefined, longitude: undefined });
    expect(openDialer).not.toHaveBeenCalled();
  }

  it('sends the existing SOS payload and preserves location boost and confirmation', async () => {
    await send();
    expect(post).toHaveBeenCalledWith('/sos', { latitude: 1, longitude: 2 });
    expect(boost).toHaveBeenCalledTimes(1);
    expectConfirmation();
    expect(post).toHaveBeenCalledTimes(1);
    expect(openDialer).not.toHaveBeenCalled();
  });

  it('still sends SOS when foreground location is denied', async () => {
    foreground.mockResolvedValue({ status: 'denied' });
    await send();
    expect(position).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith('/sos', { latitude: undefined, longitude: undefined });
    expectConfirmation();
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

  it('cancelling/unmounting during preparation performs no SOS request or automatic call', async () => {
    await renderer.act(async () => { tree = renderer.create(React.createElement(Screen)); });
    await renderer.act(async () => { tree.unmount(); });
    tree = null;
    await advance(10_000);
    expect(post).not.toHaveBeenCalled();
    expect(foreground).not.toHaveBeenCalled();
    expect(openDialer).not.toHaveBeenCalled();
    expect(receiptStore.readSosSendReceipt('offline-test-alert')).toBeNull();
  });

  it.each(['GPS acquisition', 'Android settings/provider interaction'])(
    'sends without automatically dialing despite indefinitely pending %s', async () => {
      position.mockImplementation(() => new Promise(() => {}));
      await send();
      expect(position).toHaveBeenCalledTimes(1);
      expect(post).not.toHaveBeenCalled(); // Still within the 1.5-second total budget.
      await advance(500);
      expectOneLocationlessSos();
      await advance(120_000);
      expectOneLocationlessSos();
      expect(replace).toHaveBeenCalledTimes(1);
      expectConfirmation();
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
    expectConfirmation();
  });

  it.each(['GPS error', 'permission error'])('%s still sends without location', async kind => {
    if (kind === 'GPS error') position.mockRejectedValue(new Error('provider unavailable'));
    else foreground.mockRejectedValue(new Error('permission unavailable'));
    await send();
    expectOneLocationlessSos();
    expectConfirmation();
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
    expect(openDialer).not.toHaveBeenCalled();
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
    expect(openDialer).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('rerenders do not duplicate an in-flight SOS or dialer', async () => {
    await send();
    await renderer.act(async () => { tree.update(React.createElement(Screen)); });
    await advance(5000);
    expect(post).toHaveBeenCalledTimes(1);
    expect(openDialer).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('pending optional location boost cannot delay dialer or confirmation', async () => {
    boost.mockImplementation(() => new Promise(() => {}));
    await send();
    expect(post).toHaveBeenCalledTimes(1);
    expect(openDialer).not.toHaveBeenCalled();
    expectConfirmation();
  });

  it('dialer rejection preserves accepted SOS and gives independent manual-call guidance', async () => {
    openDialer.mockRejectedValue(new Error('no dialer'));
    await send();
    await call911();
    expect(post).toHaveBeenCalledTimes(1);
    expect(showAlert).toHaveBeenCalledWith('Could not confirm emergency dialer', expect.any(String));
    expect(screenText()).not.toContain('Emergency dialer opened.');
    expectConfirmation();
  });

  it('Call 911 is available immediately, throughout pending GPS, POST failure, and retry', async () => {
    let failPost!: (reason: Error) => void;
    position.mockImplementationOnce(() => new Promise(() => {}));
    post.mockImplementationOnce(() => new Promise((_resolve, reject) => { failPost = reject; }));
    await renderer.act(async () => { tree = renderer.create(React.createElement(Screen)); });
    await call911(); // Preparing: before the 350ms pause.
    expect(post).not.toHaveBeenCalled();
    await advance(350);
    await call911(); // GPS pending.
    await advance(1500);
    await call911(); // Backend pending.
    await renderer.act(async () => { failPost(new Error('offline')); });
    expect(screenText()).toContain('Family alert not confirmed');
    await call911(); // Failure: no internet required.
    const retry = tree.root.findAllByType('TouchableOpacity').find((n: any) => n.props.testID === 'sos-retry');
    await renderer.act(async () => { retry.props.onPress(); });
    await call911(); // Retry preparation.
    expect(openDialer).toHaveBeenCalledTimes(5);
    expect(openDialer).toHaveBeenLastCalledWith('tel:911');
    expect(canDial).not.toHaveBeenCalled();
    expect(screenText()).toContain('cannot confirm a call');
    await advance(350);
    await advance(1000);
    expect(post).toHaveBeenCalledTimes(2);
    expectConfirmation();
  });

  it('a pending dialer intent cannot delay SOS and is not recorded as opened', async () => {
    openDialer.mockImplementation(() => new Promise(() => {}));
    await renderer.act(async () => { tree = renderer.create(React.createElement(Screen)); });
    await renderer.act(async () => {
      tree.root.findAllByType('TouchableOpacity').find((n: any) => n.props.testID === 'sos-call-911').props.onPress();
    });
    await advance(350);
    await advance(1000);
    expectConfirmation();
    expect(receiptStore.readSosSendReceipt('offline-test-alert')?.dialerOpened).toBe(false);
  });

  it.each([{}, { ok: false, alert_id: 'no' }, { ok: true }])(
    'does not convert an invalid server response into recording success: %j', async data => {
      post.mockResolvedValue({ data });
      await send();
      expect(replace).not.toHaveBeenCalled();
      expect(receiptStore.readSosSendReceipt('offline-test-alert')).toBeNull();
      expect(screenText()).toContain('Family alert not confirmed');
      await call911();
      expect(openDialer).toHaveBeenCalledTimes(1);
    },
  );

  async function showConfirmation() {
    await renderer.act(async () => { if (tree) tree.unmount(); });
    const Confirmation = require('../../app/sos-confirmation').default;
    await renderer.act(async () => { tree = renderer.create(React.createElement(Confirmation)); });
  }

  it.each(['fresh', 'stale', 'denied'])('confirmation describes %s GPS without claiming delivery or calling', async kind => {
    if (kind === 'denied') foreground.mockResolvedValue({ status: 'denied' });
    else position.mockImplementation(async () => ({
      timestamp: Date.now() - (kind === 'stale' ? 3_600_000 : 0),
      coords: { latitude: 1, longitude: 2, accuracy: 12 },
    }));
    await send();
    await showConfirmation();
    const text = screenText();
    expect(text).toContain('SOS Alert Recorded');
    expect(text).toContain('Family notification requested');
    expect(text).toContain('Delivery to family devices is not confirmed');
    expect(text).toContain(kind === 'denied' ? 'Location unavailable'
      : kind === 'stale' ? 'Last-known location recorded' : 'GPS location recorded');
    if (kind !== 'denied') expect(text).toContain('accuracy ±12 m');
    expect(text).not.toContain('delivered to all');
    expect(text).not.toContain('services were dialled');
    expect(text).not.toContain('as soon as someone sees');
    expect(openDialer).not.toHaveBeenCalled();
    await call911();
    expect(screenText()).toContain('Emergency dialer opened.');
    expect(openDialer).toHaveBeenCalledTimes(1);
  });

  it('a direct/deep-linked confirmation cannot fabricate a server receipt', async () => {
    await showConfirmation();
    expect(screenText()).toContain('SOS Status Not Confirmed');
    expect(screenText()).not.toContain('SOS Alert Recorded');
    await call911();
    expect(post).not.toHaveBeenCalled();
  });

  it('a mismatched receipt ID cannot reuse another SOS confirmation', async () => {
    await send();
    params.receiptId = 'different-incident';
    await showConfirmation();
    expect(screenText()).toContain('SOS Status Not Confirmed');
  });

  it('leaving confirmation clears volatile evidence rather than persisting location/status', async () => {
    await send();
    await showConfirmation();
    expect(receiptStore.readSosSendReceipt('offline-test-alert')).not.toBeNull();
    await renderer.act(async () => { tree.unmount(); });
    tree = null;
    expect(receiptStore.readSosSendReceipt('offline-test-alert')).toBeNull();
  });

  it('opening the dialer after recording but before navigation carries only the opened outcome', async () => {
    await renderer.act(async () => { tree = renderer.create(React.createElement(Screen)); });
    await advance(350);
    await call911();
    await advance(1000);
    await showConfirmation();
    expect(screenText()).toContain('Emergency dialer opened.');
    expect(screenText()).toContain('cannot confirm a call was placed or answered');
    expect(openDialer).toHaveBeenCalledTimes(1);
  });

  it('a mounted confirmation follows incident changes instead of reusing initial evidence', async () => {
    await send();
    await showConfirmation();
    params.receiptId = 'unconfirmed-other-incident';
    const Confirmation = require('../../app/sos-confirmation').default;
    await renderer.act(async () => { tree.update(React.createElement(Confirmation)); });
    expect(screenText()).toContain('SOS Status Not Confirmed');
    expect(screenText()).not.toContain('SOS Alert Recorded');
  });

  it.each(['logout', 'account', 'family'])('confirmation invalidates on %s change', async change => {
    await send();
    await showConfirmation();
    authUser = change === 'logout' ? null : {
      id: change === 'account' ? 'other' : 'synthetic-sender',
      family_group_id: change === 'family' ? 'other' : 'synthetic-family',
    };
    const Confirmation = require('../../app/sos-confirmation').default;
    await renderer.act(async () => { tree.update(React.createElement(Confirmation)); });
    expect(screenText()).toContain('SOS Status Not Confirmed');
    expect(screenText()).not.toContain('SOS Alert Recorded');
  });

  it('revoking the session invalidates a still-mounted confirmation immediately', async () => {
    await send();
    await showConfirmation();
    await renderer.act(async () => { receiptStore.clearSosSendReceipt(); });
    expect(screenText()).toContain('SOS Status Not Confirmed');
  });

  it('interrupted confirmation handoff clears the recorded receipt', async () => {
    await renderer.act(async () => { tree = renderer.create(React.createElement(Screen)); });
    await advance(350); // Saved, but still in the 900ms handoff.
    expect(receiptStore.readSosSendReceipt('offline-test-alert')).not.toBeNull();
    await renderer.act(async () => { tree.unmount(); });
    tree = null;
    await advance(1000);
    expect(receiptStore.readSosSendReceipt('offline-test-alert')).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it('a late POST from a revoked session cannot publish receipt, boost, or navigation', async () => {
    let finish!: (data: any) => void;
    post.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await send();
    await renderer.act(async () => { receiptStore.clearSosSendReceipt(); });
    await renderer.act(async () => { finish({ data: {
      ok: true, alert_id: 'offline-test-alert', fanout_mode: 'background', coordinates: null,
    } }); });
    await advance(1000);
    expect(receiptStore.readSosSendReceipt('offline-test-alert')).toBeNull();
    expect(replace).not.toHaveBeenCalled();
    expect(boost).not.toHaveBeenCalled();
  });

  it('a pending dialer times out, permits a new explicit attempt, and ignores the old settlement', async () => {
    let oldFinish!: () => void;
    openDialer.mockImplementationOnce(() => new Promise<void>(resolve => { oldFinish = resolve; }));
    openDialer.mockRejectedValueOnce(new Error('new attempt rejected'));
    await send();
    await renderer.act(async () => {
      tree.root.findAllByType('TouchableOpacity').find((n: any) => n.props.testID === 'sos-call-911').props.onPress();
    });
    await advance(3000);
    expect(showAlert).toHaveBeenCalledTimes(1);
    expect(screenText()).toContain('Try again or use your phone');
    await call911();
    expect(openDialer).toHaveBeenCalledTimes(2);
    await renderer.act(async () => { oldFinish(); });
    expect(screenText()).not.toContain('Emergency dialer opened.');
    expect(receiptStore.readSosSendReceipt('offline-test-alert')?.dialerOpened).toBe(false);
    expect(post).toHaveBeenCalledTimes(1);
  });
});
