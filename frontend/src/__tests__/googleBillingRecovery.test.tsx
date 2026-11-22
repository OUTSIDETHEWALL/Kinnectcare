import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const mockRecover = jest.fn();
const mockEnabled = jest.fn();
const mockListeners = new Set<(state: string) => void>();
let mockAuth: any;
jest.mock('../AuthContext', () => ({ useAuth: () => mockAuth }));
jest.mock('../googlePurchases', () => ({
  googlePurchasesEnabled: () => mockEnabled(),
  reconcileGooglePurchases: (...args: unknown[]) => mockRecover(...args),
}));
jest.mock('react-native', () => ({
  AppState: { addEventListener: (_: string, fn: (state: string) => void) => {
    mockListeners.add(fn);
    return { remove: () => mockListeners.delete(fn) };
  } },
}));
import { useGoogleBillingRecovery } from '../useGoogleBillingRecovery';

function Harness() { useGoogleBillingRecovery(); return React.createElement('Ready'); }
let tree: ReturnType<typeof TestRenderer.create>;
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mockAuth = { user: { id: 'buyer' }, loading: false, refreshUser: jest.fn() };
  mockEnabled.mockReturnValue(true);
  mockRecover.mockResolvedValue({ plan: 'family_plan' });
});
afterEach(async () => {
  if (tree) await act(async () => { tree.unmount(); });
  jest.clearAllTimers();
  jest.useRealTimers();
});
async function mount() { await act(async () => { tree = TestRenderer.create(<Harness />); }); }
async function tick(ms: number) { await act(async () => { await jest.advanceTimersByTimeAsync(ms); }); }

test('cold startup renders immediately, then recovers without opening a billing screen', async () => {
  await mount();
  expect(tree!.toJSON()).toEqual({ type: 'Ready', props: {}, children: null });
  expect(mockRecover).not.toHaveBeenCalled();
  await tick(1500);
  expect(mockRecover).toHaveBeenCalledWith('buyer', expect.any(Function));
  expect(mockAuth.refreshUser).toHaveBeenCalledTimes(1);
});

test.each(['loading', 'signed-out', 'old-binary'])('%s does not start recovery', async state => {
  if (state === 'loading') mockAuth.loading = true;
  if (state === 'signed-out') mockAuth.user = null;
  if (state === 'old-binary') mockEnabled.mockReturnValue(false);
  await mount(); await tick(120_000);
  expect(mockRecover).not.toHaveBeenCalled();
});

test('waits until authenticated restoration completes', async () => {
  mockAuth.loading = true;
  await mount(); await tick(1500);
  mockAuth.loading = false;
  await act(async () => { tree.update(<Harness />); });
  await tick(1500);
  expect(mockRecover).toHaveBeenCalledTimes(1);
});

test('failed recovery has a finite retry budget, including foreground events', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  mockRecover.mockRejectedValue(new Error('offline'));
  await mount(); await tick(120_000);
  for (const fn of mockListeners) fn('active');
  await tick(120_000);
  expect(mockRecover).toHaveBeenCalledTimes(3);
  expect(warn).toHaveBeenCalledWith('Google purchase recovery deferred after three attempts.');
  warn.mockRestore();
});

test('account change invalidates old recovery before any completion publication', async () => {
  let finish: (v: any) => void = () => {};
  mockRecover.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  await mount(); await tick(1500);
  const oldGuard = mockRecover.mock.calls[0][1];
  const oldRefresh = mockAuth.refreshUser;
  mockAuth = { ...mockAuth, user: { id: 'other' }, refreshUser: jest.fn() };
  await act(async () => { tree.update(<Harness />); });
  expect(oldGuard()).toBeUndefined();
  await act(async () => { finish({ plan: 'family_plan' }); });
  expect(oldRefresh).not.toHaveBeenCalled();
  expect(mockAuth.refreshUser).not.toHaveBeenCalled();
});

test('unmount cancels scheduled recovery and removes foreground listener', async () => {
  await mount();
  await act(async () => { tree.unmount(); });
  await tick(120_000);
  expect(mockRecover).not.toHaveBeenCalled();
  expect(mockListeners.size).toBe(0);
});
