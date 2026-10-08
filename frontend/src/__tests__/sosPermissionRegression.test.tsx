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
    jest.doMock('react-native', () => ({
      View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity',
      ActivityIndicator: 'ActivityIndicator', Platform: {
        OS: 'android', select: (options: any) => options.android ?? options.default,
      },
      Linking: { openURL: jest.fn() }, Alert: { alert: jest.fn() },
      StyleSheet: { create: (styles: unknown) => styles },
    }));
    jest.doMock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
    jest.doMock('expo-router', () => ({ useRouter: () => ({ replace }) }));
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

  it('sends the existing SOS payload and preserves location boost and confirmation', async () => {
    await send();
    expect(post).toHaveBeenCalledWith('/sos', { latitude: 1, longitude: 2 });
    expect(boost).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('/sos-confirmation');
  });

  it('still sends SOS when foreground location is denied', async () => {
    foreground.mockResolvedValue({ status: 'denied' });
    await send();
    expect(position).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith('/sos', { latitude: undefined, longitude: undefined });
    expect(replace).toHaveBeenCalledWith('/sos-confirmation');
  });

  it('does not claim success when the server rejects SOS', async () => {
    post.mockRejectedValue(new Error('offline test rejection'));
    await send();
    expect(replace).not.toHaveBeenCalled();
    expect(boost).not.toHaveBeenCalled();
    expect(tree.root.findAll((node: any) => node.props.testID === 'sos-retry').length).toBeGreaterThan(0);
  });
});
