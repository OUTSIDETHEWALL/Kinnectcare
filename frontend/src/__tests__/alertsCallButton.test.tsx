/**
 * alertsCallButton.test.tsx
 * Task #47 — Component-level test for the Call button in the Alerts screen.
 *
 * Renders the real `app/(tabs)/alerts.tsx` component (not a copy) with a
 * mocked API response, then:
 *   - Finds the rendered Call button by testID
 *   - Presses it and asserts Linking.openURL receives `tel:<member_phone>`
 *   - Confirms the button is absent when member_phone is missing or wrong type
 *
 * All React Native native modules are mocked so the test runs in Node without
 * an Android/iOS device.
 */

// ── Configure act() support for react-test-renderer ─────────────────────────
// Without this flag React 19 + react-test-renderer emit "not configured to
// support act()" console errors.  The flag must be set before any React module
// is imported (jest.mock factories run first, so this top-level assignment is
// safe here).
(global as any).IS_REACT_ACT_ENVIRONMENT = true;

// ── Native-module mocks (must appear before imports) ─────────────────────────

jest.mock('react-native', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const React = require('react');

  // Generic host element wrapper: forwards testID / onPress props so
  // react-test-renderer can locate elements and invoke handlers.
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
    RefreshControl: wrap('RefreshControl'),
    ActivityIndicator: wrap('ActivityIndicator'),
    StyleSheet: { create: (s: any) => s, flatten: (s: any) => s },
    Platform: {
      select: (obj: any) => obj.default ?? obj.ios ?? Object.values(obj)[0],
      OS: 'ios',
    },
    Alert: { alert: jest.fn() },
    // Linking.openURL is defined here and retrieved via the import below.
    Linking: { openURL: jest.fn(() => Promise.resolve()) },
  };
});

jest.mock('expo-router', () => ({
  useFocusEffect: (cb: () => (() => void) | void) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { useEffect } = require('react');
    // Run the callback as a layout-effect equivalent so the component
    // kicks off its data-fetch during the initial render in tests.
    useEffect(() => {
      const cleanup = cb();
      return cleanup ?? undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
  },
}));

jest.mock('react-native-safe-area-context', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const React = require('react');
  return {
    SafeAreaView: ({ children, ...props }: any) =>
      React.createElement('SafeAreaView', props, children),
  };
});

// Local src/ module mocks (paths are relative to this test file)
jest.mock('../Icon', () => ({ Icon: () => null }));
jest.mock('../MemberMap', () => ({ __esModule: true, default: () => null }));
jest.mock('../timeFormat', () => ({ formatRelativeLocal: () => '2m ago' }));
jest.mock('../AuthContext', () => ({
  useAuth: () => ({ user: { id: 'caregiver-001' } }),
}));
jest.mock('../theme', () => ({
  Colors: {
    background: '#FFFFFF',
    surface: '#FFFFFF',
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

// api mock — set up before the component module loads
const mockApiGet = jest.fn();
const mockApiPost = jest.fn();
const mockApiDelete = jest.fn();

jest.mock('../api', () => ({
  api: {
    get: (...args: any[]) => mockApiGet(...args),
    post: (...args: any[]) => mockApiPost(...args),
    delete: (...args: any[]) => mockApiDelete(...args),
  },
}));

// ── Imports (after all mocks are registered) ──────────────────────────────────

import React from 'react';
import { create, act } from 'react-test-renderer';
import { Linking } from 'react-native';

// This is the REAL production component, not a copy or mirror.
import Alerts from '../../app/(tabs)/alerts';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeAlertDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: 'alert-001',
    member_id: 'member-001',
    member_name: 'Test Member',
    type: 'low_battery',
    severity: 'warning',
    title: "Test Member's battery is low",
    message: "Test Member's phone battery is at 10%.",
    acknowledged: false,
    member_phone: '+14805550100',
    created_at: '2026-08-11T12:00:00.000Z',
    ...overrides,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Find the first element whose testID prop matches the given value. */
function findByTestID(root: ReturnType<typeof create>['root'], testID: string) {
  const results = root.findAll(
    (node: any) => node.props != null && node.props.testID === testID,
    { deep: true },
  );
  return results[0] ?? null;
}

/** Render <Alerts />, settle the mocked API fetch, flush all state updates. */
async function renderWithAlerts(
  alerts: ReturnType<typeof makeAlertDoc>[],
): Promise<ReturnType<typeof create>> {
  mockApiGet.mockResolvedValue({ data: alerts });

  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<Alerts />);
  });
  // Flush micro-tasks produced by the resolved API promise
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

describe('Alerts screen — Call button (component-level)', () => {
  // ── 1. Button present when alert has a phone ────────────────────────────────

  it('renders the Call button for an active low_battery alert with member_phone', async () => {
    const renderer = await renderWithAlerts([makeAlertDoc()]);

    const btn = findByTestID(renderer.root, 'alert-call-alert-001');
    expect(btn).not.toBeNull();
  });

  // ── 2. Pressing the button dials the correct number ─────────────────────────

  it('pressing Call button passes tel:<phone> to Linking.openURL', async () => {
    const phone = '+14805550100';
    const renderer = await renderWithAlerts([makeAlertDoc({ member_phone: phone })]);

    const btn = findByTestID(renderer.root, 'alert-call-alert-001');
    expect(btn).not.toBeNull();

    await act(async () => {
      btn.props.onPress();
    });

    expect(Linking.openURL).toHaveBeenCalledTimes(1);
    expect(Linking.openURL).toHaveBeenCalledWith(`tel:${phone}`);
  });

  it('tel: URL is constructed verbatim from member_phone — no reformatting', async () => {
    // Confirms the onPress in alerts.tsx is: Linking.openURL(`tel:${a.member_phone}`)
    const phone = '602-555-0101';
    const renderer = await renderWithAlerts([
      makeAlertDoc({ id: 'alert-002', member_phone: phone }),
    ]);

    const btn = findByTestID(renderer.root, 'alert-call-alert-002');
    expect(btn).not.toBeNull();

    await act(async () => { btn.props.onPress(); });

    expect(Linking.openURL).toHaveBeenCalledWith(`tel:${phone}`);
  });

  // ── 3. Button absent when member has no phone ───────────────────────────────

  it('does NOT render Call button when member_phone is undefined', async () => {
    const renderer = await renderWithAlerts([
      makeAlertDoc({ member_phone: undefined }),
    ]);
    expect(findByTestID(renderer.root, 'alert-call-alert-001')).toBeNull();
  });

  it('does NOT render Call button when member_phone is null', async () => {
    const renderer = await renderWithAlerts([
      makeAlertDoc({ member_phone: null }),
    ]);
    expect(findByTestID(renderer.root, 'alert-call-alert-001')).toBeNull();
  });

  it('does NOT render Call button when member_phone is an empty string', async () => {
    // !!'' === false — the guard in alerts.tsx must hide the button
    const renderer = await renderWithAlerts([
      makeAlertDoc({ member_phone: '' }),
    ]);
    expect(findByTestID(renderer.root, 'alert-call-alert-001')).toBeNull();
  });

  // ── 4. Button absent for other alert types ─────────────────────────────────

  it('does NOT render Call button for missed_checkin alert even with phone', async () => {
    const renderer = await renderWithAlerts([
      makeAlertDoc({ type: 'missed_checkin', member_phone: '+14805550100' }),
    ]);
    expect(findByTestID(renderer.root, 'alert-call-alert-001')).toBeNull();
  });

  it('does NOT render Call button for sos alert even with phone', async () => {
    const renderer = await renderWithAlerts([
      makeAlertDoc({ type: 'sos', member_phone: '+14805550100' }),
    ]);
    expect(findByTestID(renderer.root, 'alert-call-alert-001')).toBeNull();
  });

  it('does NOT render Call button for medication alert even with phone', async () => {
    const renderer = await renderWithAlerts([
      makeAlertDoc({ type: 'medication', member_phone: '+14805550100' }),
    ]);
    expect(findByTestID(renderer.root, 'alert-call-alert-001')).toBeNull();
  });

  // ── 5. Button label uses first name only ───────────────────────────────────
  //
  // accessibilityLabel carries the FULL name ("Call Test Member") for screen
  // readers; the visible text rendered inside the button shows first-name only
  // ("Call Test").  We verify the accessible label here and rely on the pure
  // unit tests in callButtonGuard.test.ts for the first-name extraction logic.

  it('Call button accessibilityLabel contains the full member name', async () => {
    const renderer = await renderWithAlerts([
      makeAlertDoc({ member_name: 'Test Member' }),
    ]);
    const btn = findByTestID(renderer.root, 'alert-call-alert-001');
    expect(btn).not.toBeNull();

    // accessibilityLabel is set to `Call ${a.member_name}` in alerts.tsx
    expect(btn.props.accessibilityLabel).toBe('Call Test Member');
  });

  // ── 6. Multiple alerts dial their own numbers independently ────────────────

  it('each alert card dials its own member_phone, not a shared value', async () => {
    const renderer = await renderWithAlerts([
      makeAlertDoc({ id: 'alert-001', member_phone: '+14805550100' }),
      makeAlertDoc({
        id: 'alert-002',
        member_name: 'Leonidas',
        member_phone: '+16025550199',
      }),
    ]);

    const btn1 = findByTestID(renderer.root, 'alert-call-alert-001');
    const btn2 = findByTestID(renderer.root, 'alert-call-alert-002');
    expect(btn1).not.toBeNull();
    expect(btn2).not.toBeNull();

    await act(async () => { btn1.props.onPress(); });
    expect(Linking.openURL).toHaveBeenLastCalledWith('tel:+14805550100');

    await act(async () => { btn2.props.onPress(); });
    expect(Linking.openURL).toHaveBeenLastCalledWith('tel:+16025550199');

    expect(Linking.openURL).toHaveBeenCalledTimes(2);
  });
});
