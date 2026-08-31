/**
 * Regression coverage for the missed check-in deep-link's return action.
 *
 * This mounts RootLayout so the real app-level AppState resume handlers are
 * installed, then renders the real missed-check-in screen inside the mocked
 * stack.  The button is located and tapped only after a background → active
 * transition has been delivered to those handlers.
 */

(global as any).IS_REACT_ACT_ENVIRONMENT = true;

const mockAppStateListeners = new Set<(nextState: string) => void>();
const mockRouterReplace = jest.fn();
const mockRouter = { replace: mockRouterReplace };
const mockApiGet = jest.fn();
const mockRouteContent = jest.fn<any, []>(() => null);
const mockSegments = ['(tabs)'];

jest.mock('react-native', () => {
  const React = require('react');

  function wrap(name: string) {
    const Component = ({ children, ...props }: any) =>
      React.createElement(name, props, children);
    Component.displayName = name;
    return Component;
  }

  return {
    __esModule: true,
    View: wrap('View'),
    Text: wrap('Text'),
    ScrollView: wrap('ScrollView'),
    TouchableOpacity: wrap('TouchableOpacity'),
    ActivityIndicator: wrap('ActivityIndicator'),
    StyleSheet: { create: (styles: any) => styles },
    Platform: {
      OS: 'ios',
      select: (options: any) => options.ios ?? options.default ?? Object.values(options)[0],
    },
    Alert: { alert: jest.fn() },
    Linking: {
      openURL: jest.fn(() => Promise.resolve()),
      getInitialURL: jest.fn(() => Promise.resolve(null)),
      addEventListener: jest.fn(() => ({ remove: jest.fn() })),
      openSettings: jest.fn(() => Promise.resolve()),
    },
    AppState: {
      currentState: 'active',
      addEventListener: jest.fn((_event: string, listener: (nextState: string) => void) => {
        mockAppStateListeners.add(listener);
        return {
          remove: jest.fn(() => mockAppStateListeners.delete(listener)),
        };
      }),
    },
  };
});

jest.mock('expo-router', () => {
  const React = require('react');
  const MockStack: any = function MockStack({ children }: any) {
    return React.createElement('Stack', null, children, mockRouteContent());
  };
  MockStack.Screen = function MockStackScreen() {
    return null;
  };

  return {
    Stack: MockStack,
    useLocalSearchParams: () => ({ id: 'checkin-alert-001' }),
    useRouter: () => mockRouter,
    useSegments: () => mockSegments,
    usePathname: () => '/missed-checkin/checkin-alert-001',
  };
});

jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const SafeArea = ({ children, ...props }: any) =>
    React.createElement('SafeAreaView', props, children);
  return {
    SafeAreaProvider: SafeArea,
    SafeAreaView: SafeArea,
  };
});

jest.mock('expo-status-bar', () => ({
  StatusBar: () => null,
}));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { deviceName: 'Test Device', expoConfig: { ios: { buildNumber: '1' } } },
}));

jest.mock('expo-updates', () => ({
  __esModule: true,
  updateId: 'test-update',
  channel: 'test',
}));

jest.mock('expo-notifications', () => ({
  dismissNotificationAsync: jest.fn(() => Promise.resolve()),
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(() => Promise.resolve(null)),
    setItem: jest.fn(() => Promise.resolve()),
    removeItem: jest.fn(() => Promise.resolve()),
  },
}));

jest.mock('../Icon', () => ({ Icon: () => null }));
jest.mock('../MemberMap', () => ({ __esModule: true, default: () => null }));
jest.mock('../timeFormat', () => ({ formatRelativeLocal: () => '2 min ago' }));
jest.mock('../theme', () => ({
  Colors: {
    background: '#F9FAFB',
    surface: '#FFFFFF',
    textPrimary: '#111827',
    textSecondary: '#374151',
    textTertiary: '#6B7280',
    primary: '#0f766e',
    warning: '#D97706',
    success: '#16A34A',
    border: '#E5E7EB',
    tertiary: '#F3F4F6',
  },
}));

jest.mock('../store/memberStore', () => ({
  useMember: () => null,
  fetchAll: jest.fn(() => Promise.resolve([])),
  fetchOne: jest.fn(() => Promise.resolve()),
  subscribeMember: jest.fn(() => jest.fn()),
}));

jest.mock('../tracking/TrackingStatusPill', () => ({
  TrackingStatusPill: () => null,
}));

jest.mock('../api', () => ({
  api: {
    get: (...args: any[]) => mockApiGet(...args),
  },
  getCurrentToken: jest.fn(() => Promise.resolve('test-token')),
  subscribeToTokenChanges: jest.fn(() => jest.fn()),
}));

jest.mock('../AuthContext', () => ({
  AuthProvider: ({ children }: any) => children,
  useAuth: () => ({ user: { id: 'caregiver-001' }, loading: false }),
}));

jest.mock('../push', () => ({
  registerForPushNotifications: jest.fn(() => Promise.resolve()),
  setupNotificationsForOS: jest.fn(() => Promise.resolve()),
  useNotificationListeners: jest.fn(),
  setAppReadyForDeepLink: jest.fn(),
  refreshPushTokenIfStale: jest.fn(() => Promise.resolve()),
  dismissStaleAreYouOkNotifs: jest.fn(() => Promise.resolve()),
}));

jest.mock('../onboardingStore', () => ({
  isOnboardingDone: jest.fn(() => Promise.resolve(true)),
  markOnboardingDone: jest.fn(() => Promise.resolve()),
}));

jest.mock('../pinAuth', () => ({
  hasPinForUser: jest.fn(() => Promise.resolve(false)),
  isUnlockedNow: jest.fn(() => false),
}));

jest.mock('../appLock', () => ({
  isAppLockEnabled: jest.fn(() => Promise.resolve(false)),
  markAppLockMigrationNoticeShown: jest.fn(() => Promise.resolve()),
  needsAppLockUnlock: jest.fn(() => false),
  shouldShowAppLockMigrationNotice: jest.fn(() => Promise.resolve(false)),
}));

jest.mock('../backgroundLocation', () => ({
  startBackgroundLocation: jest.fn(() => Promise.resolve()),
  stopBackgroundLocation: jest.fn(() => Promise.resolve()),
}));

jest.mock('../batteryTask', () => ({
  configureBatteryTask: jest.fn(() => Promise.resolve()),
  BATTERY_OPT_PROMPTED_KEY: 'battery-opt-prompted',
}));

jest.mock('../locationRefresh', () => ({
  refreshLocationIfStale: jest.fn(() => Promise.resolve()),
  setMyMemberId: jest.fn(() => Promise.resolve()),
  setMyUserId: jest.fn(() => Promise.resolve()),
}));

jest.mock('../locationEngine', () => ({
  setDeviceInfo: jest.fn(),
  logEvent: jest.fn(() => Promise.resolve()),
  getPipelineTimestamps: jest.fn(() => Promise.resolve({
    motion: null,
    activity: null,
    location: null,
    heartbeat_js: null,
    headless_invoked: null,
    headless_heartbeat: null,
    http_attempt: null,
    http_success: null,
  })),
  getState: jest.fn(() => Promise.resolve({
    enabled: false,
    isMoving: false,
    trackingMode: 'idle',
  })),
  isListenersAttached: jest.fn(() => false),
  isAvailable: jest.fn(() => false),
  start: jest.fn(() => Promise.resolve()),
  stop: jest.fn(() => Promise.resolve()),
  setAuthToken: jest.fn(() => Promise.resolve()),
}));

jest.mock('../leonidas', () => ({
  start: jest.fn(),
  stop: jest.fn(),
}));

jest.mock('../refreshPipelineLog', () => ({
  logPipelineEvent: jest.fn(),
}));

jest.mock('../disclaimerStore', () => ({
  loadDisclaimerAck: jest.fn(() => Promise.resolve(true)),
  subscribeDisclaimerAck: jest.fn(() => jest.fn()),
  getDisclaimerAckSync: jest.fn(() => true),
}));

jest.mock('../resumeDiagnostics', () => ({
  logResumeDecision: jest.fn(),
  isAlertDismissed: jest.fn(() => false),
}));

jest.mock('../activeEmergency', () => ({
  setActiveEmergency: jest.fn(),
}));

jest.mock('../pendingInvite', () => ({
  setPendingInvite: jest.fn(() => Promise.resolve()),
  clearPendingInvite: jest.fn(() => Promise.resolve()),
  getPendingInvite: jest.fn(() => Promise.resolve(null)),
}));

jest.mock('../permissionsStore', () => ({
  isPermissionsHandled: jest.fn(() => Promise.resolve(true)),
}));

import React from 'react';
import { act, create } from 'react-test-renderer';
import RootLayout from '../../app/_layout';
import MissedCheckinDetail from '../../app/missed-checkin/[id]';

function makeMissedCheckin() {
  return {
    id: 'checkin-alert-001',
    member_id: 'member-001',
    member_name: 'Test Member',
    type: 'missed_checkin',
    severity: 'warning',
    title: 'Missed check-in',
    message: 'Test Member was expected to check in by 09:00.',
    acknowledged: false,
    resolved: false,
    resolved_by_name: null,
    resolved_at: null,
    created_at: '2026-08-24T12:00:00.000Z',
    latitude: null,
    longitude: null,
  };
}

function findByTestID(root: ReturnType<typeof create>['root'], testID: string) {
  return root.findAll(
    (node: any) => node.props != null && node.props.testID === testID,
    { deep: true },
  )[0] ?? null;
}

async function flushPromises() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

async function renderAppWithMissedCheckin() {
  mockApiGet.mockResolvedValue({ data: [makeMissedCheckin()] });
  mockRouteContent.mockImplementation(() => <MissedCheckinDetail />);

  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<RootLayout />);
    await flushPromises();
  });
  return renderer;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAppStateListeners.clear();
  mockRouteContent.mockReturnValue(null);
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('MissedCheckinDetail — Return to Dashboard after app resume', () => {
  it('keeps checkin-back tappable after real app background/resume handling', async () => {
    const renderer = await renderAppWithMissedCheckin();
    const buttonBeforeResume = findByTestID(renderer.root, 'checkin-back');

    expect(buttonBeforeResume).not.toBeNull();
    expect(mockAppStateListeners.size).toBeGreaterThan(0);
    expect(buttonBeforeResume?.props.disabled).not.toBe(true);

    await act(async () => {
      for (const listener of [...mockAppStateListeners]) listener('background');
      for (const listener of [...mockAppStateListeners]) listener('active');
      jest.advanceTimersByTime(400);
      await flushPromises();
    });

    const buttonAfterResume = findByTestID(renderer.root, 'checkin-back');
    expect(buttonAfterResume).not.toBeNull();
    expect(buttonAfterResume?.props.disabled).not.toBe(true);
    expect(mockRouterReplace).not.toHaveBeenCalled();

    await act(async () => {
      buttonAfterResume?.props.onPress();
    });

    expect(mockRouterReplace).toHaveBeenCalledTimes(1);
    expect(mockRouterReplace).toHaveBeenCalledWith('/(tabs)/dashboard');
  });
});