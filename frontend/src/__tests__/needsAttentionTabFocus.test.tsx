/**
 * needsAttentionTabFocus.test.tsx
 * Task #86
 *
 * Regression guard: the "Needs Attention" count on the Dashboard drops to 0 on
 * the FIRST tab-focus (or first app-foreground transition) after a
 * battery_recovered push resolves the low_battery alert — NOT after the next
 * 60-second poll.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The Dashboard's `notifSub` (addNotificationReceivedListener) is only
 * registered while the Dashboard tab is focused.  If the caregiver is on the
 * Alerts tab when the `battery_recovered` push arrives, `notifSub` is NOT
 * active, so the push cannot trigger `load()`.
 *
 * The Dashboard recovers via two distinct paths — both guarded here:
 *
 *   Path A — tab-focus:
 *     `useFocusEffect` fires its callback the moment the caregiver switches
 *     back to the Dashboard tab.  The fresh `/alerts` response has no
 *     unresolved alerts → Needs Attention = 0.  This must happen on that
 *     FIRST tab-switch, not after the next 60-second poll.
 *
 *     Tests establish an unresolved alert (Needs Attention = 1), simulate blur
 *     (cleanup), update the server response to resolved, then simulate refocus
 *     (re-invoke the focus callback).  The guard verifies both that `/alerts`
 *     is refetched on that refocus AND that the count drops to 0 before any
 *     interval tick fires.
 *
 *   Path B — AppState 'active':
 *     Dashboard is focused when the caregiver backgrounds the app.  The
 *     `AppState` listener is registered inside `useFocusEffect` and stays
 *     active.  When the caregiver brings the app to foreground the listener
 *     fires `load('appstate-active')`, dropping Needs Attention to 0 on that
 *     same foreground event — not after 60 s.
 *
 * WHAT IS TESTED
 * --------------
 *  A1. Full blur→refocus lifecycle: NA 1→0 after server resolves the alert.
 *      Verifies /alerts is refetched on refocus (not only on initial mount).
 *
 *  A2. Resolved alert variant: /alerts returns alert with resolved:true on
 *      refocus; frontend filter removes it; NA drops to 0.
 *
 *  A3. Contrast — refocus with unresolved alert keeps count at 1.  Guards
 *      against a too-wide filter that clears the count prematurely.
 *
 *  A4. is_charging=true suppresses the real-time battery flag even when
 *      battery_level is still low; combined with a resolved alert → NA = 0.
 *
 *  B1. AppState 'active' fires load() and drops NA 1→0 after recovery.
 *      Verifies both /alerts is refetched AND rendered count is 0.
 *
 *  B2. Multiple rapid 'active' events do not resurface the resolved count.
 *
 *  B3. AppState 'background' does NOT trigger load() — no extra API calls.
 */

// React 19 act() support — must precede all React imports.
(global as any).IS_REACT_ACT_ENVIRONMENT = true;

// ── Focus / blur harness ──────────────────────────────────────────────────────
//
// Captures the latest useFocusEffect callback so tests can manually trigger
// a second (and subsequent) focus events — simulating the caregiver switching
// away from the Dashboard tab and then returning.
//
// On every render, Dashboard calls useFocusEffect(useCallback(cb,[members.length])).
// We update harness.latestCb each time so re-invocations use the live closure.
const focusHarness = {
  latestCb: null as null | (() => (() => void) | void),
  cleanup:  null as null | (() => void),
  /** Simulate blur: run the cleanup registered by the last focus invocation. */
  blur() {
    this.cleanup?.();
    this.cleanup = null;
  },
  /** Simulate focus: invoke the latest callback and store its cleanup. */
  focus() {
    const cl = this.latestCb?.();
    this.cleanup = cl ?? null;
  },
};

// ── AppState listener capture ─────────────────────────────────────────────────
const appStateListeners: Array<(state: string) => void> = [];

// ── react-native mock ─────────────────────────────────────────────────────────

jest.mock('react-native', () => {
  const React = require('react');

  function wrap(name: string) {
    const C = ({ children, ...props }: any) =>
      React.createElement(name, props, children);
    C.displayName = name;
    return C;
  }

  class AnimatedValue {
    _v = 0;
    constructor(v: number) { this._v = v; }
    setValue(v: number) { this._v = v; }
    interpolate() { return this; }
  }
  const AnimatedView = ({ children, ...p }: any) =>
    React.createElement('AnimatedView', p, children);
  const Animated = {
    Value: AnimatedValue,
    View: AnimatedView,
    timing: () => ({ start: (cb?: any) => { cb?.({ finished: false }); }, stop: () => {} }),
    spring: () => ({ start: () => {} }),
    createAnimatedComponent: (C: any) => C,
  };

  return {
    __esModule: true,
    View: wrap('View'),
    Text: wrap('Text'),
    ScrollView: wrap('ScrollView'),
    TouchableOpacity: wrap('TouchableOpacity'),
    Pressable: wrap('Pressable'),
    Image: wrap('Image'),
    RefreshControl: wrap('RefreshControl'),
    ActivityIndicator: wrap('ActivityIndicator'),
    StyleSheet: { create: (s: any) => s, flatten: (s: any) => s, absoluteFill: {} },
    Platform: {
      select: (obj: any) => obj.default ?? obj.ios ?? Object.values(obj)[0],
      OS: 'ios',
    },
    Alert: { alert: jest.fn() },
    AppState: {
      addEventListener: (evt: string, cb: (state: string) => void) => {
        if (evt === 'change') appStateListeners.push(cb);
        return { remove: jest.fn() };
      },
    },
    Animated,
  };
});

// ── expo-router mock ──────────────────────────────────────────────────────────
//
// The mock captures every useFocusEffect callback into focusHarness.latestCb
// and triggers an initial focus via useEffect on mount.  Tests may then call
// focusHarness.blur() + focusHarness.focus() to simulate a full tab-switch.

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useFocusEffect: (cb: () => (() => void) | void) => {
    // Always update harness with the latest callback closure.
    // Dashboard wraps its callback in useCallback([members.length]) so a
    // new reference is created when the store updates — the harness must
    // always hold the freshest one.
    focusHarness.latestCb = cb;
    const { useEffect } = require('react');
    useEffect(() => {
      // Simulate the initial focus when the Dashboard mounts.
      const cleanup = cb();
      focusHarness.cleanup = cleanup ?? null;
      return () => {
        cleanup?.();
        focusHarness.cleanup = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
  },
}));

// ── react-native-safe-area-context ────────────────────────────────────────────

jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  return {
    SafeAreaView: ({ children, ...p }: any) =>
      React.createElement('SafeAreaView', p, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

// ── expo-location ─────────────────────────────────────────────────────────────

jest.mock('expo-location', () => ({
  getForegroundPermissionsAsync:     jest.fn().mockResolvedValue({ status: 'denied' }),
  requestForegroundPermissionsAsync: jest.fn().mockResolvedValue({ status: 'denied' }),
  watchPositionAsync:  jest.fn().mockResolvedValue({ remove: jest.fn() }),
  getCurrentPositionAsync: jest.fn().mockResolvedValue({ coords: { latitude: 0, longitude: 0 } }),
  Accuracy: { High: 5 },
}));

// ── expo-notifications ────────────────────────────────────────────────────────

jest.mock('expo-notifications', () => ({
  addNotificationReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
}));

// ── expo-haptics ──────────────────────────────────────────────────────────────

jest.mock('expo-haptics', () => ({
  impactAsync:       jest.fn(),
  notificationAsync: jest.fn(),
  ImpactFeedbackStyle:    { Light: 0, Medium: 1, Heavy: 2 },
  NotificationFeedbackType: { Success: 0 },
}));

// ── react-native-svg ──────────────────────────────────────────────────────────

jest.mock('react-native-svg', () => {
  const React = require('react');
  const Svg    = ({ children, ...p }: any) => React.createElement('Svg', p, children);
  const Circle = (p: any) => React.createElement('Circle', p);
  return { __esModule: true, default: Svg, Svg, Circle };
});

// ── AsyncStorage ──────────────────────────────────────────────────────────────

const mockGetItem    = jest.fn();
const mockSetItem    = jest.fn();
const mockRemoveItem = jest.fn();

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem:    (...args: any[]) => mockGetItem(...args),
    setItem:    (...args: any[]) => mockSetItem(...args),
    removeItem: (...args: any[]) => mockRemoveItem(...args),
  },
}));

// ── Local src/ module mocks ───────────────────────────────────────────────────

jest.mock('../Icon', () => ({ Icon: () => null }));

jest.mock('../theme', () => ({
  Colors: {
    background: '#FFFFFF', surface: '#FFFFFF',
    textPrimary: '#111827', textSecondary: '#374151', textTertiary: '#6B7280',
    primary: '#0f766e', error: '#DC2626', errorBg: '#FEE2E2',
    warning: '#D97706', warningBg: '#FEF3C7', success: '#16A34A',
    border: '#E5E7EB', tertiary: '#F3F4F6',
  },
  // StatusColor is called as StatusColor(member.status) inside MemberCard.
  StatusColor: (_s: string) => '#16A34A',
}));

jest.mock('../locationRefresh',      () => ({ formatLastSeenAge: () => '2m ago' }));
jest.mock('../timeFormat',           () => ({ formatTimeAgo: () => '2m ago' }));
jest.mock('../screenRenderLog',      () => ({ logScreenRender: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../cardRenderLog',        () => ({ logCardRender:   jest.fn().mockResolvedValue(undefined) }));
jest.mock('../refreshPipelineLog',   () => ({ logPipelineEvent: jest.fn() }));
jest.mock('../activeEmergency',      () => ({ useActiveEmergency: () => null }));
jest.mock('../pinAuth',              () => ({ hasPinForUser: jest.fn().mockResolvedValue(true) }));
jest.mock('../pinSetupPrompt',       () => ({
  wasPinSetupDismissed:  jest.fn().mockResolvedValue(true),
  markPinSetupDismissed: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../locationRefreshState', () => ({
  requestRefresh:    jest.fn(),
  clearIfNewer:      jest.fn(),
  subscribeRefreshing: jest.fn(() => () => {}),
  STALE_THRESHOLD_MS: 60_000,
}));

jest.mock('../dashboardLoadLog', () => ({
  startLoad:              jest.fn().mockResolvedValue('log-id-1'),
  markGetSent:            jest.fn().mockResolvedValue(undefined),
  markGetReceived:        jest.fn().mockResolvedValue(undefined),
  markSetState:           jest.fn().mockResolvedValue(undefined),
  recordStalenessTrigger: jest.fn().mockResolvedValue(undefined),
  markError:              jest.fn().mockResolvedValue(undefined),
}));

// ── API mock ──────────────────────────────────────────────────────────────────
//
// Route getBillingStatus and listFamilyInvites through module-level jest.fn()s
// so clearAllMocks() resets their call records without wiping implementations.

const mockApiGet           = jest.fn();
const mockApiPut           = jest.fn();
const mockApiPost          = jest.fn();
const mockGetBillingStatus = jest.fn();
const mockListFamilyInvites = jest.fn();

jest.mock('../api', () => ({
  api: {
    get: (...args: any[]) => mockApiGet(...args),
    put: (...args: any[]) => mockApiPut(...args),
    post: (...args: any[]) => mockApiPost(...args),
  },
  getBillingStatus:   (...args: any[]) => mockGetBillingStatus(...args),
  listFamilyInvites:  (...args: any[]) => mockListFamilyInvites(...args),
  revokeFamilyInvite: jest.fn().mockResolvedValue({}),
}));

// ── AuthContext ───────────────────────────────────────────────────────────────

const MOCK_USER_ID   = 'caregiver-001';
const MOCK_MEMBER_ID = 'member-001';

jest.mock('../AuthContext', () => ({
  useAuth: () => ({
    user: { id: MOCK_USER_ID, full_name: 'Charles Caregiver' },
    logout: jest.fn(),
  }),
}));

// ── memberStore mock ──────────────────────────────────────────────────────────

let mockMembersArray: any[] = [];

jest.mock('../store/memberStore', () => ({
  useAllMembers:   () => mockMembersArray,
  upsertMany:      jest.fn(),
  upsertOne:       jest.fn(),
  getMyLastSeenMs: jest.fn().mockReturnValue(null),
}));

// ── Imports (after all mocks) ─────────────────────────────────────────────────

import React from 'react';
import { create, act } from 'react-test-renderer';
import Dashboard from '../../app/(tabs)/dashboard';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeLowBatteryAlert(overrides: Record<string, unknown> = {}) {
  return {
    id:           'alert-batt-001',
    member_id:    MOCK_MEMBER_ID,
    member_name:  'Test Member',
    type:         'low_battery',
    severity:     'warning',
    title:        "Test Member's battery is low",
    message:      "Test Member's phone battery is at 10%.",
    acknowledged: false,
    resolved:     false,
    created_at:   '2026-08-16T10:00:00.000Z',
    ...overrides,
  };
}

/**
 * A member whose battery_updated_at is >15 min stale so the real-time battery
 * check is suppressed independently — letting the alert-based flag be the
 * sole contributor to the Needs Attention count.
 */
function makeTestMember(overrides: Record<string, unknown> = {}) {
  return {
    id:                 MOCK_MEMBER_ID,
    user_id:            'member-user-001',
    name:               'Test Member',
    role:               'senior',
    status:             'healthy',
    battery_level:      0.10,
    is_charging:        false,
    battery_updated_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    last_seen:          new Date(Date.now() - 30 * 1000).toISOString(),
    latitude:           null,
    longitude:          null,
    location_name:      null,
    accuracy:           null,
    daily_checkin_time:      null,
    checkin_interval_hours:  null,
    ...overrides,
  };
}

function membersResponse() {
  return { status: 200, data: mockMembersArray, headers: {} };
}
function summaryResponse() {
  return {
    data: {
      members: [{
        member_id:         MOCK_MEMBER_ID,
        medication_missed: 0,
        checked_in_today:  true,
      }],
    },
  };
}

// ── Text helpers ──────────────────────────────────────────────────────────────

/**
 * Collect all visible text from a react-test-renderer tree.
 * IMPORTANT: use `!= null` (not truthiness) so that numeric children
 * equal to 0 are included — `&&children` would skip them.
 */
function collectTextContent(root: any): string {
  const texts: string[] = [];
  root.findAll(
    (node: any) => {
      if (node.type === 'Text' && node.props != null && node.props.children != null) {
        const flatten = (c: unknown): void => {
          if (typeof c === 'string')  texts.push(c);
          else if (typeof c === 'number') texts.push(String(c));
          else if (Array.isArray(c))  c.forEach(flatten);
          else if (c != null && typeof c === 'object') {
            const obj = c as Record<string, unknown>;
            if (obj.children != null) flatten(obj.children);
          }
        };
        flatten(node.props.children);
      }
      return false;
    },
    { deep: true },
  );
  return texts.join(' ');
}

/**
 * Extract the integer Needs Attention count from the joined text.
 * Expects the summary card to render: "{count} Needs Attention".
 */
function needsAttentionCount(root: any): number {
  const text = collectTextContent(root);
  const m = text.match(/(\d+)\s+Needs Attention/);
  if (!m) {
    throw new Error(
      `"Needs Attention" label not found. Rendered text: ${JSON.stringify(text.substring(0, 400))}`,
    );
  }
  return parseInt(m[1], 10);
}

// ── Async flush helpers ───────────────────────────────────────────────────────

/**
 * Drain the microtask queue across multiple act() passes.
 *
 * load() chains many sequential awaits (startLoad → markGetSent → Promise.all
 * → markGetReceived → logScreenRender loop → AsyncStorage.setItem →
 * markSetState → .finally setLoading(false)).  A single pass of N
 * Promise.resolve() calls is not sufficient; we flush in several act() rounds
 * to ensure each nested promise continuation runs before assertions.
 */
async function flushAsync(passes = 4): Promise<void> {
  for (let p = 0; p < passes; p++) {
    await act(async () => {
      for (let i = 0; i < 15; i++) await Promise.resolve();
    });
  }
}

/**
 * Mounts Dashboard, runs the initial focus (via useFocusEffect → useEffect),
 * and drains all async work so the rendered tree reflects the final state.
 */
async function mountAndSettle(): Promise<any> {
  let renderer: any;
  await act(async () => { renderer = create(<Dashboard />); });
  await flushAsync(4);
  return renderer;
}

/**
 * Simulate the caregiver leaving the Dashboard tab and returning to it.
 *
 * Steps:
 *   1. blur  — invoke the cleanup returned by the previous focus callback.
 *              This tears down pollId, appStateSub, notifSub, watcherSub.
 *   2. focus — re-invoke the latest focus callback (same as useFocusEffect
 *              firing on tab-return).  This calls load('focus') which fetches
 *              a fresh /alerts and updates state.
 *   3. flush — drain all async work so the rendered tree is up to date.
 *
 * This is the core mechanism under test: if load() is NOT called on refocus,
 * or the alert filter is broken, the count will not drop to 0.
 */
async function simulateTabFocus(): Promise<void> {
  await act(async () => { focusHarness.blur(); });
  await act(async () => { focusHarness.focus(); });
  await flushAsync(4);
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();

  // Reset harness state between tests.
  focusHarness.latestCb = null;
  focusHarness.cleanup  = null;
  appStateListeners.length = 0;

  // Member store: test member with a stale battery timestamp so the real-time
  // battery check doesn't fire independently of the alert record.
  mockMembersArray = [makeTestMember()];

  // AsyncStorage: no pre-existing cache.
  mockGetItem.mockResolvedValue(null);
  mockSetItem.mockResolvedValue(undefined);
  mockRemoveItem.mockResolvedValue(undefined);

  // API helpers not routed through mockApiGet — re-apply after clearAllMocks.
  mockGetBillingStatus.mockResolvedValue(null);
  mockListFamilyInvites.mockResolvedValue({ invites: [] });
});

afterEach(() => {
  jest.useRealTimers();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Dashboard — Needs Attention clears on non-dashboard tab when battery_recovered arrives', () => {

  // ─── Path A: tab-focus lifecycle ─────────────────────────────────────────────

  // ── A1. Core scenario: blur → server resolves → refocus → count drops ─────────
  //
  // The caregiver is on the Alerts tab when the battery_recovered push arrives.
  // notifSub is NOT registered at that point.  When they switch back to
  // Dashboard, useFocusEffect fires the callback again.  This test drives the
  // full cycle and asserts:
  //   (a) /alerts is refetched on the refocus (not delayed until 60s poll)
  //   (b) Needs Attention drops from 1 to 0 on that first refocus

  it('A1: refocus after recovery triggers /alerts and drops Needs Attention 1 → 0', async () => {
    const unresolvedAlert = makeLowBatteryAlert({ resolved: false });

    // Phase 1 — initial focus: unresolved alert active.
    mockApiGet.mockImplementation((url: string) => {
      if (url === '/members') return Promise.resolve(membersResponse());
      if (url === '/summary') return Promise.resolve(summaryResponse());
      if (url === '/alerts')  return Promise.resolve({ data: [unresolvedAlert] });
      return Promise.reject(new Error(`Unexpected GET ${url}`));
    });

    const renderer = await mountAndSettle();

    // Confirm initial state: Needs Attention = 1.
    expect(needsAttentionCount(renderer.root)).toBe(1);

    const alertCallsBefore = mockApiGet.mock.calls.filter(
      (c: any[]) => c[0] === '/alerts',
    ).length;

    // Phase 2 — the test member plugs in.  Server resolves the alert.
    // Caregiver is on Alerts tab (push arrived, notifSub inactive).
    // Now they switch back to Dashboard → useFocusEffect re-fires.
    mockApiGet.mockImplementation((url: string) => {
      if (url === '/members') return Promise.resolve(membersResponse());
      if (url === '/summary') return Promise.resolve(summaryResponse());
      if (url === '/alerts')  return Promise.resolve({ data: [] }); // server cleared it
      return Promise.reject(new Error(`Unexpected GET ${url}`));
    });

    await simulateTabFocus();

    // Guard (a): /alerts was refetched on refocus — not waiting for 60-second poll.
    const alertCallsAfter = mockApiGet.mock.calls.filter(
      (c: any[]) => c[0] === '/alerts',
    ).length;
    expect(alertCallsAfter).toBeGreaterThan(alertCallsBefore);

    // Guard (b): Needs Attention is now 0 — cleared by the refocus load.
    expect(needsAttentionCount(renderer.root)).toBe(0);
  });

  // ── A2. Server returns the alert with resolved:true on refocus ────────────────
  //
  // Same lifecycle but /alerts returns the alert document with resolved:true
  // rather than an empty list (depends on server-side filtering behavior).
  // The frontend filter `!a.resolved` must remove it; NA drops to 0.

  it('A2: refocus clears NA to 0 when /alerts returns the alert with resolved:true', async () => {
    const unresolvedAlert = makeLowBatteryAlert({ resolved: false });

    mockApiGet.mockImplementation((url: string) => {
      if (url === '/members') return Promise.resolve(membersResponse());
      if (url === '/summary') return Promise.resolve(summaryResponse());
      if (url === '/alerts')  return Promise.resolve({ data: [unresolvedAlert] });
      return Promise.reject(new Error(`Unexpected GET ${url}`));
    });

    const renderer = await mountAndSettle();
    expect(needsAttentionCount(renderer.root)).toBe(1);

    const alertCallsBefore = mockApiGet.mock.calls.filter(
      (c: any[]) => c[0] === '/alerts',
    ).length;

    // Recovery: server now returns the alert with resolved:true.
    mockApiGet.mockImplementation((url: string) => {
      if (url === '/members') return Promise.resolve(membersResponse());
      if (url === '/summary') return Promise.resolve(summaryResponse());
      if (url === '/alerts')  return Promise.resolve({ data: [makeLowBatteryAlert({ resolved: true })] });
      return Promise.reject(new Error(`Unexpected GET ${url}`));
    });

    await simulateTabFocus();

    // /alerts was called again on refocus.
    expect(
      mockApiGet.mock.calls.filter((c: any[]) => c[0] === '/alerts').length,
    ).toBeGreaterThan(alertCallsBefore);

    // Frontend filter removes the resolved alert → NA = 0.
    expect(needsAttentionCount(renderer.root)).toBe(0);
  });

  // ── A3. Contrast: refocus with still-unresolved alert keeps count at 1 ────────
  //
  // Guards against a too-wide filter.  If the server hasn't resolved the alert
  // yet, refocusing should NOT clear Needs Attention.

  it('A3 (contrast): refocus keeps NA at 1 when alert is still unresolved', async () => {
    const unresolvedAlert = makeLowBatteryAlert({ resolved: false });

    // Both the initial load and the refocus return the same unresolved alert.
    mockApiGet.mockImplementation((url: string) => {
      if (url === '/members') return Promise.resolve(membersResponse());
      if (url === '/summary') return Promise.resolve(summaryResponse());
      if (url === '/alerts')  return Promise.resolve({ data: [unresolvedAlert] });
      return Promise.reject(new Error(`Unexpected GET ${url}`));
    });

    const renderer = await mountAndSettle();
    expect(needsAttentionCount(renderer.root)).toBe(1);

    await simulateTabFocus();

    // Alert still unresolved → count must remain 1.
    expect(needsAttentionCount(renderer.root)).toBe(1);
  });

  // ── A4. is_charging suppresses the real-time battery flag ─────────────────────
  //
  // The test member plugs in: is_charging=true.  Even if battery_level is still 10%
  // and battery_updated_at is recent (< 15 min), the real-time check uses
  // `&& !_m.is_charging` — so it is suppressed.  Combined with a resolved
  // alert on refocus, NA must drop to 0.

  it('A4: NA drops to 0 on refocus when the test member is charging and the alert is resolved', async () => {
    // Member has a RECENT battery update but is_charging = true.
    mockMembersArray = [makeTestMember({
      battery_level:      0.10,
      is_charging:        true,
      battery_updated_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    })];

    const unresolvedAlert = makeLowBatteryAlert({ resolved: false });

    mockApiGet.mockImplementation((url: string) => {
      if (url === '/members') return Promise.resolve({ status: 200, data: mockMembersArray, headers: {} });
      if (url === '/summary') return Promise.resolve(summaryResponse());
      if (url === '/alerts')  return Promise.resolve({ data: [unresolvedAlert] });
      return Promise.reject(new Error(`Unexpected GET ${url}`));
    });

    const renderer = await mountAndSettle();
    expect(needsAttentionCount(renderer.root)).toBe(1);

    // After recovery: alert resolved, is_charging already true.
    mockApiGet.mockImplementation((url: string) => {
      if (url === '/members') return Promise.resolve({ status: 200, data: mockMembersArray, headers: {} });
      if (url === '/summary') return Promise.resolve(summaryResponse());
      if (url === '/alerts')  return Promise.resolve({ data: [makeLowBatteryAlert({ resolved: true })] });
      return Promise.reject(new Error(`Unexpected GET ${url}`));
    });

    await simulateTabFocus();
    expect(needsAttentionCount(renderer.root)).toBe(0);
  });

  // ─── Path B: AppState 'active' ────────────────────────────────────────────────

  // ── B1. AppState 'active' fires load() and clears NA after recovery ───────────
  //
  // Dashboard is focused when the caregiver backgrounds the app.  The AppState
  // listener registered inside useFocusEffect stays active.  When the caregiver
  // brings the app to foreground, the listener fires load('appstate-active').
  // Needs Attention must drop to 0 on that foreground event, not after 60 s.

  it('B1: AppState active fires load() and drops NA 1 → 0 after recovery', async () => {
    const unresolvedAlert = makeLowBatteryAlert({ resolved: false });

    // Phase 1: initial focus — unresolved alert.
    mockApiGet.mockImplementation((url: string) => {
      if (url === '/members') return Promise.resolve(membersResponse());
      if (url === '/summary') return Promise.resolve(summaryResponse());
      if (url === '/alerts')  return Promise.resolve({ data: [unresolvedAlert] });
      return Promise.reject(new Error(`Unexpected GET ${url}`));
    });

    const renderer = await mountAndSettle();
    expect(needsAttentionCount(renderer.root)).toBe(1);

    // AppState listener must have been registered during the focus.
    expect(appStateListeners.length).toBeGreaterThan(0);

    const alertCallsBefore = mockApiGet.mock.calls.filter(
      (c: any[]) => c[0] === '/alerts',
    ).length;

    // Phase 2: the test member plugs in while the app is backgrounded.  Switch /alerts.
    mockApiGet.mockImplementation((url: string) => {
      if (url === '/members') return Promise.resolve(membersResponse());
      if (url === '/summary') return Promise.resolve(summaryResponse());
      if (url === '/alerts')  return Promise.resolve({ data: [] }); // cleared
      return Promise.reject(new Error(`Unexpected GET ${url}`));
    });

    // Caregiver opens the app → OS fires AppState 'active'.
    await act(async () => {
      appStateListeners[0]('active');
    });
    await flushAsync(4);

    // Guard: /alerts was refetched by the AppState handler.
    expect(
      mockApiGet.mock.calls.filter((c: any[]) => c[0] === '/alerts').length,
    ).toBeGreaterThan(alertCallsBefore);

    // Needs Attention dropped to 0 without waiting for the 60-second poll.
    expect(needsAttentionCount(renderer.root)).toBe(0);
  });

  // ── B2. Multiple rapid 'active' events do not resurface the resolved count ─────

  it('B2: multiple AppState active events leave NA at 0', async () => {
    const unresolvedAlert = makeLowBatteryAlert({ resolved: false });

    mockApiGet.mockImplementation((url: string) => {
      if (url === '/members') return Promise.resolve(membersResponse());
      if (url === '/summary') return Promise.resolve(summaryResponse());
      if (url === '/alerts')  return Promise.resolve({ data: [unresolvedAlert] });
      return Promise.reject(new Error(`Unexpected GET ${url}`));
    });

    const renderer = await mountAndSettle();
    expect(needsAttentionCount(renderer.root)).toBe(1);
    expect(appStateListeners.length).toBeGreaterThan(0);

    // Recovery: /alerts now empty.
    mockApiGet.mockImplementation((url: string) => {
      if (url === '/members') return Promise.resolve(membersResponse());
      if (url === '/summary') return Promise.resolve(summaryResponse());
      if (url === '/alerts')  return Promise.resolve({ data: [] });
      return Promise.reject(new Error(`Unexpected GET ${url}`));
    });

    // Two rapid 'active' events — common when the OS fires duplicates.
    await act(async () => {
      appStateListeners[0]('active');
      appStateListeners[0]('active');
    });
    await flushAsync(4);

    expect(needsAttentionCount(renderer.root)).toBe(0);
  });

  // ── B3. AppState 'background' does NOT trigger load() ─────────────────────────
  //
  // Only 'active' should call load().  A 'background' event must not cause
  // extra API calls — the dashboard does no work when the user puts the app
  // to sleep.

  it('B3: AppState background does NOT add any /alerts API call', async () => {
    mockApiGet.mockImplementation((url: string) => {
      if (url === '/members') return Promise.resolve(membersResponse());
      if (url === '/summary') return Promise.resolve(summaryResponse());
      if (url === '/alerts')  return Promise.resolve({ data: [] });
      return Promise.reject(new Error(`Unexpected GET ${url}`));
    });

    await mountAndSettle();
    expect(appStateListeners.length).toBeGreaterThan(0);

    const callCountAfterMount = mockApiGet.mock.calls.length;

    await act(async () => { appStateListeners[0]('background'); });
    await flushAsync(2);

    // Background must not add any calls.
    expect(mockApiGet.mock.calls.length).toBe(callCountAfterMount);
  });
});

describe('Dashboard — interactive welfare check', () => {
  it("sends an Are you OK request and shows the member's reply on the next 10-second poll", async () => {
    let responded = false;
    mockApiPost.mockResolvedValue({
      data: {
        request_id: 'welfare-request-1',
        status: 'pending',
        created_at: '2026-08-28T12:00:00.000Z',
      },
    });
    mockApiGet.mockImplementation((url: string) => {
      if (url === '/members') return Promise.resolve(membersResponse());
      if (url === '/summary') return Promise.resolve(summaryResponse());
      if (url === '/alerts') return Promise.resolve({ data: [] });
      if (url === `/checkin-requests/member/${MOCK_MEMBER_ID}`) {
        return Promise.resolve({
          data: responded ? [{
            id: 'welfare-request-1',
            status: 'responded',
            responded_at: new Date().toISOString(),
          }] : [],
        });
      }
      return Promise.reject(new Error(`Unexpected GET ${url}`));
    });

    const renderer = await mountAndSettle();
    const button = renderer.root.findByProps({
      testID: `member-welfare-check-${MOCK_MEMBER_ID}`,
    });
    await act(async () => { await button.props.onPress(); });

    expect(mockApiPost).toHaveBeenCalledWith(
      `/members/${MOCK_MEMBER_ID}/welfare-check`,
    );
    expect(renderer.root.findByProps({
      testID: `member-welfare-pending-${MOCK_MEMBER_ID}`,
    })).toBeTruthy();

    responded = true;
    await act(async () => { jest.advanceTimersByTime(10_000); });
    await flushAsync(4);

    const confirmation = renderer.root.findByProps({
      testID: `member-welfare-confirmed-${MOCK_MEMBER_ID}`,
    });
    expect(collectTextContent(confirmation).replace(/\s+/g, ' ')).toContain(
      'Test Member confirmed OK',
    );
  });

  it('stops the 10-second welfare polling immediately when the dashboard loses focus', async () => {
    mockApiGet.mockImplementation((url: string) => {
      if (url === '/members') return Promise.resolve(membersResponse());
      if (url === '/summary') return Promise.resolve(summaryResponse());
      if (url === '/alerts') return Promise.resolve({ data: [] });
      if (url === `/checkin-requests/member/${MOCK_MEMBER_ID}`) {
        return Promise.resolve({ data: [] });
      }
      return Promise.reject(new Error(`Unexpected GET ${url}`));
    });

    await mountAndSettle();
    const beforeBlur = mockApiGet.mock.calls.filter(
      (call: any[]) => call[0] === `/checkin-requests/member/${MOCK_MEMBER_ID}`,
    ).length;

    await act(async () => { focusHarness.blur(); });
    await act(async () => { jest.advanceTimersByTime(30_000); });
    await flushAsync(2);

    const afterBlur = mockApiGet.mock.calls.filter(
      (call: any[]) => call[0] === `/checkin-requests/member/${MOCK_MEMBER_ID}`,
    ).length;
    expect(afterBlur).toBe(beforeBlur);
  });
});
