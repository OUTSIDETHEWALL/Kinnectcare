import React from 'react';
import { act, create } from 'react-test-renderer';
import fs from 'fs';
import path from 'path';

const mockGet = jest.fn();
const mockStorage = jest.fn().mockResolvedValue(undefined);
const mockMilestone = jest.fn();
let mockAuth: any;
let mockMembers: any[] = [];
const mockSubscribers = new Set<() => void>();
let mockFocus: (() => void) | undefined;

jest.mock('react-native', () => {
  class Value { setValue() {} interpolate() { return 0; } }
  const animation = () => ({ start() {}, stop() {} });
  return {
    View: 'View', Text: 'Text', ScrollView: 'ScrollView', TouchableOpacity: 'TouchableOpacity',
    Image: 'Image', ImageBackground: 'ImageBackground', Pressable: 'Pressable',
    RefreshControl: 'RefreshControl', ActivityIndicator: 'ActivityIndicator', Modal: 'Modal',
    StyleSheet: { create: (x: any) => x, absoluteFill: {} },
    Platform: { OS: 'android', select: (x: any) => x.android ?? x.default },
    AppState: { addEventListener: () => ({ remove() {} }) }, Alert: { alert: jest.fn() },
    Animated: {
      Value, View: 'AnimatedView', timing: animation, sequence: animation, loop: animation, spring: animation,
      createAnimatedComponent: (Component: any) => Component,
    },
  };
});
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({ bottom: 0 }),
}));
jest.mock('react-native-svg', () => ({ __esModule: true, default: 'Svg', Circle: 'Circle' }));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useFocusEffect: (callback: () => (() => void)) => {
    mockFocus = callback;
    // Drive an initial focus, then explicitly refocus in race tests.
    require('react').useEffect(() => callback(), []);
  },
}));
jest.mock('expo-location', () => ({}));
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(), notificationAsync: jest.fn(),
  ImpactFeedbackStyle: { Medium: 'medium' }, NotificationFeedbackType: { Success: 'success' },
}));
jest.mock('expo-notifications', () => ({ addNotificationReceivedListener: () => ({ remove() {} }) }));
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null), setItem: (...a: any[]) => mockStorage(...a),
}));
jest.mock('../AuthContext', () => ({ useAuth: () => mockAuth }));
jest.mock('../api', () => ({
  api: { get: (...a: any[]) => mockGet(...a) },
  getBillingStatus: async () => ({}), listFamilyInvites: async () => ({ invites: [] }),
}));
jest.mock('../Icon', () => ({ Icon: () => null }));
jest.mock('../store/memberStore', () => ({
  useAllMembers: () => require('react').useSyncExternalStore(
    (fn: () => void) => { mockSubscribers.add(fn); return () => mockSubscribers.delete(fn); },
    () => mockMembers,
  ),
  upsertMany: (rows: any[]) => { mockMembers = rows; mockSubscribers.forEach(fn => fn()); },
  upsertOne: jest.fn(), getMyLastSeenMs: () => null,
}));
jest.mock('../permissionCoordinator', () => ({
  foregroundLocationForAutomaticCaller: async () => ({ status: 'denied' }),
}));
jest.mock('../foregroundLocationPublication', () => ({ refreshForegroundLocation: async () => {} }));
jest.mock('../locationUploadSuccess', () => ({ recordLocationUploadSuccess: jest.fn() }));
jest.mock('../locationRefreshState', () => ({
  requestRefresh: jest.fn(), clearIfNewer: jest.fn(), subscribeRefreshing: () => () => {},
  STALE_THRESHOLD_MS: 60_000,
}));
jest.mock('../activeEmergency', () => ({ useActiveEmergency: () => null }));
jest.mock('../refreshPipelineLog', () => ({ logPipelineEvent: jest.fn() }));
jest.mock('../screenRenderLog', () => ({ logScreenRender: async () => {} }));
jest.mock('../cardRenderLog', () => ({ logCardRender: jest.fn() }));
jest.mock('../dashboardLoadTrace', () => ({
  createDashboardLoadTrace: () => ({
    sent() {}, received() {}, committed() {}, failed() {}, stale() {},
  }),
}));
jest.mock('../startupDiagnostics', () => ({ markStartupMilestone: (...a: any[]) => mockMilestone(...a) }));
jest.mock('../nativeStartupRecorder', () => ({ recordNativeStartupCheckpoint: jest.fn() }));
jest.mock('../../assets/images/kinnship-logo-dark.png', () => 1);

import Welcome from '../../app/index';
import Dashboard from '../../app/(tabs)/dashboard';

function deferred() {
  let resolve!: (v: any) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const member = { id: 'member', user_id: 'owner', name: 'Test member', role: 'family', status: 'healthy' };
const summary = { members: [], missed_medication_details: [] };
const flush = async () => { for (let n = 0; n < 40; n++) await Promise.resolve(); };
const text = (node: any): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join(' ');
  return node?.children ? text(node.children) : '';
};

describe('post-OTA returning-session rendering', () => {
  let tree: ReturnType<typeof create>;
  let safety: ReturnType<typeof deferred>;
  let alerts: ReturnType<typeof deferred>;
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockAuth = { user: { id: 'owner', full_name: 'Test owner' }, loading: false, logout: jest.fn() };
    mockMembers = [];
    mockSubscribers.clear();
    require('@react-native-async-storage/async-storage').getItem.mockReset().mockResolvedValue(null);
    safety = deferred(); alerts = deferred();
    mockGet.mockReset().mockImplementation((path: string) => {
      if (path === '/members') return Promise.resolve({ data: [member], headers: {} });
      if (path === '/summary') return safety.promise;
      if (path === '/alerts') return alerts.promise;
      return Promise.resolve({ data: [] });
    });
  });
  afterEach(async () => {
    if (tree) await act(async () => tree.unmount());
    jest.clearAllTimers(); jest.useRealTimers();
  });
  async function mount(Component = Dashboard) {
    await act(async () => { tree = create(<Component />); await flush(); });
  }
  const count = () => text(tree.root.findByProps({ testID: 'dashboard-needs-attention' }));

  it('records JS entry before headless registration and Router dependency evaluation', () => {
    const entry = fs.readFileSync(path.resolve(__dirname, '../../index.js'), 'utf8');
    const milestones = [
      "import '@expo/metro-runtime'", "import './src/startupEntryCheckpoint'",
      "import './src/locationEngine'", "import './src/batteryTask'",
      "import './src/push'", "import 'expo-router/entry'",
    ].map(statement => entry.indexOf(statement));
    expect(milestones.every(offset => offset >= 0)).toBe(true);
    expect(milestones).toEqual([...milestones].sort((a, b) => a - b));
    require('../startupEntryCheckpoint');
    expect(require('../nativeStartupRecorder').recordNativeStartupCheckpoint)
      .toHaveBeenCalledWith('js_entry_started');
  });

  it.each([true, false])('does not paint signup during unresolved/resolved returning auth (loading=%s)', async loading => {
    mockAuth.loading = loading;
    await mount(Welcome);
    expect(tree.root.findAllByProps({ testID: 'welcome-login-link' })).toHaveLength(0);
    expect(tree.root.findAllByProps({ testID: 'welcome-session-pending' })).toHaveLength(1);
    expect(require('../nativeStartupRecorder').recordNativeStartupCheckpoint)
      .not.toHaveBeenCalledWith('welcome_render_committed');
  });
  it('shows Welcome only after genuinely signed-out auth settles; it grants no cached access', async () => {
    mockAuth = { user: null, loading: true };
    await mount(Welcome);
    expect(tree.root.findAllByProps({ testID: 'welcome-create-family-btn' })).toHaveLength(0);
    mockAuth.loading = false;
    await act(async () => { tree.update(<Welcome />); await flush(); });
    expect(tree.root.findAllByProps({ testID: 'welcome-create-family-btn' })).toHaveLength(1);
  });
  it('renders Family with both safety requests never settling, without a false zero or all-clear', async () => {
    await mount();
    expect(tree.root.findAllByProps({ testID: 'member-card-member' })).toHaveLength(1);
    expect(count()).toContain('—');
    expect(tree.root.findAllByProps({ testID: 'dashboard-safety-pending' })).toHaveLength(1);
    expect(mockMilestone).toHaveBeenCalledWith('first_usable_family_render', { memberCount: 1 });
  });
  it('keeps unresolved alerts visible on summary failure, then preserves them when the next alerts fetch fails', async () => {
    await mount();
    await act(async () => {
      safety.reject(new Error('summary unavailable'));
      alerts.resolve({ data: [{ id: 'alert', member_id: 'member', type: 'low_battery', battery_stage: 'critical', resolved: false }] });
      await flush();
    });
    expect(count()).toContain('1+');
    const failedAlerts = deferred();
    mockGet.mockImplementation(path => path === '/summary'
      ? Promise.resolve({ data: summary }) : path === '/alerts' ? failedAlerts.promise
        : Promise.resolve({ data: [member], headers: {} }));
    await act(async () => { mockFocus?.(); await flush(); });
    await act(async () => { failedAlerts.reject(new Error('alerts unavailable')); await flush(); });
    expect(count()).toContain('1+');
    expect(mockStorage).not.toHaveBeenCalledWith('@kinnship/active_alerts_v1_owner', '[]');
  });
  it('clears unknown status only when summary and alerts are valid, independently of members', async () => {
    await mount();
    await act(async () => { safety.resolve({ data: summary }); await flush(); });
    expect(count()).toContain('—');
    await act(async () => { alerts.resolve({ data: [] }); await flush(); });
    expect(tree.root.findAllByProps({ testID: 'dashboard-safety-pending' })).toHaveLength(0);
    expect(count()).toContain('0');
  });
  it('does not accept an older refresh after a newer one finishes', async () => {
    await mount();
    mockGet.mockImplementation(path => path === '/summary'
      ? Promise.resolve({ data: summary }) : path === '/alerts' ? Promise.resolve({ data: [] })
        : Promise.resolve({ data: [member], headers: {} }));
    await act(async () => { mockFocus?.(); await flush(); });
    await act(async () => {
      safety.resolve({ data: { ...summary, missed_medication_details: [{ id: 'old-dose' }] } });
      alerts.resolve({ data: [{ id: 'stale', type: 'low_battery', battery_stage: 'critical', member_id: 'member' }] });
      await flush();
    });
    expect(count()).toContain('0');
    expect(mockStorage.mock.calls.filter(args => args[0] === '@kinnship/active_alerts_v1_owner')).toHaveLength(1);
  });
  it('an obsolete account focus cannot invalidate the replacement account request', async () => {
    await mount();
    const oldFocus = mockFocus;
    const replacementSummary = deferred();
    const replacementAlerts = deferred();
    mockGet.mockImplementation(path => path === '/summary' ? replacementSummary.promise
      : path === '/alerts' ? replacementAlerts.promise : Promise.resolve({ data: [member], headers: {} }));
    mockAuth = { user: { id: 'replacement' }, loading: false };
    await act(async () => { tree.update(<Dashboard />); await flush(); });
    await act(async () => { mockFocus?.(); await flush(); oldFocus?.(); await flush(); });
    await act(async () => {
      replacementSummary.resolve({ data: summary }); replacementAlerts.resolve({ data: [] }); await flush();
    });
    expect(mockStorage).toHaveBeenCalledWith('@kinnship/active_alerts_v1_replacement', '[]');
    expect(tree.root.findAllByProps({ testID: 'dashboard-safety-pending' })).toHaveLength(0);
  });
  it('does not revive cached incidents after a fresh successful alerts response', async () => {
    const cache = deferred();
    require('@react-native-async-storage/async-storage').getItem.mockImplementation(
      (key: string) => key === '@kinnship/active_alerts_v1_owner' ? cache.promise : Promise.resolve(null),
    );
    await mount();
    await act(async () => {
      safety.resolve({ data: summary }); alerts.resolve({ data: [] }); await flush();
    });
    await act(async () => {
      cache.resolve(JSON.stringify([{ id: 'cached', type: 'low_battery', battery_stage: 'critical', member_id: 'member' }]));
      await flush();
    });
    expect(count()).toContain('0');
    expect(count()).not.toContain('1');
  });
  it('a malformed safety response is unavailable, not a verified empty result', async () => {
    await mount();
    await act(async () => {
      safety.resolve({ data: { members: [] } }); alerts.resolve({ data: {} }); await flush();
    });
    expect(count()).toContain('—');
    expect(text(tree.root.findByProps({ testID: 'dashboard-safety-pending' }))).toContain('unavailable');
  });
  it('members failure remains a load error, not a usable/authorized Family milestone', async () => {
    mockGet.mockImplementation(path => path === '/members' ? Promise.reject(new Error('members failed'))
      : path === '/summary' ? safety.promise : alerts.promise);
    await mount();
    expect(tree.root.findAllByProps({ testID: 'dashboard-load-error' })).toHaveLength(1);
    expect(mockMilestone).not.toHaveBeenCalledWith('first_usable_family_render', expect.anything());
  });
  it('a successful empty family is usable, not an endless spinner', async () => {
    mockGet.mockImplementation(path => path === '/members' ? Promise.resolve({ data: [], headers: {} })
      : path === '/summary' ? safety.promise : alerts.promise);
    await mount();
    expect(mockMilestone).toHaveBeenCalledWith('first_usable_family_render', { memberCount: 0 });
  });
  it.each(['signout', 'replacement', 'unmount'])('discards late safety results after %s', async boundary => {
    await mount();
    mockAuth = { user: boundary === 'signout' ? null : { id: 'replacement' }, loading: false };
    await act(async () => {
      if (boundary === 'unmount') tree.unmount();
      else tree.update(<Dashboard />);
      await flush();
    });
    await act(async () => {
      safety.resolve({ data: summary }); alerts.resolve({ data: [] }); await flush();
    });
    expect(mockStorage).not.toHaveBeenCalledWith('@kinnship/active_alerts_v1_owner', '[]');
  });
});
