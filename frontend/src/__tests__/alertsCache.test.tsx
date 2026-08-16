/**
 * alertsCache.test.tsx
 * Task #84 — Verify that the Alerts tab respects its AsyncStorage cache.
 *
 * Three regression guards:
 *
 *  1. Cached-first hydration: when AsyncStorage holds a prior list, the cached
 *     alerts are rendered BEFORE the network response resolves.  A force-kill
 *     restart must never show a blank screen while the fetch is in flight.
 *
 *  2. Network-failure resilience: when /alerts rejects, the cached list stays
 *     visible.  setAlerts must NOT be called with an empty array.
 *
 *  3. Clear-all invalidates the cache: after a successful DELETE /alerts, the
 *     AsyncStorage key is removed so a subsequent force-kill restart starts
 *     fresh rather than restoring deleted alerts.
 */

// React 19 act() support — must precede all React imports.
(global as any).IS_REACT_ACT_ENVIRONMENT = true;

// ── Native-module mocks ───────────────────────────────────────────────────────

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
    RefreshControl: wrap('RefreshControl'),
    ActivityIndicator: wrap('ActivityIndicator'),
    StyleSheet: { create: (s: any) => s, flatten: (s: any) => s },
    Platform: {
      select: (obj: any) => obj.default ?? obj.ios ?? Object.values(obj)[0],
      OS: 'ios',
    },
    Alert: { alert: jest.fn() },
    Linking: { openURL: jest.fn(() => Promise.resolve()) },
  };
});

jest.mock('expo-router', () => ({
  useFocusEffect: (cb: () => (() => void) | void) => {
    const { useEffect } = require('react');
    useEffect(() => {
      const cleanup = cb();
      return cleanup ?? undefined;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
  },
}));

jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  return {
    SafeAreaView: ({ children, ...props }: any) =>
      React.createElement('SafeAreaView', props, children),
  };
});

// ── AsyncStorage mock ─────────────────────────────────────────────────────────

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
jest.mock('../MemberMap', () => ({ __esModule: true, default: () => null }));
jest.mock('../timeFormat', () => ({ formatRelativeLocal: () => '2m ago' }));
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

// ── API mock ──────────────────────────────────────────────────────────────────

const mockApiGet    = jest.fn();
const mockApiPost   = jest.fn();
const mockApiDelete = jest.fn();

jest.mock('../api', () => ({
  api: {
    get:    (...args: any[]) => mockApiGet(...args),
    post:   (...args: any[]) => mockApiPost(...args),
    delete: (...args: any[]) => mockApiDelete(...args),
  },
}));

// ── AuthContext mock ──────────────────────────────────────────────────────────

const MOCK_USER_ID = 'user-42';
const CACHE_KEY = `@kinnship/alerts_v1_${MOCK_USER_ID}`;

jest.mock('../AuthContext', () => ({
  useAuth: () => ({ user: { id: MOCK_USER_ID } }),
}));

// ── Imports (after all mocks) ─────────────────────────────────────────────────

import React from 'react';
import { create, act } from 'react-test-renderer';

// Real production component — not a copy.
import Alerts from '../../app/(tabs)/alerts';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeAlert(overrides: Record<string, unknown> = {}) {
  return {
    id: 'alert-001',
    member_id: 'member-001',
    member_name: 'Joyce Doe',
    type: 'low_battery',
    severity: 'warning',
    title: "Joyce's battery is low",
    message: "Joyce's phone battery is at 10%.",
    acknowledged: false,
    member_phone: '+14805550100',
    created_at: '2026-08-11T12:00:00.000Z',
    ...overrides,
  };
}

// ── Tree traversal helpers ────────────────────────────────────────────────────

/** Find all nodes whose testID prop matches the given value. */
function findAllByTestID(root: ReturnType<typeof create>['root'], testID: string) {
  return root.findAll(
    (node: any) => node.props != null && node.props.testID === testID,
    { deep: true },
  );
}

/** Collect all string children from Text nodes in the tree. */
function collectTextContent(root: ReturnType<typeof create>['root']): string {
  const texts: string[] = [];
  root.findAll(
    (node: any) => {
      if (node.type === 'Text' && node.props?.children) {
        const flatten = (c: unknown): void => {
          if (typeof c === 'string') texts.push(c);
          else if (Array.isArray(c)) c.forEach(flatten);
          else if (c != null && typeof c === 'object') {
            const obj = c as Record<string, unknown>;
            if (obj.children) flatten(obj.children);
          }
        };
        flatten(node.props.children);
      }
      return false; // findAll predicate — keep scanning
    },
    { deep: true },
  );
  return texts.join(' ');
}

/** Return true when any node in the tree has the given type name. */
function hasNodeOfType(root: ReturnType<typeof create>['root'], typeName: string): boolean {
  return root.findAll(
    (node: any) => node.type === typeName,
    { deep: true },
  ).length > 0;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  // Default: AsyncStorage returns null (no cache)
  mockGetItem.mockResolvedValue(null);
  // Default: writes succeed
  mockSetItem.mockResolvedValue(undefined);
  mockRemoveItem.mockResolvedValue(undefined);
});

afterEach(() => {
  jest.useRealTimers();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Alerts screen — AsyncStorage cache', () => {

  // ── 1. Cached-first hydration ───────────────────────────────────────────────
  //
  // Pre-condition: AsyncStorage holds a list of two cached alerts.
  // Assertion: the component renders those alerts before the /alerts network
  // response has resolved (the network promise is never settled during the
  // initial act() window).

  it('renders cached alerts before the network response arrives', async () => {
    const cachedAlerts = [
      makeAlert({ id: 'cached-001', title: 'Cached low battery' }),
      makeAlert({ id: 'cached-002', title: 'Cached SOS', type: 'sos', severity: 'critical' }),
    ];

    // AsyncStorage has a populated cache.
    mockGetItem.mockResolvedValue(JSON.stringify(cachedAlerts));

    // Network request is deliberately never settled — simulates slow network.
    let resolveNetworkFetch!: (value: unknown) => void;
    const networkPromise = new Promise((res) => { resolveNetworkFetch = res; });
    mockApiGet.mockReturnValue(networkPromise);

    let renderer!: ReturnType<typeof create>;

    // Initial render + AsyncStorage hydration only (network still pending).
    await act(async () => {
      renderer = create(<Alerts />);
      // Allow AsyncStorage.getItem microtasks to resolve.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The cached alerts must appear in the rendered tree — no blank screen.
    const text = collectTextContent(renderer.root);
    expect(text).toContain('Cached low battery');
    expect(text).toContain('Cached SOS');

    // The full-screen spinner must NOT be shown — cache dismissed it.
    expect(hasNodeOfType(renderer.root, 'ActivityIndicator')).toBe(false);

    // Settle the network now to avoid dangling promise warnings.
    resolveNetworkFetch({ data: cachedAlerts });
    await act(async () => { await Promise.resolve(); });
  });

  // ── 2. AsyncStorage.getItem is called with the user-scoped cache key ────────

  it('reads AsyncStorage using the user-scoped cache key on mount', async () => {
    mockApiGet.mockResolvedValue({ data: [] });

    await act(async () => {
      create(<Alerts />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockGetItem).toHaveBeenCalledWith(CACHE_KEY);
  });

  // ── 3. Successful fetch writes to cache ─────────────────────────────────────

  it('persists the freshly-fetched list into AsyncStorage after a successful /alerts call', async () => {
    const freshAlerts = [makeAlert({ id: 'fresh-001' })];
    mockApiGet.mockResolvedValue({ data: freshAlerts });

    await act(async () => {
      create(<Alerts />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockSetItem).toHaveBeenCalledWith(
      CACHE_KEY,
      JSON.stringify(freshAlerts),
    );
  });

  // ── 4. Network-failure resilience ──────────────────────────────────────────
  //
  // When /alerts rejects, the component must NOT clear the displayed list.
  // With a pre-populated cache the user must continue seeing their cached
  // alerts (the regression is a blank-screen caused by clearing state on error).

  it('keeps cached alerts visible when the network fetch fails', async () => {
    const cachedAlerts = [makeAlert({ id: 'cached-001', title: 'Cached low battery' })];
    mockGetItem.mockResolvedValue(JSON.stringify(cachedAlerts));

    // Network rejects.
    mockApiGet.mockRejectedValue(new Error('Network error'));

    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<Alerts />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The cached alert title must still be visible.
    const text = collectTextContent(renderer.root);
    expect(text).toContain('Cached low battery');

    // setItem is only called on a successful write; must NOT have been called.
    expect(mockSetItem).not.toHaveBeenCalled();
  });

  // ── 5. Network failure shows offline banner, not a blank error card ─────────
  //
  // When cache exists and fetch fails, the compact offline banner must appear
  // (the list stays visible); the full-screen "Couldn't load alerts" error
  // card is only shown when there is no data at all.

  it('shows the offline retry banner (not a blank error card) when fetch fails but cache exists', async () => {
    const cachedAlerts = [makeAlert({ id: 'cached-001' })];
    mockGetItem.mockResolvedValue(JSON.stringify(cachedAlerts));
    mockApiGet.mockRejectedValue(new Error('Network error'));

    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<Alerts />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The offline banner retry button must be present.
    const retryBtns = findAllByTestID(renderer.root, 'alerts-retry');
    expect(retryBtns.length).toBeGreaterThan(0);

    // The banner text should mention cached alerts.
    const text = collectTextContent(renderer.root);
    expect(text.toLowerCase()).toContain('cached');
  });

  // ── 6. Clear-all invalidates the AsyncStorage cache ────────────────────────
  //
  // After a successful DELETE /alerts, AsyncStorage.removeItem must be called
  // with the user-scoped cache key so a force-kill restart starts fresh.

  it('removes the AsyncStorage cache key after a successful clear-all', async () => {
    const existingAlerts = [makeAlert({ id: 'alert-001' })];
    mockGetItem.mockResolvedValue(JSON.stringify(existingAlerts));
    mockApiGet.mockResolvedValue({ data: existingAlerts });
    mockApiDelete.mockResolvedValue({});

    // Capture the native Alert.alert call so we can invoke the "Clear all"
    // confirm handler programmatically.
    const { Alert: RNAlert } = require('react-native') as any;

    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<Alerts />);
      await Promise.resolve();
      await Promise.resolve();
    });

    // Tap "Clear All".
    const clearAllBtn = findAllByTestID(renderer.root, 'alerts-clear-all')[0];
    expect(clearAllBtn).toBeDefined();

    await act(async () => {
      clearAllBtn.props.onPress();
    });

    // Extract and invoke the destructive "Clear all" confirmation handler.
    expect(RNAlert.alert).toHaveBeenCalled();
    const [, , buttons] = RNAlert.alert.mock.calls[0] as [
      string,
      string,
      Array<{ text: string; style?: string; onPress?: () => Promise<void> }>,
    ];
    const confirmBtn = buttons.find((b) => b.style === 'destructive');
    expect(confirmBtn).toBeDefined();

    await act(async () => {
      await confirmBtn!.onPress!();
    });

    // The cache must have been invalidated.
    expect(mockRemoveItem).toHaveBeenCalledWith(CACHE_KEY);
  });

  // ── 7. Clear-all does NOT remove cache when DELETE /alerts fails ────────────
  //
  // If the server DELETE rejects, the local cache must be left intact so the
  // alerts remain visible on the next restart.

  it('does NOT remove the AsyncStorage cache when DELETE /alerts fails', async () => {
    const existingAlerts = [makeAlert({ id: 'alert-001' })];
    mockGetItem.mockResolvedValue(JSON.stringify(existingAlerts));
    mockApiGet.mockResolvedValue({ data: existingAlerts });
    mockApiDelete.mockRejectedValue(new Error('Server error'));

    const { Alert: RNAlert } = require('react-native') as any;

    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<Alerts />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const clearAllBtn = findAllByTestID(renderer.root, 'alerts-clear-all')[0];
    await act(async () => {
      clearAllBtn.props.onPress();
    });

    const [, , buttons] = RNAlert.alert.mock.calls[0] as [
      string,
      string,
      Array<{ text: string; style?: string; onPress?: () => Promise<void> }>,
    ];
    const confirmBtn = buttons.find((b) => b.style === 'destructive');

    await act(async () => {
      await confirmBtn!.onPress!();
    });

    // removeItem must NOT have been called — the cache is untouched.
    expect(mockRemoveItem).not.toHaveBeenCalled();
  });

  // ── 8. No-cache first launch shows spinner until network responds ───────────
  //
  // When there is no cache and the network is still in flight, the full-screen
  // ActivityIndicator must be shown (loading = true).  Once the fetch
  // resolves, the list replaces the spinner.

  it('shows the ActivityIndicator while loading when there is no cache', async () => {
    // No cache.
    mockGetItem.mockResolvedValue(null);

    let resolveNetworkFetch!: (value: unknown) => void;
    const networkPromise = new Promise((res) => { resolveNetworkFetch = res; });
    mockApiGet.mockReturnValue(networkPromise);

    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<Alerts />);
      await Promise.resolve();
    });

    // Spinner must be present before network resolves.
    expect(hasNodeOfType(renderer.root, 'ActivityIndicator')).toBe(true);

    // Settle network and verify spinner is gone, list appears.
    resolveNetworkFetch({ data: [] });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // After loading, spinner is replaced by the empty-state ("All clear!").
    expect(hasNodeOfType(renderer.root, 'ActivityIndicator')).toBe(false);
    const text = collectTextContent(renderer.root);
    expect(text).toContain('All clear');
  });
});
