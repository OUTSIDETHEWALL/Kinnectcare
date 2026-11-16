import React from 'react';
import { act, create } from 'react-test-renderer';

const mockStorage = new Map<string, string>();
const mockPost = jest.fn();
const mockReplace = jest.fn();
const mockRefresh = jest.fn();
let mockToken = 'INV-ACCEPTED';
let mockUser: any = { id: 'invited-user', family_group_id: 'family' };
const mockRouter = { replace: mockReplace };
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (key: string) => mockStorage.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => { mockStorage.set(key, value); }),
  removeItem: jest.fn(async (key: string) => { mockStorage.delete(key); }),
}));
jest.mock('react-native', () => ({
  View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity', ScrollView: 'ScrollView',
  ActivityIndicator: 'ActivityIndicator', StyleSheet: { create: (s: any) => s },
}));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ token: mockToken }), useRouter: () => mockRouter,
}));
jest.mock('../api', () => ({ api: { post: (...args: any[]) => mockPost(...args) } }));
jest.mock('../emailLinks', () => ({ requestEmailLink: jest.fn(), emailLinkError: (e: Error) => e.message }));
jest.mock('../AuthContext', () => ({
  useAuth: () => ({ user: mockUser, loading: false, refreshUser: mockRefresh }),
}));
import Screen from '../../app/invite/[token]';
import { clearPendingInvite, getPendingInvite, isInviteConsumed, setPendingInvite } from '../pendingInvite';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const pendingKey = '@kinnship/pending_invite_v1';
describe('real invitation screen with durable navigation storage', () => {
  let tree: ReturnType<typeof create> | undefined;
  const mount = async () => { await act(async () => { tree = create(<Screen />); }); };
  const pressExit = async () => {
    await act(async () => { await tree!.root.findByProps({ testID: 'invite-invalid-close' }).props.onPress(); });
  };
  beforeEach(() => {
    jest.clearAllMocks(); mockStorage.clear(); tree = undefined;
    mockToken = 'INV-ACCEPTED'; mockUser = { id: 'invited-user', family_group_id: 'family' };
    mockRefresh.mockResolvedValue(undefined);
    mockPost.mockResolvedValue({ data: { valid: true, family_group_id: 'family', family_name: 'Intended family' } });
  });
  afterEach(async () => { if (tree) await act(async () => { tree!.unmount(); }); });

  it('recovers an accepted server invitation without a local marker and never joins again', async () => {
    mockPost.mockResolvedValue({ data: { valid: true, already_member: true, family_group_id: 'family' } });
    await mount();
    expect(mockPost).toHaveBeenCalledWith('/auth/email-link/invitation/status', { invite_token: mockToken });
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(await getPendingInvite()).toBeNull();
    expect(await isInviteConsumed(mockToken)).toBe(true);
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/dashboard');
  });

  it('reopening an accepted email invitation after an OTA/remount skips preview and join', async () => {
    mockPost.mockResolvedValue({ data: { valid: true, already_member: true, family_group_id: 'family' } });
    await mount();
    await act(async () => { tree!.unmount(); });
    mockPost.mockClear(); mockReplace.mockClear();
    // Simulate an old route restored by the OS alongside persisted state.
    mockStorage.set(pendingKey, JSON.stringify({ token: mockToken, savedAt: new Date().toISOString() }));
    await mount();
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockStorage.has(pendingKey)).toBe(false);
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/dashboard');
  });

  it.each([
    [410, 'This invitation has expired. Ask your family for a new one.'],
    [410, 'This invitation was withdrawn. Ask your family for a new one.'],
    [404, 'This invitation is invalid.'],
  ])('clears a terminal invitation and offers a working signed-in exit: %s %s', async (status, detail) => {
    mockPost.mockRejectedValue({ response: { status, data: { detail } } });
    await mount();
    expect(JSON.stringify(tree!.toJSON())).toContain(detail);
    expect(JSON.stringify(tree!.toJSON())).toContain('Go to Family');
    expect(await getPendingInvite()).toBeNull();
    await pressExit();
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/dashboard');
  });

  it('a signed-out invalid link returns to Kinnship and cannot leave a pending invite', async () => {
    mockUser = null;
    mockPost.mockRejectedValue({ response: { status: 410, data: { detail: 'Invitation expired.' } } });
    await mount();
    expect(mockPost).toHaveBeenCalledWith('/auth/email-link/invitation', { invite_token: mockToken });
    expect(JSON.stringify(tree!.toJSON())).toContain('Back to Kinnship');
    await pressExit();
    expect(mockReplace).toHaveBeenCalledWith('/');
    expect(await getPendingInvite()).toBeNull();
  });

  it('repeated Close taps on an inactive invite always target the dashboard and keep pending state cleared', async () => {
    mockPost.mockRejectedValue({ response: { status: 410, data: { detail: 'Invitation expired.' } } });
    await mount();
    const close = tree!.root.findByProps({ testID: 'invite-invalid-close' }).props.onPress;
    await act(async () => { await Promise.all([close(), close(), close()]); });
    expect(mockReplace).toHaveBeenCalledTimes(3);
    expect(mockReplace.mock.calls.every(([route]) => route === '/(tabs)/dashboard')).toBe(true);
    expect(await getPendingInvite()).toBeNull();
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('allows leaving while verification never resolves', async () => {
    mockPost.mockImplementation(() => new Promise(() => {}));
    await mount();
    expect((await getPendingInvite())?.token).toBe(mockToken);
    await pressExit();
    expect(await getPendingInvite()).toBeNull();
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/dashboard');
  });

  it('cleans accepted navigation before refreshing and survives a refresh failure/restart', async () => {
    mockUser = { id: 'invited-user', family_group_id: 'previous-family' };
    mockRefresh.mockImplementation(async () => {
      expect(await isInviteConsumed(mockToken)).toBe(true);
      expect(await getPendingInvite()).toBeNull();
      throw new Error('Could not refresh your account');
    });
    await mount();
    mockPost.mockResolvedValue({ data: { ok: true } });
    await act(async () => { await tree!.root.findByProps({ testID: 'invite-join-btn' }).props.onPress(); });
    expect(mockRefresh).toHaveBeenCalled();
    expect(await getPendingInvite()).toBeNull();
    await pressExit();
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/dashboard');
    await act(async () => { tree!.unmount(); });
    mockPost.mockClear();
    await mount();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('successful acceptance immediately opens the dashboard, without a navigation timer', async () => {
    mockUser = { id: 'invited-user', family_group_id: 'previous-family' };
    await mount();
    mockPost.mockResolvedValue({ data: { ok: true } });
    await act(async () => { await tree!.root.findByProps({ testID: 'invite-join-btn' }).props.onPress(); });
    expect(mockPost).toHaveBeenLastCalledWith('/auth/email-link/join', {
      invite_token: mockToken, expected_family_id: 'family', previous_family_id: 'previous-family', confirmed: true,
    });
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/dashboard');
    expect(await getPendingInvite()).toBeNull();
  });

  it('a transient verification failure is not described as an expired invitation', async () => {
    mockPost.mockRejectedValue(new Error('offline'));
    await mount();
    expect(JSON.stringify(tree!.toJSON())).toContain("We couldn't check this invitation");
    expect(JSON.stringify(tree!.toJSON())).not.toContain('This invitation is no longer active');
    await pressExit();
    expect(await getPendingInvite()).toBeNull();
  });

  it('retries an offline invitation check in place without losing the invitation', async () => {
    mockPost.mockRejectedValueOnce(new Error('offline'));
    await mount();
    expect((await getPendingInvite())?.token).toBe(mockToken);
    await act(async () => { tree!.root.findByProps({ testID: 'invite-retry' }).props.onPress(); });
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(tree!.root.findByProps({ testID: 'invite-join-btn' })).toBeTruthy();
  });

  it('a secure signed-in user joins with no verification email, even on concurrent taps', async () => {
    const { requestEmailLink } = require('../emailLinks');
    mockUser = { id: 'invited-user', full_name: 'Invited Person', family_group_id: 'previous-family' };
    await mount();
    expect(JSON.stringify(tree!.toJSON())).toContain('Confirm and join family');
    let resolve: any;
    mockPost.mockImplementation(() => new Promise(done => { resolve = done; }));
    const join = tree!.root.findByProps({ testID: 'invite-join-btn' }).props.onPress;
    let pending: Promise<any>;
    await act(async () => { pending = join(); void join(); });
    expect(mockPost.mock.calls.filter(([path]) => path === '/auth/email-link/join')).toHaveLength(1);
    await act(async () => { resolve({ data: { ok: true } }); await pending!; });
    expect(requestEmailLink).not.toHaveBeenCalled();
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/dashboard');
  });

  it('a signed-out invite requests proof only for that invitation, never family creation', async () => {
    const { requestEmailLink } = require('../emailLinks');
    mockUser = null;
    await mount();
    await act(async () => { await tree!.root.findByProps({ testID: 'invite-join-btn' }).props.onPress(); });
    expect(requestEmailLink).toHaveBeenCalledWith({ inviteToken: mockToken });
    expect(mockReplace).toHaveBeenCalledWith({
      pathname: '/(auth)/login', params: { invite_token: mockToken, sent: '1' },
    });
    expect(mockPost.mock.calls.filter(([path]) => path === '/auth/email-link/join')).toHaveLength(0);
  });

  it('dismissing an old error screen preserves another saved invitation', async () => {
    mockPost.mockRejectedValue({ response: { status: 410, data: { detail: 'Expired' } } });
    await mount();
    await setPendingInvite('INV-NEW');
    await pressExit();
    expect((await getPendingInvite())?.token).toBe('INV-NEW');
    await clearPendingInvite();
  });
});
