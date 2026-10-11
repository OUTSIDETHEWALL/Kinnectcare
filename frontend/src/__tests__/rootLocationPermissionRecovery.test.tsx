/* eslint-disable @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

// Mount the real RootLayout/RootNav with real permission, exclusivity, ownership
// and location-engine code. Only platform APIs, unrelated UI/services and the
// authenticated HTTP boundary are mocked. Never contact a live service.
describe('RootNav location recovery independent of notification onboarding', () => {
  let tree: ReturnType<typeof TestRenderer.create> | undefined;
  let Root: any;
  let sdk: any;
  let auth: any;
  let token: string | null;
  let members: any[];
  let sharing: boolean;
  let grants: { foreground: string; background: string };
  let data: Map<string, string>;
  let notifications: any;
  let location: any;
  let enabled: boolean;
  let stateListeners: Set<(state: string) => void>;
  let memberListeners: Set<() => void>;
  let router: any;
  const originalFetch = global.fetch;
  const originalBase = process.env.EXPO_PUBLIC_BACKEND_URL;
  const base = 'https://example.test';

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    jest.doMock('react', () => React);
    process.env.EXPO_PUBLIC_BACKEND_URL = base;
    global.fetch = jest.fn(async () => { throw new Error('Live network prohibited'); });
    auth = { user: { id: 'owner', family_group_id: 'family' }, loading: false };
    token = 'verified-session';
    members = [{ id: 'member', user_id: 'owner', family_group_id: 'family' }];
    sharing = true;
    grants = { foreground: 'granted', background: 'granted' };
    enabled = false;
    data = new Map([
      ['@kinnship/permissions_handled_v1', 'true'],
      ['@kinnship/permission_decision_v2', JSON.stringify({
        foreground: 'granted', background: 'granted', notifications: 'granted',
      })],
      ['@kinnship/background_location_disclosure_shown_v1', 'true'],
      ['kc_battery_opt_prompted_v1', 'true'],
    ]);
    stateListeners = new Set();
    memberListeners = new Set();
    router = { replace: jest.fn(), push: jest.fn() };
    const segments = ['(tabs)', 'dashboard'];
    const Stack = Object.assign(({ children }: any) => children, { Screen: () => null });
    jest.doMock('expo-router', () => ({
      Stack, useRouter: () => router, useSegments: () => segments,
      usePathname: () => '/dashboard',
    }));
    jest.doMock('react-native-safe-area-context', () => ({
      SafeAreaProvider: ({ children }: any) => children,
    }));
    jest.doMock('expo-status-bar', () => ({ StatusBar: () => null }));
    jest.doMock('react-native', () => ({
      Platform: { OS: 'android' }, View: 'View', ActivityIndicator: 'ActivityIndicator',
      StyleSheet: { create: (value: any) => value },
      Alert: { alert: jest.fn() },
      Linking: {
        getInitialURL: jest.fn(async () => null),
        addEventListener: jest.fn(() => ({ remove: jest.fn() })),
      },
      AppState: {
        currentState: 'active',
        addEventListener: jest.fn((_name, callback) => {
          stateListeners.add(callback);
          return { remove: () => stateListeners.delete(callback) };
        }),
      },
    }));
    jest.doMock('@react-native-async-storage/async-storage', () => ({
      getItem: jest.fn(async key => data.get(key) ?? null),
      setItem: jest.fn(async (key, value) => { data.set(key, value); }),
      removeItem: jest.fn(async key => { data.delete(key); }),
    }));
    location = {
      getForegroundPermissionsAsync: jest.fn(async () => ({ status: grants.foreground })),
      getBackgroundPermissionsAsync: jest.fn(async () => ({ status: grants.background })),
      requestForegroundPermissionsAsync: jest.fn(async () => ({ status: grants.foreground })),
      requestBackgroundPermissionsAsync: jest.fn(async () => ({ status: grants.background })),
    };
    notifications = {
      getPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
      requestPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
      getLastNotificationResponseAsync: jest.fn(async () => null),
    };
    jest.doMock('expo-location', () => location);
    jest.doMock('expo-notifications', () => notifications);
    jest.doMock('expo-constants', () => ({ default: { expoConfig: {
      version: '1.3.0', android: { versionCode: 68 }, ios: { buildNumber: '68' },
    } } }));
    jest.doMock('expo-updates', () => ({ runtimeVersion: '1.3.0' }));
    jest.doMock('../AuthContext', () => ({
      AuthProvider: ({ children }: any) => children, useAuth: () => auth,
    }));
    jest.doMock('../api', () => ({
      getCurrentToken: jest.fn(async () => token),
      subscribeToTokenChanges: jest.fn(() => () => {}),
      api: {
        get: jest.fn(async path => ({ data: path === '/members' ? members
          : path === '/auth/me' ? auth.user : path === '/me/preferences'
            ? { location_sharing_enabled: sharing } : [] })),
        put: jest.fn(async () => ({})), post: jest.fn(async () => ({})),
      },
    }));
    jest.doMock('../store/memberStore', () => ({
      fetchAll: jest.fn(async () => members),
      getMyMember: (userId: string) => members.find(member => member.user_id === userId),
      subscribeMember: (callback: () => void) => {
        memberListeners.add(callback); return () => memberListeners.delete(callback);
      },
      upsertOne: jest.fn(),
    }));
    sdk = {
      registerHeadlessTask: jest.fn(), removeListeners: jest.fn(),
      ready: jest.fn(async () => ({ enabled, trackingMode: 1 })),
      setConfig: jest.fn(async () => {}),
      getState: jest.fn(async () => ({
        enabled, trackingMode: 1, url: `${base}/api/members/member/location`,
        authorization: { accessToken: token },
      })),
      start: jest.fn(async () => { enabled = true; return { enabled }; }),
      stop: jest.fn(async () => { enabled = false; }),
    };
    for (const name of ['onLocation', 'onMotionChange', 'onActivityChange', 'onHeartbeat',
      'onProviderChange', 'onHttp', 'onEnabledChange', 'onPowerSaveChange']) {
      sdk[name] = jest.fn(() => ({ remove: jest.fn() }));
    }
    jest.doMock('react-native-background-geolocation', () => ({ default: sdk }));
    jest.doMock('expo-battery', () => ({
      addBatteryLevelListener: jest.fn(), addBatteryStateListener: jest.fn(),
    }));
    jest.doMock('expo-task-manager', () => ({
      defineTask: jest.fn(), isTaskDefined: () => true,
    }));
    jest.doMock('../push', () => ({
      setupNotificationsForOS: jest.fn(() => require('../permissionCoordinator').notificationPermission(false)),
      registerForPushNotifications: jest.fn(() => require('../permissionCoordinator').notificationPermission(false)),
      refreshPushTokenIfStale: jest.fn(async () => {}),
      dismissStaleAreYouOkNotifs: jest.fn(async () => {}),
      setAppReadyForDeepLink: jest.fn(), useNotificationListeners: jest.fn(),
    }));
    jest.doMock('../onboardingStore', () => ({
      isOnboardingDone: jest.fn(async () => true), markOnboardingDone: jest.fn(async () => {}),
    }));
    jest.doMock('../pinAuth', () => ({ hasPinForUser: jest.fn(async () => false), isUnlockedNow: () => true }));
    jest.doMock('../appLock', () => ({
      isAppLockEnabled: jest.fn(async () => false),
      needsAppLockUnlock: jest.fn(async () => false),
      shouldShowAppLockMigrationNotice: jest.fn(async () => false),
      markAppLockMigrationNoticeShown: jest.fn(async () => {}),
    }));
    jest.doMock('../backgroundLocation', () => ({
      stopBackgroundLocation: jest.fn(async () => true), startBackgroundLocation: jest.fn(async () => true),
    }));
    jest.doMock('../batteryTask', () => ({
      configureBatteryTask: jest.fn(async () => {}), BATTERY_OPT_PROMPTED_KEY: 'kc_battery_opt_prompted_v1',
    }));
    jest.doMock('../locationRefresh', () => ({
      refreshLocationIfStale: jest.fn(async () => {}),
      setMyMemberId: jest.fn(async () => {}), setMyUserId: jest.fn(async () => {}),
    }));
    jest.doMock('../leonidas', () => ({ start: jest.fn(), stop: jest.fn() }));
    jest.doMock('../disclaimerStore', () => ({
      loadDisclaimerAck: jest.fn(async () => true), getDisclaimerAckSync: () => true,
      subscribeDisclaimerAck: jest.fn(() => () => {}),
    }));
    jest.doMock('../pendingInvite', () => ({
      getPendingInvite: jest.fn(async () => null), setPendingInvite: jest.fn(async () => {}),
      isInviteConsumed: jest.fn(async () => false),
    }));
    jest.doMock('../resumeDiagnostics', () => ({ logResumeDecision: jest.fn(), isAlertDismissed: jest.fn(async () => false) }));
    jest.doMock('../activeEmergency', () => ({ setActiveEmergency: jest.fn() }));
    jest.doMock('../refreshPipelineLog', () => ({ logPipelineEvent: jest.fn() }));
    jest.doMock('../startupDiagnostics', () => ({ logStartupEvent: jest.fn() }));
    jest.doMock('../nativeStartupRecorder', () => ({ recordNativeStartupCheckpoint: jest.fn() }));
    Root = require('../../app/_layout').default;
  });

  afterEach(async () => {
    if (tree) await act(async () => { tree!.unmount(); });
    tree = undefined;
    jest.clearAllTimers();
    jest.useRealTimers();
    global.fetch = originalFetch;
    process.env.EXPO_PUBLIC_BACKEND_URL = originalBase;
  });
  async function flush() {
    for (let i = 0; i < 8; i++) await act(async () => {
      for (let n = 0; n < 100; n++) await Promise.resolve();
    });
  }
  async function mount() {
    await act(async () => { tree = TestRenderer.create(<Root />); });
    await flush();
  }
  function notificationBehavior(behavior: string) {
    if (behavior === 'reject') notifications.getPermissionsAsync.mockRejectedValue(new Error('query failed'));
    else if (behavior === 'never') notifications.getPermissionsAsync.mockImplementation(() => new Promise(() => {}));
    else notifications.getPermissionsAsync.mockResolvedValue({ status: behavior });
  }
  async function resume() {
    await act(async () => {
      for (const state of ['background', 'active']) for (const callback of stateListeners) callback(state);
    });
    await flush();
  }
  const behaviors = ['granted', 'denied', 'reject', 'never'];
  it.each(behaviors)('actual RootNav repairs a disabled tracker with notification query %s', async behavior => {
    notificationBehavior(behavior);
    await mount();
    expect(notifications.getPermissionsAsync).toHaveBeenCalled();
    expect(sdk.start).toHaveBeenCalledTimes(1);
    expect(enabled).toBe(true);
    expect(router.replace).not.toHaveBeenCalledWith('/(auth)/permissions');
    expect(location.requestBackgroundPermissionsAsync).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it.each(behaviors.flatMap(behavior => ['foreground', 'background'].map(permission => [behavior, permission])))(
    '%s notification query cannot bypass absent %s location permission', async (behavior, permission) => {
      notificationBehavior(behavior);
      grants[permission as keyof typeof grants] = 'denied';
      enabled = true;
      await mount();
      expect(sdk.start).not.toHaveBeenCalled();
      expect(sdk.stop).toHaveBeenCalled();
      expect(enabled).toBe(false);
    },
  );
  it.each(behaviors.flatMap(behavior => ['revoked', 'opt-out', 'signout', 'invalid-owner', 'no-disclosure']
    .map(boundary => [behavior, boundary])))(
    '%s notification query cannot bypass %s', async (behavior, boundary) => {
      notificationBehavior(behavior);
      if (boundary === 'revoked') await require('../androidTrackingRecovery').revokeTrackingIntent('consent');
      if (boundary === 'opt-out') sharing = false;
      if (boundary === 'signout') { auth = { user: null, loading: false }; token = null; }
      if (boundary === 'invalid-owner') members = [{ id: 'member', user_id: 'another-owner' }];
      if (boundary === 'no-disclosure') data.delete('@kinnship/background_location_disclosure_shown_v1');
      await mount();
      if (boundary === 'invalid-owner') {
        await act(async () => { jest.advanceTimersByTime(90_000); });
        await flush();
      }
      expect(sdk.start).not.toHaveBeenCalled();
      expect(enabled).toBe(false);
    },
  );
  it.each(behaviors)('RootNav observes permission withdrawal on resume despite notification %s', async behavior => {
    notificationBehavior(behavior);
    await mount();
    expect(enabled).toBe(true);
    grants.background = 'denied';
    await resume();
    expect(enabled).toBe(false);
    expect(sdk.start).toHaveBeenCalledTimes(1);
    grants.background = 'granted';
    await resume();
    expect(enabled).toBe(true);
    expect(sdk.start).toHaveBeenCalledTimes(2);
  });
  it.each(behaviors.flatMap(behavior => ['signout', 'consent', 'member-loss'].map(boundary => [behavior, boundary])))(
    'an already-running RootNav stops for %s notification state / %s', async (behavior, boundary) => {
      notificationBehavior(behavior);
      await mount();
      expect(enabled).toBe(true);
      if (boundary === 'signout') {
        auth = { user: null, loading: false }; token = null;
        await act(async () => { tree!.update(<Root />); });
      }
      if (boundary === 'consent') {
        await act(async () => {
          await jest.requireActual('../backgroundLocation').setLocationSharingEnabled(false);
        });
      }
      if (boundary === 'member-loss') {
        members = [{ id: 'member', user_id: 'another-owner' }];
        await act(async () => { for (const callback of memberListeners) callback(); });
        await act(async () => { jest.advanceTimersByTime(90_000); });
      }
      await flush();
      expect(enabled).toBe(false);
      expect(sdk.start).toHaveBeenCalledTimes(1);
    },
  );
  it('location onboarding completion unblocks RootNav before a lost notification query completes', async () => {
    data.delete('@kinnship/permissions_handled_v1');
    data.delete('@kinnship/background_location_disclosure_shown_v1');
    grants.background = 'denied';
    notificationBehavior('never');
    await mount();
    expect(sdk.start).not.toHaveBeenCalled();
    data.set('@kinnship/background_location_disclosure_shown_v1', 'true');
    grants.background = 'granted';
    await act(async () => { await require('../permissionCoordinator').requestOnboardingLocation(); });
    await flush();
    expect(sdk.start).toHaveBeenCalledTimes(1);
    expect(enabled).toBe(true);
    // Overall notification/setup UI is still independent of native readiness.
    expect(data.get('@kinnship/permissions_handled_v1')).toBeUndefined();
  });
  it('coalesces a permission-change event received during a pending reconciliation', async () => {
    notificationBehavior('never');
    await mount();
    let resolveOld!: (value: any) => void;
    location.getBackgroundPermissionsAsync.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    await resume();
    grants.background = 'denied';
    await resume();
    await act(async () => { resolveOld({ status: 'granted' }); });
    await flush();
    expect(enabled).toBe(false);
    expect(sdk.start).toHaveBeenCalledTimes(1);
  });
  it.each(behaviors)('saving an explicit setup decision never awaits notification %s', async behavior => {
    notificationBehavior(behavior);
    data.delete('@kinnship/permissions_handled_v1');
    await mount();
    await act(async () => { await require('../permissionsStore').markPermissionsHandled(); });
    expect(data.get('@kinnship/permissions_handled_v1')).toBe('true');
    expect(await require('../permissionsStore').isPermissionsHandled()).toBe(true);
    expect(enabled).toBe(true);
  });
});
