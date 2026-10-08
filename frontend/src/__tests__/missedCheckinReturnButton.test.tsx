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
let mockSegments = ['(tabs)'];
let mockNotificationCallback: ((data: any) => void) | null = null;
let mockPendingNotification: any = null;
let mockAuthUser: { id: string } | null = { id: 'caregiver-001' };
let mockAuthLoading = false;
let mockPermissionSnapshot = { foreground: 'granted', background: 'granted', notifications: 'granted' };

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
  getMyMember: jest.fn(() => undefined),
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
  useAuth: () => ({ user: mockAuthUser, loading: mockAuthLoading }),
}));

jest.mock('../push', () => ({
  registerForPushNotifications: jest.fn(() => Promise.resolve()),
  setupNotificationsForOS: jest.fn(() => Promise.resolve()),
  useNotificationListeners: jest.fn((callback: (data: any) => void) => {
    mockNotificationCallback = callback;
  }),
  setAppReadyForDeepLink: jest.fn((ready: boolean) => {
    if (ready && mockNotificationCallback && mockPendingNotification) {
      const pending = mockPendingNotification;
      setTimeout(() => {
        try {
          mockNotificationCallback?.(pending);
          mockPendingNotification = null;
        } catch (_error) {
          // Match the real durable queue: a closed gate retains the response.
        }
      }, 0);
    }
  }),
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
  stopBackgroundLocation: jest.fn(() => Promise.resolve(true)),
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
  start: jest.fn(() => Promise.resolve('background-ready')),
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

jest.mock('../permissionCoordinator', () => ({
  readPermissionSnapshot: jest.fn(async () => ({ ...mockPermissionSnapshot })),
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
  mockSegments = ['(tabs)'];
  mockNotificationCallback = null;
  mockPendingNotification = null;
  mockAuthUser = { id: 'caregiver-001' };
  mockAuthLoading = false;
  mockPermissionSnapshot = { foreground: 'granted', background: 'granted', notifications: 'granted' };
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

describe('Android permission gates and tracking lifecycle at the real navigation root', () => {
  const native = require('react-native');
  const members = require('../store/memberStore');
  const engine = require('../locationEngine');
  const permissions = require('../permissionsStore');
  const push = require('../push');
  const leonidas = require('../leonidas');
  const originalBackendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
  let me: any;
  let subscribers: Set<(member: any) => void>;

  beforeEach(() => {
    process.env.EXPO_PUBLIC_BACKEND_URL = 'https://example.test';
    native.Platform.OS = 'android';
    me = { id: 'member-001', user_id: 'caregiver-001' };
    subscribers = new Set();
    members.getMyMember.mockImplementation(() => me);
    members.fetchAll.mockImplementation(async () => me ? [me] : []);
    members.subscribeMember.mockImplementation((callback: (member: any) => void) => {
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    });
    engine.isAvailable.mockReturnValue(true);
    engine.start.mockImplementation(async () => mockPermissionSnapshot.background === 'granted'
      ? 'background-ready' : 'foreground-only');
    permissions.isPermissionsHandled.mockResolvedValue(true);
    mockApiGet.mockResolvedValue({ data: [] });
  });

  afterEach(() => {
    if (originalBackendUrl === undefined) delete process.env.EXPO_PUBLIC_BACKEND_URL;
    else process.env.EXPO_PUBLIC_BACKEND_URL = originalBackendUrl;
    native.Platform.OS = 'ios';
    members.getMyMember.mockImplementation(() => undefined);
    members.fetchAll.mockResolvedValue([]);
    members.subscribeMember.mockImplementation(() => jest.fn());
    engine.isAvailable.mockReturnValue(false);
    engine.start.mockResolvedValue('background-ready');
    permissions.isPermissionsHandled.mockResolvedValue(true);
  });

  async function mount() {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<RootLayout />);
      for (let i = 0; i < 10; i++) await flushPromises();
    });
    return renderer;
  }

  async function settle() {
    await act(async () => {
      for (let i = 0; i < 10; i++) await flushPromises();
    });
  }

  it.each(['clean install', 'restored app data', 'invited/new member', 'returning/rejoining member'])(
    'holds automatic tracking/push for %s until setup is handled', async () => {
      permissions.isPermissionsHandled.mockResolvedValue(false);
      const renderer = await mount();
      expect(engine.start).not.toHaveBeenCalled();
      expect(push.registerForPushNotifications).not.toHaveBeenCalled();
      expect(mockRouterReplace).toHaveBeenCalledWith('/(auth)/permissions');
      permissions.isPermissionsHandled.mockResolvedValue(true);
      mockSegments = ['(tabs)'];
      await act(async () => { renderer.update(<RootLayout />); });
      await settle();
      expect(engine.start).toHaveBeenCalledTimes(1);
      expect(leonidas.start).toHaveBeenCalledTimes(1);
      await act(async () => { renderer.unmount(); });
    },
  );

  it('a new family owner without a linked member never starts tracking', async () => {
    me = null;
    const renderer = await mount();
    await act(async () => { jest.advanceTimersByTime(91_000); });
    await settle();
    expect(engine.start).not.toHaveBeenCalled();
    expect(leonidas.start).not.toHaveBeenCalled();
    await act(async () => { renderer.unmount(); });
  });

  it('starts when delayed member linkage arrives after the old wait expired', async () => {
    me = null;
    const renderer = await mount();
    await act(async () => { jest.advanceTimersByTime(91_000); });
    await settle();
    expect(engine.start).not.toHaveBeenCalled();
    me = { id: 'late-member', user_id: 'caregiver-001' };
    await act(async () => {
      for (const callback of [...subscribers]) callback(me);
    });
    await settle();
    expect(engine.start).toHaveBeenCalledTimes(1);
    expect(engine.start).toHaveBeenCalledWith(expect.objectContaining({ memberId: 'late-member' }));
    await act(async () => { renderer.unmount(); });
  });

  it('restored session waits for authentication, not just a cached user', async () => {
    mockAuthLoading = true;
    const renderer = await mount();
    expect(engine.start).not.toHaveBeenCalled();
    mockAuthLoading = false;
    await act(async () => { renderer.update(<RootLayout />); });
    await settle();
    expect(engine.start).toHaveBeenCalledTimes(1);
    await act(async () => { renderer.unmount(); });
  });

  it('reconciles a Settings grant once, without repeated starts on unchanged resumes', async () => {
    mockPermissionSnapshot.background = 'denied';
    const renderer = await mount();
    expect(engine.start).toHaveBeenCalledTimes(1);
    expect(leonidas.start).not.toHaveBeenCalled();
    mockPermissionSnapshot.background = 'granted';
    await act(async () => {
      for (const listener of [...mockAppStateListeners]) listener('background');
      for (const listener of [...mockAppStateListeners]) listener('active');
    });
    await settle();
    expect(engine.start).toHaveBeenCalledTimes(2);
    expect(leonidas.start).toHaveBeenCalledTimes(1);
    await act(async () => {
      for (const listener of [...mockAppStateListeners]) listener('background');
      for (const listener of [...mockAppStateListeners]) listener('active');
    });
    await settle();
    expect(engine.start).toHaveBeenCalledTimes(2);
    await act(async () => { renderer.unmount(); });
  });

  it('a failed engine outcome cannot start the background health monitor', async () => {
    engine.start.mockResolvedValue('failed');
    const renderer = await mount();
    expect(engine.start).toHaveBeenCalled();
    expect(leonidas.start).not.toHaveBeenCalled();
    await act(async () => { renderer.unmount(); });
  });

  it.each(['sign-out', 'session replacement'])('revokes pending engine ownership on %s', async reason => {
    let resolveStart!: (value: any) => void;
    engine.start.mockImplementationOnce(() => new Promise(resolve => { resolveStart = resolve; }));
    const renderer = await mount();
    const cfg = engine.start.mock.calls[0][0];
    expect(cfg.isCurrent()).toBe(true);
    expect(cfg.isOwnerCurrent()).toBe(true);
    engine.stop.mockClear();
    mockAuthUser = reason === 'sign-out' ? null : { id: 'replacement-user' };
    await act(async () => { renderer.update(<RootLayout />); });
    await settle();
    expect(cfg.isCurrent()).toBe(false);
    expect(cfg.isOwnerCurrent()).toBe(false);
    expect(engine.stop).toHaveBeenCalled();
    await act(async () => { resolveStart('failed'); });
    await settle();
    expect(leonidas.start).not.toHaveBeenCalled();
    await act(async () => { renderer.unmount(); });
  });

  it('bootstrap reconciliation does not revoke the cached live-session owner', async () => {
    const renderer = await mount();
    const cfg = engine.start.mock.calls[0][0];
    mockPermissionSnapshot.background = 'denied';
    await act(async () => {
      for (const listener of [...mockAppStateListeners]) listener('background');
      for (const listener of [...mockAppStateListeners]) listener('active');
    });
    await settle();
    expect(cfg.isCurrent()).toBe(false);
    expect(cfg.isOwnerCurrent()).toBe(true);
    await act(async () => { renderer.unmount(); });
  });

  it('cold medication tap retains its exact occurrence while permission UI is active', async () => {
    permissions.isPermissionsHandled.mockResolvedValue(false);
    mockSegments = ['(auth)', 'permissions'];
    mockPendingNotification = {
      type: 'medication', subtype: 'self_due', reminder_id: 'dose-001',
      member_id: 'member-001', occurrence_id: 'exact-occurrence',
      slot_time: '14:00', local_date: '2026-10-08',
    };
    const renderer = await mount();
    expect(push.setAppReadyForDeepLink).not.toHaveBeenCalledWith(true);
    expect(mockPendingNotification?.occurrence_id).toBe('exact-occurrence');
    expect(engine.start).not.toHaveBeenCalled();
    permissions.isPermissionsHandled.mockResolvedValue(true);
    mockSegments = ['(tabs)'];
    await act(async () => { renderer.update(<RootLayout />); });
    await settle();
    await act(async () => { jest.advanceTimersByTime(1); });
    await settle();
    expect(mockRouterReplace).toHaveBeenLastCalledWith(expect.objectContaining({
      pathname: '/(modals)/acknowledge',
      params: expect.objectContaining({ occurrence_id: 'exact-occurrence' }),
    }));
    await act(async () => { renderer.unmount(); });
  });
});

describe('RootLayout — authenticated medication notification startup', () => {
  const medicationOccurrence = {
    type: 'medication',
    subtype: 'self_due',
    reminder_id: 'aspirin-reminder',
    title: 'Aspirin',
    dosage: '81 mg',
    member_name: 'Joyce',
    member_id: 'joyce-member',
    slot_time: '14:00',
    local_date: '2026-09-19',
    occurrence_id: 'joyce-aspirin-2026-09-19-1400',
    notification_id: 'android-medication-request',
  };

  it('lets a queued cold-start body tap replace Family with the exact occurrence modal', async () => {
    mockSegments = ['(auth)', 'login'];
    mockPendingNotification = medicationOccurrence;
    let renderer!: ReturnType<typeof create>;

    await act(async () => {
      renderer = create(<RootLayout />);
      await flushPromises();
    });
    await act(async () => {
      jest.runOnlyPendingTimers();
      await flushPromises();
    });

    // A replace request is not a committed navigator. Wait for segments to
    // confirm the normal launch redirect before delivering the medication tap.
    expect(mockRouterReplace).toHaveBeenCalledTimes(1);
    expect(mockPendingNotification).toBe(medicationOccurrence);
    mockSegments = ['(tabs)'];
    await act(async () => {
      renderer.update(<RootLayout />);
      await flushPromises();
    });
    await act(async () => {
      jest.runOnlyPendingTimers();
      await flushPromises();
    });

    expect(mockRouterReplace).toHaveBeenNthCalledWith(1, '/(tabs)/dashboard');
    expect(mockRouterReplace).toHaveBeenNthCalledWith(2, {
      pathname: '/(modals)/acknowledge',
      params: {
        type: 'medication',
        reminder_id: 'aspirin-reminder',
        title: 'Aspirin',
        dosage: '81 mg',
        member_name: 'Joyce',
        stage: '',
        member_id: 'joyce-member',
        slot_time: '14:00',
        local_date: '2026-09-19',
        occurrence_id: 'joyce-aspirin-2026-09-19-1400',
        notification_id: 'android-medication-request',
      },
    });
    renderer.unmount();
  });

  it('retains a medication tap during session restoration instead of routing before authentication', async () => {
    mockAuthUser = null;
    mockAuthLoading = true;
    mockSegments = [];
    mockPendingNotification = medicationOccurrence;
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<RootLayout />);
      await flushPromises();
    });
    // Emulate the stale process-wide ready signal seen in the Android log.
    const { setAppReadyForDeepLink } = require('../push');
    await act(async () => {
      setAppReadyForDeepLink(true);
      jest.runOnlyPendingTimers();
      await flushPromises();
    });
    expect(mockRouterReplace).not.toHaveBeenCalled();
    expect(mockPendingNotification).toBe(medicationOccurrence);

    mockAuthUser = { id: 'caregiver-001' };
    mockAuthLoading = false;
    mockSegments = ['(auth)', 'login'];
    await act(async () => {
      renderer.update(<RootLayout />);
      await flushPromises();
    });
    await act(async () => {
      jest.runOnlyPendingTimers();
      await flushPromises();
    });
    expect(mockRouterReplace).toHaveBeenCalledWith('/(tabs)/dashboard');
    expect(mockRouterReplace.mock.calls.every(
      ([destination]) => destination === '/(tabs)/dashboard',
    )).toBe(true);
    expect(mockPendingNotification).toBe(medicationOccurrence);

    mockSegments = ['(tabs)'];
    await act(async () => {
      renderer.update(<RootLayout />);
      await flushPromises();
    });
    await act(async () => {
      jest.runOnlyPendingTimers();
      await flushPromises();
    });
    expect(mockRouterReplace).toHaveBeenLastCalledWith({
      pathname: '/(modals)/acknowledge',
      params: expect.objectContaining({
        reminder_id: medicationOccurrence.reminder_id,
        member_id: medicationOccurrence.member_id,
        slot_time: medicationOccurrence.slot_time,
        local_date: medicationOccurrence.local_date,
        occurrence_id: medicationOccurrence.occurrence_id,
      }),
    });
    expect(mockPendingNotification).toBeNull();
    await act(async () => { renderer.unmount(); });
  });

  it('keeps an ordinary authenticated launch on the normal Family route', async () => {
    mockSegments = ['(auth)', 'login'];
    let renderer!: ReturnType<typeof create>;

    await act(async () => {
      renderer = create(<RootLayout />);
      await flushPromises();
    });
    await act(async () => {
      jest.runOnlyPendingTimers();
      await flushPromises();
    });

    expect(mockRouterReplace).toHaveBeenCalledTimes(1);
    expect(mockRouterReplace).toHaveBeenCalledWith('/(tabs)/dashboard');
    renderer.unmount();
  });

  it.each([
    [{ type: 'sos', alert_id: 'sos-one' }, '/alert/[id]'],
    [{ type: 'missed_checkin', alert_id: 'checkin-one' }, '/missed-checkin/[id]'],
    [{ type: 'routine', reminder_id: 'routine-one' }, '/(modals)/acknowledge'],
    [{
      type: 'medication', subtype: 'family_alert', alert_id: 'caregiver-one',
      reminder_id: 'reminder-one',
    }, '/(modals)/acknowledge'],
    [{
      type: 'are_you_ok_request', request_id: 'welfare-one', member_id: 'member-one',
    }, '/are-you-ok-response'],
  ])('preserves the existing destination for %j', async (payload, pathname) => {
    mockApiGet.mockResolvedValue({ data: [] });
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<RootLayout />);
      await flushPromises();
    });
    await act(async () => { mockNotificationCallback!(payload); });
    expect(mockRouterReplace).toHaveBeenLastCalledWith(expect.objectContaining({ pathname }));
    await act(async () => { renderer.unmount(); });
  });
});
