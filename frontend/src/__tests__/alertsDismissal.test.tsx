(global as any).IS_REACT_ACT_ENVIRONMENT = true;
jest.mock('react-native', () => {
  const React = require('react');
  const wrap = (name: string) => ({ children, ...props }: any) => React.createElement(name, props, children);
  return {
    View: wrap('View'), Text: wrap('Text'), ScrollView: wrap('ScrollView'),
    TouchableOpacity: wrap('TouchableOpacity'), RefreshControl: wrap('RefreshControl'),
    ActivityIndicator: wrap('ActivityIndicator'), StyleSheet: { create: (x: any) => x },
    Alert: { alert: jest.fn() }, Linking: { openURL: jest.fn() },
    Platform: { OS: 'android', select: (x: any) => x.android ?? x.default },
  };
});
let mockFocus: (() => void | (() => void)) | undefined;
jest.mock('expo-router', () => ({
  useFocusEffect: (cb: () => void | (() => void)) => {
    mockFocus = cb;
    require('react').useEffect(cb, [cb]);
  },
}));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: any) => require('react').createElement('SafeAreaView', {}, children),
}));
const mockGet = jest.fn();
const mockDelete = jest.fn();
const mockPost = jest.fn();
jest.mock('../api', () => ({
  api: {
    get: (...args: any[]) => mockGet(...args),
    delete: (...args: any[]) => mockDelete(...args),
    post: (...args: any[]) => mockPost(...args),
  },
}));
const mockGetItem = jest.fn();
const mockSetItem = jest.fn();
const mockRemoveItem = jest.fn();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: (...args: any[]) => mockGetItem(...args),
    setItem: (...args: any[]) => mockSetItem(...args),
    removeItem: (...args: any[]) => mockRemoveItem(...args),
  },
}));
let mockUser = { id: 'caregiver', family_group_id: 'family' };
jest.mock('../AuthContext', () => ({ useAuth: () => ({ user: mockUser }) }));
jest.mock('../Icon', () => ({ Icon: () => null }));
jest.mock('../MemberMap', () => ({ __esModule: true, default: () => null }));
jest.mock('../timeFormat', () => ({ formatRelativeLocal: () => 'just now' }));

import React from 'react';
import { act, create } from 'react-test-renderer';
import { Alert as RNAlert } from 'react-native';
import Alerts from '../../app/(tabs)/alerts';
import { alertScope, isClearedAlert, sosResolution } from '../alertDismissals';

type Tree = ReturnType<typeof create>;
const trees: Tree[] = [];
const dialogs = RNAlert.alert as jest.Mock;
let disk: Map<string, string>;
let server: any[];
const sos = (id = 'sos', extra: Record<string, unknown> = {}) => ({
  id, type: 'sos' as const, title: id, message: 'Synthetic incident', member_name: 'Synthetic member',
  member_id: 'member', severity: 'critical' as const, acknowledged: true, resolved: true,
  resolved_at: '2026-11-21T12:00:00Z', created_at: '2026-11-21T11:00:00Z', ...extra,
});
const ordinary = () => sos('ordinary', { type: 'low_battery', acknowledged: false });
const nodes = (tree: Tree, id: string) => tree.root.findAll((n: any) => n.props.testID === id);
const text = (tree: Tree) => tree.root.findAll((n: any) => n.type === 'Text')
  .map((n: any) => n.children.filter((x: any) => typeof x === 'string').join('')).join(' ');
function deferred<T = any>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
async function mount() {
  let tree!: Tree;
  await act(async () => { tree = create(<Alerts />); });
  trees.push(tree);
  return tree;
}
function refresh(tree: Tree) {
  return tree.root.findAll((n: any) => n.props.refreshControl)[0].props.refreshControl.props.onRefresh();
}
async function openClear(tree: Tree) {
  await act(async () => { nodes(tree, 'alerts-clear-all')[0].props.onPress(); });
  const [title, message, buttons] = dialogs.mock.calls[dialogs.mock.calls.length - 1];
  return { title, message, confirm: buttons.find((b: any) => b.style === 'destructive').onPress };
}
async function clear(tree: Tree) {
  const prompt = await openClear(tree);
  await act(async () => { await prompt.confirm(); });
  return prompt;
}
beforeEach(() => {
  jest.resetAllMocks();
  jest.useFakeTimers();
  disk = new Map();
  server = [sos()];
  mockUser = { id: 'caregiver', family_group_id: 'family' };
  mockGetItem.mockImplementation(async key => disk.get(key) ?? null);
  mockSetItem.mockImplementation(async (key, value) => { disk.set(key, value); });
  mockRemoveItem.mockImplementation(async key => { disk.delete(key); });
  mockGet.mockImplementation(async () => ({ data: server.map(row => ({ ...row })) }));
  mockDelete.mockImplementation(async () => {
    server = server.filter(row => row.type === 'sos');
    return { data: { ok: true } };
  });
});
afterEach(async () => {
  await act(async () => { trees.splice(0).forEach(tree => tree.unmount()); });
  jest.clearAllTimers();
  jest.useRealTimers();
});

test('resolved dismissal survives refresh, focus, polling and cached offline process restart without touching incident history', async () => {
  const original = JSON.stringify(server);
  let tree = await mount();
  const prompt = await clear(tree);
  expect(prompt.message).toContain('this phone only');
  expect(prompt.message).toContain('30-day retention');
  expect(prompt.message).not.toContain('including SOS');
  expect(nodes(tree, 'alert-sos')).toHaveLength(0);
  await act(async () => { await refresh(tree); mockFocus?.(); jest.advanceTimersByTime(4500); });
  expect(nodes(tree, 'alert-sos')).toHaveLength(0);
  await act(async () => { tree.unmount(); });
  mockGet.mockRejectedValue(new Error('offline'));
  tree = await mount();
  expect(nodes(tree, 'alert-sos')).toHaveLength(0);
  expect(JSON.stringify(server)).toBe(original);
  expect(mockDelete).not.toHaveBeenCalled();
  expect(mockPost).not.toHaveBeenCalled();
  const scope = alertScope(mockUser)!;
  expect(JSON.parse(disk.get(scope.cacheKey)!)[0].id).toBe('sos'); // raw evidence retained
  expect(JSON.parse(disk.get(scope.dismissalsKey)!)).toEqual({
    version: 1, entries: { sos: String(Date.parse(server[0].resolved_at)) },
  });
});

test('acknowledged-but-unresolved and unknown-resolution emergencies stay active; explicitly resolved unacknowledged rows are cleared', async () => {
  server = [
    sos('active', { resolved: false, acknowledged: false }),
    sos('ack-only', { resolved: false }),
    sos('unknown', { resolved: undefined }),
    sos('resolved', { acknowledged: false }),
  ];
  const tree = await mount();
  expect(text(tree)).toContain('3 active · 1 cleared');
  expect(text(tree)).not.toContain('All clear!');
  await clear(tree);
  expect(nodes(tree, 'alert-resolved')).toHaveLength(0);
  for (const id of ['active', 'ack-only', 'unknown']) expect(nodes(tree, `alert-${id}`).length).toBeGreaterThan(0);
  expect(nodes(tree, 'alert-ack-ack-only')).toHaveLength(0);
  expect(nodes(tree, 'alerts-clear-all')).toHaveLength(0);
  expect(mockDelete).not.toHaveBeenCalled();
});

test.each([false, undefined, null, 'true'])('resolved=%s cannot become dismissible merely through acknowledgment', async resolved => {
  server = [sos('active', { resolved })];
  const tree = await mount();
  expect(text(tree)).toContain('1 active · 0 cleared');
  expect(nodes(tree, 'alerts-clear-all')).toHaveLength(0);
  expect(isClearedAlert(server[0])).toBe(false);
});

test('reopened SOS and a later resolution override an earlier dismissal', async () => {
  const tree = await mount();
  await clear(tree);
  server = [sos('sos', { resolved: false })];
  await act(async () => { await refresh(tree); });
  expect(text(tree)).toContain('1 active · 0 cleared');
  server = [sos('sos', { resolved_at: '2026-11-22T13:00:00Z' })];
  await act(async () => { await refresh(tree); });
  expect(nodes(tree, 'alert-sos').length).toBeGreaterThan(0);
  await clear(tree);
  expect(nodes(tree, 'alert-sos')).toHaveLength(0);
});

test('equivalent resolution timestamps identify the same notification; legacy explicitly resolved undated SOS can be dismissed', async () => {
  expect(sosResolution(sos())).toBe(sosResolution(sos('sos', { resolved_at: '2026-11-21T07:00:00-05:00' })));
  server = [sos('undated', { resolved_at: undefined })];
  const tree = await mount();
  await clear(tree);
  await act(async () => { await refresh(tree); });
  expect(nodes(tree, 'alert-undated')).toHaveLength(0);
});

test('a fetch already in flight cannot resurrect dismissed SOS and does preserve a new active SOS arrival', async () => {
  const tree = await mount();
  const pending = deferred();
  mockGet.mockReturnValueOnce(pending.promise);
  let refreshPromise!: Promise<void>;
  await act(async () => { refreshPromise = refresh(tree); });
  await clear(tree);
  await act(async () => {
    pending.resolve({ data: [sos(), sos('new-emergency', { resolved: false })] });
    await refreshPromise;
  });
  expect(nodes(tree, 'alert-sos')).toHaveLength(0);
  expect(nodes(tree, 'alert-new-emergency').length).toBeGreaterThan(0);
});

test('an older request cannot replace a newer reopened-emergency response', async () => {
  const tree = await mount();
  await clear(tree);
  const old = deferred();
  mockGet.mockReturnValueOnce(old.promise);
  let oldPromise!: Promise<void>;
  await act(async () => { oldPromise = refresh(tree); });
  server = [sos('sos', { resolved: false })];
  await act(async () => { await refresh(tree); });
  await act(async () => { old.resolve({ data: [sos()] }); await oldPromise; });
  expect(text(tree)).toContain('1 active · 0 cleared');
});

test('ordinary deletion preserves active SOS, resolved history and a new SOS arriving while DELETE is in flight', async () => {
  server = [ordinary(), sos()];
  const tree = await mount();
  const deletion = deferred();
  mockDelete.mockReturnValueOnce(deletion.promise);
  const prompt = await openClear(tree);
  let work!: Promise<void>;
  await act(async () => { work = prompt.confirm(); });
  server.push(sos('new-emergency', { resolved: false }));
  await act(async () => { await refresh(tree); });
  await act(async () => { deletion.resolve({ data: { ok: true } }); await work; });
  expect(nodes(tree, 'alert-ordinary')).toHaveLength(0);
  expect(nodes(tree, 'alert-sos')).toHaveLength(0);
  expect(nodes(tree, 'alert-new-emergency').length).toBeGreaterThan(0);
  expect(mockDelete.mock.calls[0][0]).toBe('/alerts');
  expect(server.filter(row => row.type === 'sos')).toHaveLength(2);
});

test('failed dismissal persistence leaves the resolved notification visible and does not delete ordinary alerts', async () => {
  server = [sos(), ordinary()];
  const tree = await mount();
  mockSetItem.mockImplementation(async (key, value) => {
    if (key.includes('sos_dismissals')) throw new Error('storage full');
    disk.set(key, value);
  });
  await clear(tree);
  expect(nodes(tree, 'alert-sos').length).toBeGreaterThan(0);
  expect(nodes(tree, 'alert-ordinary').length).toBeGreaterThan(0);
  expect(mockDelete).not.toHaveBeenCalled();
  expect(dialogs.mock.calls[dialogs.mock.calls.length - 1][0]).toBe('Could not clear');
});

test('a server deletion failure reports partial completion without resurrecting a successfully persisted SOS dismissal', async () => {
  server = [sos(), ordinary()];
  const tree = await mount();
  mockDelete.mockRejectedValue(new Error('server unavailable'));
  await clear(tree);
  expect(nodes(tree, 'alert-sos')).toHaveLength(0);
  expect(nodes(tree, 'alert-ordinary').length).toBeGreaterThan(0);
  expect(dialogs.mock.calls[dialogs.mock.calls.length - 1][1]).toContain('Some completed actions may remain applied');
  await act(async () => { await refresh(tree); });
  expect(nodes(tree, 'alert-sos')).toHaveLength(0);
});

test.each(['account', 'family'])('dismissals and cached data are isolated across %s changes', async change => {
  const tree = await mount();
  await clear(tree);
  const oldKey = alertScope(mockUser)!.dismissalsKey;
  mockUser = change === 'account' ? { ...mockUser, id: 'other' } : { ...mockUser, family_group_id: 'other' };
  await act(async () => { tree.update(<Alerts />); });
  expect(nodes(tree, 'alert-sos').length).toBeGreaterThan(0);
  expect(alertScope(mockUser)!.dismissalsKey).not.toBe(oldKey);
});

test('old dialogs and late network responses cannot operate on the replacement family', async () => {
  server = [sos(), ordinary()];
  const tree = await mount();
  const prompt = await openClear(tree);
  const pending = deferred();
  mockGet.mockReturnValueOnce(pending.promise);
  let work!: Promise<void>;
  await act(async () => { work = refresh(tree); });
  const signal = mockGet.mock.calls[mockGet.mock.calls.length - 1][1].signal;
  mockUser = { ...mockUser, family_group_id: 'replacement' };
  server = [sos('replacement-emergency', { resolved: false })];
  await act(async () => { tree.update(<Alerts />); });
  expect(signal.aborted).toBe(true);
  await act(async () => { await prompt.confirm(); pending.resolve({ data: [sos('old-family')] }); await work; });
  expect(mockDelete).not.toHaveBeenCalled();
  expect(nodes(tree, 'alert-old-family')).toHaveLength(0);
  expect(nodes(tree, 'alert-replacement-emergency').length).toBeGreaterThan(0);
});

test('account switch during local persistence never continues to the family-wide DELETE', async () => {
  server = [sos(), ordinary()];
  const tree = await mount();
  const pending = deferred<void>();
  mockSetItem.mockImplementation(async (key, value) => {
    if (key.includes('sos_dismissals')) await pending.promise;
    disk.set(key, value);
  });
  const prompt = await openClear(tree);
  let work!: Promise<void>;
  await act(async () => { work = prompt.confirm(); });
  mockUser = { ...mockUser, id: 'replacement' };
  await act(async () => { tree.update(<Alerts />); });
  await act(async () => { pending.resolve(); await work; });
  expect(mockDelete).not.toHaveBeenCalled();
  expect(nodes(tree, 'alert-sos').length).toBeGreaterThan(0);
});

test('two independent phone stores each dismiss resolved notifications without changing shared SOS history or hiding a later emergency', async () => {
  const phoneA = disk;
  const original = JSON.stringify(server);
  const a = await mount();
  await clear(a);
  await act(async () => { a.unmount(); });
  disk = new Map(); // another installation/process, same signed-in caregiver
  const phoneB = disk;
  const b = await mount();
  expect(nodes(b, 'alert-sos').length).toBeGreaterThan(0);
  await clear(b);
  expect(JSON.stringify(server)).toBe(original);
  expect(phoneA.has(alertScope(mockUser)!.dismissalsKey)).toBe(true);
  expect(phoneB.has(alertScope(mockUser)!.dismissalsKey)).toBe(true);
  await act(async () => { b.unmount(); });
  server = [sos('sos', { resolved: false }), sos('new-emergency', { resolved: false, acknowledged: false })];
  for (const phone of [phoneA, phoneB]) {
    disk = phone;
    const tree = await mount();
    expect(text(tree)).toContain('2 active · 0 cleared');
    expect(nodes(tree, 'alerts-clear-all')).toHaveLength(0);
    await act(async () => { tree.unmount(); });
  }
  expect(mockDelete).not.toHaveBeenCalled();
  expect(mockPost).not.toHaveBeenCalled();
});

test('sender and caregiver phones both keep an acknowledged SOS active until resolution, then dismiss independently', async () => {
  const caregiver = { id: 'caregiver', family_group_id: 'family' };
  const sender = { id: 'sender', family_group_id: 'family' };
  const caregiverDisk = disk;
  const senderDisk = new Map<string, string>();
  server = [sos('incident', { resolved: false, resolved_at: undefined, acknowledged: false })];
  let tree = await mount();
  expect(nodes(tree, 'alerts-clear-all')).toHaveLength(0);
  mockPost.mockImplementation(async () => {
    server[0] = { ...server[0], acknowledged: true };
    return { data: { ok: true } };
  });
  await act(async () => { await nodes(tree, 'alert-ack-incident')[0].props.onPress(); });
  expect(text(tree)).toContain('1 active · 0 cleared');
  expect(nodes(tree, 'alerts-clear-all')).toHaveLength(0);
  await act(async () => { tree.unmount(); });
  mockUser = sender;
  disk = senderDisk;
  tree = await mount();
  expect(text(tree)).toContain('1 active · 0 cleared');
  expect(nodes(tree, 'alerts-clear-all')).toHaveLength(0);
  // Model the authoritative resolution separately; Clear All never calls it.
  server[0] = { ...server[0], resolved: true, resolved_at: '2026-11-22T15:00:00Z' };
  const incidentHistory = JSON.stringify(server);
  await act(async () => { await refresh(tree); });
  await clear(tree);
  await act(async () => { tree.unmount(); });
  mockUser = caregiver;
  disk = caregiverDisk;
  tree = await mount();
  expect(nodes(tree, 'alert-incident').length).toBeGreaterThan(0);
  await clear(tree);
  expect(JSON.stringify(server)).toBe(incidentHistory);
  expect(mockPost.mock.calls.map(call => call[0])).toEqual(['/alerts/incident/ack']);
  expect(mockDelete).not.toHaveBeenCalled();
});

test('failure reading saved dismissals cannot be overwritten as a successful Clear All', async () => {
  const tree = await mount();
  mockGetItem.mockImplementation(async key => {
    if (key.includes('sos_dismissals')) throw new Error('read failed');
    return disk.get(key) ?? null;
  });
  await clear(tree);
  expect(nodes(tree, 'alert-sos').length).toBeGreaterThan(0);
  expect(dialogs.mock.calls[dialogs.mock.calls.length - 1][0]).toBe('Could not clear');
  expect(mockDelete).not.toHaveBeenCalled();
});

test('a dialog for an older resolution never dismisses a newer resolution arriving before confirmation', async () => {
  const tree = await mount();
  const prompt = await openClear(tree);
  server[0] = sos('sos', { resolved_at: '2026-11-22T20:00:00Z' });
  await act(async () => { await refresh(tree); });
  await act(async () => { await prompt.confirm(); });
  expect(nodes(tree, 'alert-sos').length).toBeGreaterThan(0);
  expect(disk.has(alertScope(mockUser)!.dismissalsKey)).toBe(false);
});

test('a reopened emergency stays visible when it arrives during a slow dismissal write', async () => {
  const tree = await mount();
  const pending = deferred<void>();
  mockSetItem.mockImplementation(async (key, value) => {
    if (key.includes('sos_dismissals')) await pending.promise;
    disk.set(key, value);
  });
  const prompt = await openClear(tree);
  let work!: Promise<void>;
  await act(async () => { work = prompt.confirm(); });
  server = [sos('sos', { resolved: false })];
  await act(async () => { await refresh(tree); });
  await act(async () => { pending.resolve(); await work; });
  expect(text(tree)).toContain('1 active · 0 cleared');
  expect(nodes(tree, 'alerts-clear-all')).toHaveLength(0);
});
