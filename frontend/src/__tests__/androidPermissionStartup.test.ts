/** Native APIs are mocked; permission policy and SDK startup are real. */
describe('Android permission/startup policy', () => {
  let storage: Map<string, string>;
  let location: any;
  let notifications: any;
  let sdk: any;
  let alert: jest.Mock;
  let coordinator: typeof import('../permissionCoordinator');
  let store: typeof import('../permissionsStore');
  let engine: typeof import('../locationEngine');

  const config = { memberId: 'member', jwt: 'test-jwt', backendBaseUrl: 'https://example.test' };
  const grant = (status: string) => ({ status, granted: status === 'granted' });

  beforeEach(() => {
    jest.resetModules();
    storage = new Map();
    location = {
      getForegroundPermissionsAsync: jest.fn().mockResolvedValue(grant('granted')),
      getBackgroundPermissionsAsync: jest.fn().mockResolvedValue(grant('granted')),
      requestForegroundPermissionsAsync: jest.fn().mockResolvedValue(grant('granted')),
      requestBackgroundPermissionsAsync: jest.fn().mockResolvedValue(grant('granted')),
    };
    notifications = {
      getPermissionsAsync: jest.fn().mockResolvedValue(grant('granted')),
      requestPermissionsAsync: jest.fn().mockResolvedValue(grant('granted')),
    };
    alert = jest.fn((_title, _message, buttons) => buttons[0].onPress());
    sdk = {
      ready: jest.fn().mockResolvedValue({ enabled: false, trackingMode: 1 }),
      setConfig: jest.fn().mockResolvedValue({ enabled: true }),
      requestPermission: jest.fn(),
      getState: jest.fn().mockResolvedValue({ enabled: true, trackingMode: 1, isMoving: false }),
      start: jest.fn().mockResolvedValue({ enabled: true, trackingMode: 1 }),
      stop: jest.fn().mockResolvedValue({ enabled: false }),
      removeListeners: jest.fn(),
    };
    for (const name of ['onLocation', 'onMotionChange', 'onActivityChange', 'onHeartbeat',
      'onProviderChange', 'onHttp', 'onEnabledChange', 'onPowerSaveChange',
      'onConnectivityChange', 'onGeofence', 'onSchedule']) {
      sdk[name] = jest.fn(() => ({ remove: jest.fn() }));
    }
    jest.doMock('react-native', () => ({
      Platform: { OS: 'android' }, Alert: { alert },
      AppState: { currentState: 'active', addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
    }));
    jest.doMock('@react-native-async-storage/async-storage', () => ({
      getItem: jest.fn(async key => storage.get(key) ?? null),
      setItem: jest.fn(async (key, value) => { storage.set(key, value); }),
      removeItem: jest.fn(async key => { storage.delete(key); }),
    }));
    jest.doMock('expo-location', () => location);
    jest.doMock('expo-notifications', () => notifications);
    jest.doMock('expo-battery', () => ({
      getBatteryLevelAsync: jest.fn().mockResolvedValue(-1),
      getBatteryStateAsync: jest.fn().mockResolvedValue(0),
      addBatteryLevelListener: jest.fn(() => ({ remove: jest.fn() })),
      addBatteryStateListener: jest.fn(() => ({ remove: jest.fn() })),
    }));
    jest.doMock('react-native-background-geolocation', () => ({ default: sdk }));
    coordinator = require('../permissionCoordinator');
    store = require('../permissionsStore');
    engine = require('../locationEngine');
  });

  it('requires setup for a clean install', async () => {
    expect(await store.isPermissionsHandled()).toBe(false);
  });

  it.each(['undetermined', 'denied'])('rejects an Android-restored legacy flag with background %s', async status => {
    storage.set('@kinnship/permissions_handled_v1', 'true');
    location.getBackgroundPermissionsAsync.mockResolvedValue(grant(status));
    expect(await store.isPermissionsHandled()).toBe(false);
    expect(location.requestBackgroundPermissionsAsync).not.toHaveBeenCalled();
  });

  it('retains a fully authorized legacy installation without extra prompts', async () => {
    storage.set('@kinnship/permissions_handled_v1', 'true');
    expect(await store.isPermissionsHandled()).toBe(true);
    expect(alert).not.toHaveBeenCalled();
  });

  it('Continue Anyway persists a denial without a startup loop', async () => {
    location.getForegroundPermissionsAsync.mockResolvedValue(grant('denied'));
    location.getBackgroundPermissionsAsync.mockResolvedValue(grant('undetermined'));
    notifications.getPermissionsAsync.mockResolvedValue(grant('denied'));
    await store.markPermissionsHandled();
    expect(await store.isPermissionsHandled()).toBe(true);
    expect(await store.isPermissionsHandled()).toBe(true);
    expect(alert).not.toHaveBeenCalled();
  });

  it('detects a permission lost after a granted decision was restored', async () => {
    await store.markPermissionsHandled();
    location.getBackgroundPermissionsAsync.mockResolvedValue(grant('undetermined'));
    expect(await store.isPermissionsHandled()).toBe(false);
  });

  it('serializes disclosure, foreground, background, and notifications', async () => {
    const order: string[] = [];
    let acknowledge!: () => void;
    alert.mockImplementation((_title, _body, buttons) => {
      order.push('disclosure');
      acknowledge = buttons[0].onPress;
    });
    location.getBackgroundPermissionsAsync.mockResolvedValue(grant('undetermined'));
    notifications.getPermissionsAsync.mockResolvedValue(grant('undetermined'));
    location.requestForegroundPermissionsAsync.mockImplementation(async () => { order.push('foreground'); return grant('granted'); });
    location.requestBackgroundPermissionsAsync.mockImplementation(async () => { order.push('background'); return grant('granted'); });
    notifications.requestPermissionsAsync.mockImplementation(async () => { order.push('notifications'); return grant('granted'); });
    const setup = coordinator.requestOnboardingLocation();
    const push = coordinator.notificationPermission(true);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(order).toEqual(['disclosure']);
    acknowledge();
    await Promise.all([setup, push]);
    expect(order).toEqual(['disclosure', 'foreground', 'background', 'notifications']);
  });

  it('automatic dashboard/push callers never prompt on Android', async () => {
    location.getForegroundPermissionsAsync.mockResolvedValue(grant('undetermined'));
    notifications.getPermissionsAsync.mockResolvedValue(grant('undetermined'));
    await coordinator.foregroundLocationForAutomaticCaller();
    await coordinator.notificationPermission();
    expect(location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('cancelled onboarding cannot request permissions after disclosure', async () => {
    let current = true;
    alert.mockImplementation((_title, _body, buttons) => {
      current = false;
      buttons[0].onPress();
    });
    expect(await coordinator.requestOnboardingLocation(() => current)).toBeNull();
    expect(location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });

  it.each([
    ['granted', 'granted', 'background-ready'],
    ['granted', 'undetermined', 'foreground-only'],
    ['denied', 'undetermined', 'denied'],
  ])('reports foreground=%s background=%s as %s', async (fg, bg, expected) => {
    location.getForegroundPermissionsAsync.mockResolvedValue(grant(fg));
    location.getBackgroundPermissionsAsync.mockResolvedValue(grant(bg));
    expect(await engine.start(config)).toBe(expected);
    expect(sdk.requestPermission).not.toHaveBeenCalled();
    expect(location.requestBackgroundPermissionsAsync).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
    if (expected === 'denied') expect(sdk.start).not.toHaveBeenCalled();
    else {
      const nativeConfig = sdk.ready.mock.calls[0][0];
      expect(nativeConfig.foregroundService).toBe(true);
      expect(nativeConfig.notification.smallIcon).toBe('drawable/notification_icon');
      expect(nativeConfig.notification.sticky).toBe(true);
      expect(nativeConfig.backgroundPermissionRationale.message).toContain('even when the app is closed or not in use');
      expect(JSON.stringify(nativeConfig.backgroundPermissionRationale)).not.toMatch(/CHANGEME|FEATURE X|FEATURE Y/);
      expect(nativeConfig.locationAuthorizationRequest).toBe(bg === 'granted' ? 'Always' : 'WhenInUse');
    }
  });

  it('a ready failure cannot be reported as a successful bootstrap', async () => {
    sdk.ready.mockRejectedValue(new Error('native ready failed'));
    expect(await engine.start(config)).toBe('failed');
    expect(sdk.start).not.toHaveBeenCalled();
  });

  it('reconciles a Settings grant without asking again', async () => {
    location.getBackgroundPermissionsAsync.mockResolvedValue(grant('denied'));
    expect(await engine.start(config)).toBe('foreground-only');
    location.getBackgroundPermissionsAsync.mockResolvedValue(grant('granted'));
    expect(await engine.start(config)).toBe('background-ready');
    expect(sdk.setConfig).toHaveBeenCalledWith(expect.objectContaining({ locationAuthorizationRequest: 'Always' }));
    expect(sdk.requestPermission).not.toHaveBeenCalled();
  });

  it('separates SDK tracking mode from OS authorization', async () => {
    location.getBackgroundPermissionsAsync.mockResolvedValue(grant('denied'));
    expect(await engine.getState()).toMatchObject({
      trackingMode: 'location-and-geofences', authorization: 'foreground-only',
    });
    sdk.getState.mockResolvedValue({ enabled: true, trackingMode: 0 });
    expect(await engine.getState()).toMatchObject({ trackingMode: 'geofences-only' });
  });

  it('does not start a disposed session', async () => {
    expect(await engine.start({ ...config, isCurrent: () => false })).toBe('failed');
    expect(sdk.ready).not.toHaveBeenCalled();
    expect(sdk.start).not.toHaveBeenCalled();
  });
});
