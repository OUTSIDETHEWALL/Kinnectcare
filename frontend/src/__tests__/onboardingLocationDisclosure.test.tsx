/**
 * Mount the real onboarding screen and real disclosure helper together.
 * Only native APIs are mocked: these tests verify actual effect ordering.
 */
describe('fresh onboarding location permission order', () => {
  let React: any;
  let renderer: any;
  let Permissions: any;
  let ensure: () => Promise<void>;
  let storage: any;
  let location: any;
  let notifications: any;
  let alert: jest.Mock;
  let markHandled: jest.Mock;
  let replace: jest.Mock;
  let platform: { OS: string };
  let tree: any;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    React = require('react');
    renderer = require('react-test-renderer');
    tree = null;
    platform = { OS: 'android' };
    storage = {
      getItem: jest.fn().mockResolvedValue(null),
      setItem: jest.fn().mockResolvedValue(undefined),
    };
    location = {
      getForegroundPermissionsAsync: jest.fn().mockResolvedValue({ status: 'undetermined' }),
      requestForegroundPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
    };
    notifications = {
      requestPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
    };
    alert = jest.fn();
    markHandled = jest.fn().mockResolvedValue(undefined);
    replace = jest.fn();
    jest.doMock('react-native', () => ({
      View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity',
      ActivityIndicator: 'ActivityIndicator', Platform: platform,
      Linking: { openSettings: jest.fn() }, Alert: { alert },
      StyleSheet: { create: (styles: unknown) => styles },
    }));
    jest.doMock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
    jest.doMock('expo-router', () => ({ useRouter: () => ({ replace }) }));
    jest.doMock('@react-native-async-storage/async-storage', () => storage);
    jest.doMock('expo-location', () => location);
    jest.doMock('expo-notifications', () => notifications);
    jest.doMock('../permissionsStore', () => ({ markPermissionsHandled: markHandled }));
    ensure = require('../backgroundLocationDisclosure').ensureBackgroundLocationDisclosure;
    Permissions = require('../../app/(auth)/permissions').default;
  });

  afterEach(async () => {
    if (tree) await renderer.act(async () => { tree.unmount(); });
    jest.useRealTimers();
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  });

  async function reachLocationStage() {
    await renderer.act(async () => { tree = renderer.create(React.createElement(Permissions)); });
    await renderer.act(async () => { jest.advanceTimersByTime(900); });
  }

  async function acknowledge() {
    await renderer.act(async () => { alert.mock.calls[0][2][0].onPress(); });
  }

  it.each([null, 'true'])(
    'blocks the first Android request until Continue (saved acknowledgment: %s)',
    async stored => {
      storage.getItem.mockResolvedValue(stored);
      await reachLocationStage();
      expect(alert).toHaveBeenCalledTimes(1);
      expect(location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
      expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
      expect(markHandled).not.toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
      await acknowledge();
      expect(location.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
      expect(notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
      expect(markHandled).toHaveBeenCalledTimes(1);
      expect(replace).toHaveBeenCalledWith('/(tabs)/dashboard');
    },
  );

  it.each(['before', 'after'])(
    'coordinates a concurrent background caller %s onboarding opens disclosure',
    async timing => {
      let background: Promise<void> | undefined;
      if (timing === 'before') {
        background = ensure();
        await renderer.act(async () => { await Promise.resolve(); });
      }
      await reachLocationStage();
      if (timing === 'after') background = ensure();
      expect(alert).toHaveBeenCalledTimes(1);
      expect(location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
      await acknowledge();
      await background;
      expect(alert).toHaveBeenCalledTimes(1);
      expect(location.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves the denied-location choice and does not automatically ask notifications', async () => {
    location.requestForegroundPermissionsAsync.mockResolvedValue({ status: 'denied' });
    await reachLocationStage();
    await acknowledge();
    expect(JSON.stringify(tree.toJSON())).toContain('Continue Anyway');
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(markHandled).not.toHaveBeenCalled();
  });

  it('does not ask permission if disclosure presentation fails', async () => {
    alert.mockImplementation(() => { throw new Error('alert unavailable'); });
    await reachLocationStage();
    expect(location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(JSON.stringify(tree.toJSON())).toContain('Continue Anyway');
  });

  it('does not request permission from an unmounted screen while awaiting Continue', async () => {
    await reachLocationStage();
    await renderer.act(async () => { tree.unmount(); });
    tree = null;
    await acknowledge();
    expect(location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('a reopened screen shares the pending disclosure and requests only from the live screen', async () => {
    await reachLocationStage();
    await renderer.act(async () => { tree.unmount(); });
    tree = null;
    await reachLocationStage();
    expect(alert).toHaveBeenCalledTimes(1);
    await acknowledge();
    expect(location.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  it.each(['ios', 'web'])('retains the automatic %s sequence without an Android disclosure', async os => {
    platform.OS = os;
    await reachLocationStage();
    expect(alert).not.toHaveBeenCalled();
    expect(location.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(markHandled).toHaveBeenCalledTimes(1);
  });
});
