/* Controlled investigation only. No application code is replaced on disk. */
import React from 'react';
import { act, create } from 'react-test-renderer';

export const NOW = Date.parse('2026-11-20T01:38:40Z');
export const incident = (extra: Record<string, unknown> = {}) => ({
  id: 'synthetic-sos', owner_id: 'synthetic-owner', member_id: 'synthetic-owner',
  family_group_id: 'synthetic-family', member_name: 'Synthetic member',
  type: 'sos', severity: 'critical', title: 'Synthetic SOS', message: 'Fixture only',
  created_at: new Date(NOW - 10_000).toISOString(), acknowledged: false, resolved: false,
  latitude: null, longitude: null, ...extra,
});
export const profile = (extra: Record<string, unknown> = {}) => ({
  id: 'synthetic-profile', user_id: 'synthetic-owner', family_group_id: 'synthetic-family',
  name: 'Synthetic member', location_consent_generation: 1, location_sharing_enabled: true,
  latitude: 20, longitude: 30, coordinate_captured_at: new Date(NOW - 20_000).toISOString(),
  ...extra,
});
export function deferred() {
  let resolve!: (value: any) => void;
  let reject!: (error: any) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export async function flush() {
  for (let i = 0; i < 35; i++) await Promise.resolve();
}

/** Real RootNav + real push handoff + real incident and map components.
 * The router is an explicit in-memory COMMITTING adapter, not Android's Stack.
 * It mounts the destination and updates pathname/segments on the next render.
 * Platform boundaries, unrelated startup services and all HTTP are intercepted.
 */
export function setupSosInvestigation({ realMap = false, root = false, androidWebView = false } = {}) {
  jest.resetModules();
  jest.doMock('react', () => React);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const originalFetch = global.fetch;
  const originalKey = process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY;
  process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY = 'synthetic-not-a-credential';
  const forbiddenNetwork = jest.fn(() => { throw new Error('Live network prohibited'); });
  global.fetch = forbiddenNetwork as any;
  const h: any = {
    route: root ? '/(tabs)/dashboard' : '/alert/synthetic-sos',
    rows: [incident()], profiles: [], loading: false, authDelay: false,
    storage: new Map(), state: 'active', listeners: new Set<Function>(),
    lastResponse: null, responseListener: null, tree: undefined, errors: [],
    mapThrows: false, Root: null,
  };
  const asyncNoop = jest.fn(async () => {});
  const noop = jest.fn();
  const post = jest.fn(async (path: string) => {
    if (!/^\/members\/synthetic-profile\/request-location-refresh$/.test(path)) {
      throw new Error(`Forbidden POST: ${path}`);
    }
    return { data: { sent_to: 0 } };
  });
  const get = jest.fn(async (path: string) => {
    if (path === '/alerts') return { data: h.rows };
    if (path === '/members') return { data: h.profiles };
    if (path === '/auth/me') return { data: h.auth.user };
    if (path === '/me/preferences') return { data: { location_sharing_enabled: false } };
    throw new Error(`Unstubbed GET: ${path}`);
  });
  h.get = get; h.post = post; h.network = forbiddenNetwork;
  h.auth = { user: { id: 'synthetic-viewer', family_group_id: 'synthetic-family' }, loading: false };
  h.navigate = (path: any) => {
    const next = typeof path === 'string' ? path
      : path.pathname.replace('[id]', path.params.id);
    if (h.route === next) return;
    h.route = next;
    h.tree?.update(React.createElement(h.Root));
  };
  const router = { replace: jest.fn(h.navigate), push: jest.fn(h.navigate) };
  h.router = router;
  jest.doMock('expo-router', () => {
    function Stack() {
      return h.route.startsWith('/alert/')
        ? React.createElement(require('../../../app/alert/[id]').default)
        : React.createElement('CommittedRoute', { testID: `committed:${h.route}` });
    }
    Stack.Screen = () => null;
    return {
      Stack, useRouter: () => router,
      usePathname: () => h.route.replace('/(tabs)', ''),
      useSegments: () => h.route.startsWith('/alert/') ? ['alert', '[id]'] : ['(tabs)', h.route.split('/').pop()],
      useLocalSearchParams: () => ({ id: h.route.split('/').pop() }),
    };
  });
  jest.doMock('@react-navigation/native', () => ({ useIsFocused: () => h.route.startsWith('/alert/') }));
  jest.doMock('react-native', () => ({
    View: 'View', Text: 'Text', ScrollView: 'ScrollView', TouchableOpacity: 'TouchableOpacity',
    ActivityIndicator: 'ActivityIndicator', Image: { resolveAssetSource: (v: any) => v },
    StyleSheet: { create: (v: any) => v, flatten: (v: any) => v },
    Platform: { OS: 'android', select: (v: any) => v.android ?? v.default },
    Alert: { alert: noop },
    Linking: {
      openURL: jest.fn(() => { throw new Error('Dialer/external URL prohibited'); }),
      getInitialURL: async () => null, addEventListener: () => ({ remove: noop }),
    },
    AppState: {
      get currentState() { return h.state; },
      addEventListener: (_: string, cb: Function) => {
        h.listeners.add(cb); return { remove: () => h.listeners.delete(cb) };
      },
    },
  }));
  jest.doMock('react-native-safe-area-context', () => ({
    SafeAreaView: 'SafeAreaView', SafeAreaProvider: ({ children }: any) => children,
  }));
  h.webview = { injectJavaScript: jest.fn() };
  jest.doMock('react-native-webview', () => androidWebView ? {
    WebView: jest.requireActual('react-native-webview/lib/WebView.android').default,
  } : ({
    WebView: React.forwardRef((props: any, ref: any) => {
      React.useImperativeHandle(ref, () => h.webview);
      if (h.mapThrows) throw new Error('Synthetic native map mount error');
      return React.createElement('ControlledWebView', props);
    }),
  }));
  if (androidWebView) jest.dontMock('../../Icon');
  else jest.doMock('../../Icon', () => ({ Icon: () => null }));
  if (realMap) jest.dontMock('../../MemberMap');
  else jest.doMock('../../MemberMap', () => ({ __esModule: true, default: () => React.createElement('SubstitutedMap') }));
  if (androidWebView) {
    jest.dontMock('../../screenRenderLog');
    jest.dontMock('../../pipelineSnapshot');
  } else {
    jest.doMock('../../screenRenderLog', () => ({ logScreenRender: asyncNoop }));
    jest.doMock('../../pipelineSnapshot', () => ({ observeMapProps: noop, observeMapRendered: noop }));
  }
  jest.doMock('../../AuthContext', () => ({
    AuthProvider: ({ children }: any) => children, useAuth: () => h.auth,
  }));
  jest.doMock('../../api', () => ({
    api: { get, post, put: asyncNoop }, getCurrentToken: async () => null,
    subscribeToTokenChanges: () => () => {}, migrateTokenForBackgroundActions: asyncNoop,
  }));
  jest.doMock('@react-native-async-storage/async-storage', () => ({
    __esModule: true, default: {
      getItem: async (k: string) => h.storage.get(k) ?? null,
      setItem: async (k: string, v: string) => { h.storage.set(k, v); },
      removeItem: async (k: string) => { h.storage.delete(k); },
    },
  }));
  const dismissed = new Set();
  jest.doMock('../../resumeDiagnostics', () => ({
    logResumeDecision: jest.fn(), isAlertDismissed: (id: string) => dismissed.has(id),
    markAlertDismissed: (id: string) => dismissed.add(id),
  }));
  jest.doMock('../../activeEmergency', () => ({ setActiveEmergency: noop }));
  jest.doMock('expo-status-bar', () => ({ StatusBar: () => null }));
  jest.doMock('expo-constants', () => ({ __esModule: true, default: { expoConfig: {} } }));
  jest.doMock('expo-updates', () => ({}));
  jest.doMock('expo-device', () => ({ isDevice: false }));
  jest.doMock('expo-task-manager', () => ({ isTaskDefined: () => true, registerTaskAsync: asyncNoop }));
  jest.doMock('expo-notifications', () => ({
    DEFAULT_ACTION_IDENTIFIER: 'default',
    AndroidNotificationPriority: { MIN: 'min', MAX: 'max' },
    setNotificationHandler: noop, registerTaskAsync: asyncNoop,
    getLastNotificationResponseAsync: async () => h.lastResponse,
    clearLastNotificationResponseAsync: async () => { h.lastResponse = null; },
    addNotificationReceivedListener: () => ({ remove: noop }),
    addNotificationResponseReceivedListener: (cb: any) => {
      h.responseListener = cb; return { remove: () => { h.responseListener = null; } };
    },
    getPresentedNotificationsAsync: async () => [], dismissNotificationAsync: asyncNoop,
  }));
  jest.doMock('../../medicationAcknowledgment', () => ({
    handleMedicationAction: asyncNoop, replayPendingMedicationAcknowledgments: asyncNoop,
  }));
  jest.doMock('../../locationRecoveryPush', () => ({ handleSilentLocationRecoveryPush: asyncNoop }));
  jest.doMock('../../permissionCoordinator', () => ({
    notificationPermission: async () => ({ status: 'denied' }),
    readPermissionSnapshot: async () => ({ foreground: 'denied', background: 'denied', notifications: 'denied' }),
    subscribeLocationPermissionChanges: () => () => {},
  }));
  // Retain REAL response queue/listener, intercept only unrelated OS setup.
  jest.doMock('../../push', () => ({
    ...jest.requireActual('../../push'), setupNotificationsForOS: asyncNoop,
    registerForPushNotifications: asyncNoop, refreshPushTokenIfStale: asyncNoop,
    dismissStaleAreYouOkNotifs: asyncNoop,
  }));
  for (const [name, exports] of Object.entries({
    onboardingStore: { isOnboardingDone: async () => true, markOnboardingDone: asyncNoop },
    pinAuth: { hasPinForUser: async () => false, isUnlockedNow: () => true },
    appLock: { isAppLockEnabled: async () => false, needsAppLockUnlock: () => false,
      shouldShowAppLockMigrationNotice: async () => false, markAppLockMigrationNoticeShown: asyncNoop },
    backgroundLocation: { stopBackgroundLocation: asyncNoop },
    locationEngineExclusivity: { ensureTransistorLocationEngine: asyncNoop,
      needsLocationEngineBootstrap: () => false, startLegacyLocationFallback: asyncNoop },
    batteryTask: { configureBatteryTask: asyncNoop, BATTERY_OPT_PROMPTED_KEY: 'synthetic-battery' },
    locationRefresh: { refreshLocationIfStale: asyncNoop, setMyMemberId: asyncNoop, setMyUserId: asyncNoop },
    locationEngine: { setDeviceInfo: noop, logEvent: asyncNoop, getPipelineTimestamps: async () => ({}),
      getState: async () => ({}), isListenersAttached: () => false, setAuthToken: asyncNoop },
    trackingReliability: { readTrackingAuthority: async () => null },
    leonidas: { start: noop, stop: noop },
    disclaimerStore: { loadDisclaimerAck: async () => true, getDisclaimerAckSync: () => true,
      subscribeDisclaimerAck: () => () => {} },
    pendingInvite: { getPendingInvite: async () => null, setPendingInvite: asyncNoop, isInviteConsumed: async () => false },
    permissionsStore: { isPermissionsHandled: async () => true },
    backgroundLocationDisclosure: { isBackgroundLocationDisclosureAcknowledged: async () => true },
    startupDiagnostics: { logStartupEvent: noop, markStartupMilestone: noop },
    nativeStartupRecorder: { recordNativeStartupCheckpoint: noop },
    emailLinks: { captureEmailLink: () => false },
    androidTrackingRecovery: { subscribeToTrackingPolicy: () => () => {} },
    refreshPipelineLog: { logPipelineEvent: noop },
    'store/memberStore': { fetchAll: async () => [], getMyMember: () => null, subscribeMember: () => () => {} },
  })) jest.doMock(`../../${name}`, () => exports);
  h.Root = root ? require('../../../app/_layout').default : require('../../../app/alert/[id]').default;
  h.mount = async () => {
    await act(async () => { h.tree = create(React.createElement(h.Root)); await flush(); });
  };
  h.advance = async (ms: number) => act(async () => { await jest.advanceTimersByTimeAsync(ms); await flush(); });
  h.find = (id: string) => h.tree.root.findAllByProps({ testID: id });
  h.appState = async (state: string) => act(async () => {
    h.state = state; [...h.listeners].forEach((cb: any) => cb(state)); await flush();
  });
  h.dispose = async () => {
    if (h.tree) await act(async () => { h.tree.unmount(); await flush(); });
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY;
    else process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY = originalKey;
    expect(forbiddenNetwork).not.toHaveBeenCalled();
  };
  return h;
}
