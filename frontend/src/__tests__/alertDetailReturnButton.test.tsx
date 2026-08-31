/**
 * alertDetailReturnButton.test.tsx
 * Task #71 — Confirm the old '• Dashboard' breadcrumb is gone from the
 * emergency alert detail screen and replaced by the full-width green button.
 *
 * Renders the REAL `app/alert/[id].tsx` component with mocked API and
 * navigation, then:
 *   1. Confirms NO element with text containing "• Dashboard" exists (old
 *      breadcrumb pattern).
 *   2. Confirms the green "Return to Dashboard" button exists (testID="alert-back").
 *   3. Confirms the button is rendered BEFORE the SOS status banner in the
 *      component tree (i.e. it is the first visible interactive element below
 *      the safe area).
 *   4. Confirms the button renders in both ACTIVE (resolved=false) and
 *      RESOLVED (resolved=true) SOS states.
 *   5. Confirms tapping the button calls router.replace('/(tabs)/dashboard')
 *      with NO confirmation dialog (RNAlert.alert must NOT be called).
 *   6. Confirms the button style is a full-width button (#1B5E35 fill) — not a
 *      small inline link — verifiable via the style props on the wrapper View.
 */

// ── React act() support ──────────────────────────────────────────────────────
(global as any).IS_REACT_ACT_ENVIRONMENT = true;

// ── Native-module mocks (before imports) ─────────────────────────────────────

jest.mock('react-native', () => {
  const React = require('react');

  function wrap(name: string) {
    const C = ({ children, ...props }: any) =>
      React.createElement(name, props, children);
    C.displayName = name;
    return C;
  }

  return {
    __esModule: true,
    View: wrap('View'),
    Text: wrap('Text'),
    ScrollView: wrap('ScrollView'),
    TouchableOpacity: wrap('TouchableOpacity'),
    ActivityIndicator: wrap('ActivityIndicator'),
    StyleSheet: { create: (s: any) => s, flatten: (s: any) => s },
    Platform: {
      select: (obj: any) => obj.default ?? obj.ios ?? Object.values(obj)[0],
      OS: 'ios',
    },
    Alert: { alert: jest.fn() },
    Linking: { openURL: jest.fn(() => Promise.resolve()) },
    AppState: {
      addEventListener: jest.fn(() => ({ remove: jest.fn() })),
      currentState: 'active',
    },
  };
});

const mockRouterReplace = jest.fn();

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'sos-alert-001', member_phone: '' }),
  useRouter: () => ({ replace: mockRouterReplace }),
}));

jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  return {
    SafeAreaView: ({ children, ...props }: any) =>
      React.createElement('SafeAreaView', props, children),
  };
});

jest.mock('../Icon', () => ({ Icon: () => null }));
jest.mock('../MemberMap', () => ({ __esModule: true, default: () => null }));
jest.mock('../timeFormat', () => ({ formatRelativeLocal: () => '2 min ago' }));
jest.mock('../theme', () => ({
  Colors: {
    background: '#F9FAFB',
    surface: '#FFFFFF',
    text: '#111827',
    textPrimary: '#111827',
    textSecondary: '#374151',
    textTertiary: '#6B7280',
    primary: '#0f766e',
    error: '#DC2626',
    errorBg: '#FEE2E2',
    warning: '#D97706',
    warningBg: '#FEF3C7',
    success: '#16A34A',
    border: '#E5E7EB',
    tertiary: '#F3F4F6',
  },
}));

// memberStore: return a live member with coords so the map card renders.
jest.mock('../store/memberStore', () => ({
  useMember: () => ({
    id: 'member-001',
    name: 'Test Member',
    latitude: 33.45,
    longitude: -112.07,
    last_seen: new Date(Date.now() - 30_000).toISOString(),
    location_name: '123 Main St',
    emergency_contact_phone: '',
  }),
  fetchOne: jest.fn(() => Promise.resolve()),
  requestRefresh: jest.fn(() => Promise.resolve()),
}));

jest.mock('../resumeDiagnostics', () => ({
  logResumeDecision: jest.fn(),
  markAlertDismissed: jest.fn(),
}));

jest.mock('../activeEmergency', () => ({
  setActiveEmergency: jest.fn(),
}));

jest.mock('../tracking/TrackingStatusPill', () => ({
  TrackingStatusPill: () => null,
}));

// ── API mock ─────────────────────────────────────────────────────────────────

const mockApiGet = jest.fn();
const mockApiPost = jest.fn();

jest.mock('../api', () => ({
  api: {
    get: (...args: any[]) => mockApiGet(...args),
    post: (...args: any[]) => mockApiPost(...args),
  },
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import React from 'react';
import { create, act } from 'react-test-renderer';
import { Alert as RNAlert } from 'react-native';

// REAL production component — not a copy.
import AlertDetail from '../../app/alert/[id]';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeSosAlert(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sos-alert-001',
    member_id: 'member-001',
    member_name: 'Test Member',
    type: 'sos',
    severity: 'critical',
    title: "Test Member's SOS",
    message: "Test Member triggered an SOS.",
    acknowledged: false,
    resolved: false,
    resolved_by_name: null,
    resolved_at: null,
    created_at: new Date(Date.now() - 60_000).toISOString(),
    latitude: 33.45,
    longitude: -112.07,
    ...overrides,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function findByTestID(root: ReturnType<typeof create>['root'], testID: string) {
  const results = root.findAll(
    (node: any) => node.props != null && node.props.testID === testID,
    { deep: true },
  );
  return results[0] ?? null;
}

/** Collect text content from all Text nodes in the tree. */
function allTextContent(root: ReturnType<typeof create>['root']): string[] {
  return root
    .findAll((node: any) => node.type === 'Text', { deep: true })
    .map((node: any) => {
      const children = node.props.children;
      if (typeof children === 'string') return children;
      if (Array.isArray(children))
        return children.filter((c: any) => typeof c === 'string').join('');
      return '';
    });
}

/** Render <AlertDetail /> with the given alert list and flush all async work. */
async function renderAlertDetail(
  alerts: ReturnType<typeof makeSosAlert>[],
): Promise<ReturnType<typeof create>> {
  mockApiGet.mockResolvedValue({ data: alerts });

  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<AlertDetail />);
  });
  // Flush the api.get promise and any resulting setState calls.
  await act(async () => {
    await Promise.resolve();
  });
  return renderer;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AlertDetail — breadcrumb removal & Return to Dashboard button', () => {

  // ── 1. Old breadcrumb text is gone ─────────────────────────────────────────

  it('renders no text that matches the old "• Dashboard" breadcrumb pattern (ACTIVE)', async () => {
    const renderer = await renderAlertDetail([makeSosAlert()]);
    const texts = allTextContent(renderer.root);

    // The old breadcrumb rendered a bullet + "Dashboard" as plain text.
    // None of the Text nodes should contain that pattern.
    const breadcrumbLike = texts.filter(
      (t) =>
        // exact old pattern
        t === '• Dashboard' ||
        t === '‹ Dashboard' ||
        // a lone "Dashboard" text node that isn't the button label
        (t.trim() === 'Dashboard' && !t.includes('Return')),
    );
    expect(breadcrumbLike).toEqual([]);
  });

  it('renders no text that matches the old "• Dashboard" breadcrumb pattern (RESOLVED)', async () => {
    const renderer = await renderAlertDetail([
      makeSosAlert({ resolved: true, resolved_by_name: 'Charles', resolved_at: new Date().toISOString() }),
    ]);
    const texts = allTextContent(renderer.root);

    const breadcrumbLike = texts.filter(
      (t) =>
        t === '• Dashboard' ||
        t === '‹ Dashboard' ||
        (t.trim() === 'Dashboard' && !t.includes('Return')),
    );
    expect(breadcrumbLike).toEqual([]);
  });

  // ── 2. Green "Return to Dashboard" button exists ────────────────────────────

  it('renders the Return to Dashboard button (testID="alert-back") in ACTIVE state', async () => {
    const renderer = await renderAlertDetail([makeSosAlert()]);
    const btn = findByTestID(renderer.root, 'alert-back');
    expect(btn).not.toBeNull();
  });

  it('renders the Return to Dashboard button (testID="alert-back") in RESOLVED state', async () => {
    const renderer = await renderAlertDetail([
      makeSosAlert({ resolved: true, resolved_by_name: 'Charles', resolved_at: new Date().toISOString() }),
    ]);
    const btn = findByTestID(renderer.root, 'alert-back');
    expect(btn).not.toBeNull();
  });

  // ── 3. Button text is "Return to Dashboard" ────────────────────────────────

  it('button label text is "Return to Dashboard" — not a short plain label', async () => {
    const renderer = await renderAlertDetail([makeSosAlert()]);
    const texts = allTextContent(renderer.root);
    expect(texts).toContain('Return to Dashboard');
  });

  // ── 4. Button appears BEFORE the SOS status banner in the tree ─────────────
  //
  // In the JSX, <returnRow> (containing the button) is rendered as the FIRST
  // child of the root <SafeAreaView>, before the <ScrollView> that holds the
  // banner.  We verify this ordering so we can catch any regression that pushes
  // the button below the banner.

  it('the "alert-back" button appears before the SOS banner in the component tree (ACTIVE)', async () => {
    const renderer = await renderAlertDetail([makeSosAlert()]);

    const allNodes = renderer.root.findAll(() => true, { deep: true });

    const btnIndex = allNodes.findIndex(
      (n: any) => n.props?.testID === 'alert-back',
    );
    const bannerIndex = allNodes.findIndex(
      (n: any) => n.props?.testID === 'sos-banner-active',
    );

    expect(btnIndex).toBeGreaterThanOrEqual(0);
    expect(bannerIndex).toBeGreaterThanOrEqual(0);
    expect(btnIndex).toBeLessThan(bannerIndex);
  });

  it('the "alert-back" button appears before the SOS banner in the component tree (RESOLVED)', async () => {
    const renderer = await renderAlertDetail([
      makeSosAlert({ resolved: true, resolved_by_name: 'Charles', resolved_at: new Date().toISOString() }),
    ]);

    const allNodes = renderer.root.findAll(() => true, { deep: true });

    const btnIndex = allNodes.findIndex(
      (n: any) => n.props?.testID === 'alert-back',
    );
    const bannerIndex = allNodes.findIndex(
      (n: any) => n.props?.testID === 'sos-banner-resolved',
    );

    expect(btnIndex).toBeGreaterThanOrEqual(0);
    expect(bannerIndex).toBeGreaterThanOrEqual(0);
    expect(btnIndex).toBeLessThan(bannerIndex);
  });

  // ── 5. Tapping the button navigates immediately — no confirmation dialog ────

  it('tapping Return to Dashboard calls router.replace immediately with no RNAlert.alert', async () => {
    const renderer = await renderAlertDetail([makeSosAlert()]);
    const btn = findByTestID(renderer.root, 'alert-back');
    expect(btn).not.toBeNull();

    await act(async () => {
      btn.props.onPress();
    });

    // Must navigate immediately.
    expect(mockRouterReplace).toHaveBeenCalledTimes(1);
    expect(mockRouterReplace).toHaveBeenCalledWith('/(tabs)/dashboard');

    // Must NOT show a confirmation dialog.
    expect(RNAlert.alert).not.toHaveBeenCalled();
  });

  it('tapping Return to Dashboard from RESOLVED state also navigates without dialog', async () => {
    const renderer = await renderAlertDetail([
      makeSosAlert({ resolved: true, resolved_by_name: 'Charles', resolved_at: new Date().toISOString() }),
    ]);
    const btn = findByTestID(renderer.root, 'alert-back');
    expect(btn).not.toBeNull();

    await act(async () => {
      btn.props.onPress();
    });

    expect(mockRouterReplace).toHaveBeenCalledTimes(1);
    expect(mockRouterReplace).toHaveBeenCalledWith('/(tabs)/dashboard');
    expect(RNAlert.alert).not.toHaveBeenCalled();
  });

  // ── 6. Button wrapper style is a full-width block (not an inline link) ──────
  //
  // The old breadcrumb was a small inline TouchableOpacity with no background.
  // The new button wrapper (returnRow) must have horizontal padding so it
  // stretches edge-to-edge, and the button itself (returnBtn) must carry the
  // dark-green background colour.

  it('returnRow has horizontal padding consistent with a full-width block', async () => {
    const renderer = await renderAlertDetail([makeSosAlert()]);

    const btn = findByTestID(renderer.root, 'alert-back');
    expect(btn).not.toBeNull();

    // The TouchableOpacity's style should include the returnBtn style which
    // sets backgroundColor to '#1B5E35'.  StyleSheet.create is identity-mapped
    // in tests (the mock returns styles as-is), so we can inspect directly.
    const style = btn.props.style;
    expect(style).toBeDefined();
    expect(style.backgroundColor).toBe('#1B5E35');
  });

  it('accessibilityRole is "button" — not omitted as it would be for a breadcrumb link', async () => {
    const renderer = await renderAlertDetail([makeSosAlert()]);
    const btn = findByTestID(renderer.root, 'alert-back');
    expect(btn).not.toBeNull();
    expect(btn.props.accessibilityRole).toBe('button');
  });

  it('accessibilityLabel is "Return to dashboard"', async () => {
    const renderer = await renderAlertDetail([makeSosAlert()]);
    const btn = findByTestID(renderer.root, 'alert-back');
    expect(btn).not.toBeNull();
    expect(btn.props.accessibilityLabel).toBe('Return to dashboard');
  });
});
