import React from 'react';
import { act, create } from 'react-test-renderer';

const mockPost = jest.fn();
const mockAccept = jest.fn();
const mockReplace = jest.fn();
let mockURL: string | null = null;
let mockUser: any = null;
const state = 'a'.repeat(64);
jest.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator', ScrollView: 'ScrollView', Text: 'Text',
  TextInput: 'TextInput', TouchableOpacity: 'TouchableOpacity',
}));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
jest.mock('expo-router', () => ({ useRouter: () => ({ replace: mockReplace }) }));
jest.mock('expo-linking', () => ({ useURL: () => mockURL }));
jest.mock('../EmailSignInScreen', () => ({ styles: {} }));
jest.mock('../AuthContext', () => ({ useAuth: () => ({ loading: false, user: mockUser, acceptEmailSession: mockAccept }) }));
jest.mock('../pendingInvite', () => ({
  setPendingInvite: jest.fn().mockResolvedValue(undefined),
  clearPendingInvite: jest.fn().mockResolvedValue(undefined),
  markInviteConsumed: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: async () => JSON.stringify({ ['a'.repeat(64)]: { verifier: 'b'.repeat(64), at: Date.now() } }),
}));
jest.mock('../api', () => ({ api: { post: (...args: any[]) => mockPost(...args) } }));
import Callback from '../../app/auth/email-link';
import { captureEmailLink, clearReceivedEmailLink, getReceivedEmailLink } from '../emailLinks';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const link = (token: string) => `kinnship://auth/email-link#token=${token}&state=${state}`;

describe('real email callback screen cold and warm delivery', () => {
  let tree: ReturnType<typeof create> | null;
  beforeEach(() => {
    jest.clearAllMocks();
    mockURL = null; mockUser = null; tree = null;
    const previous = getReceivedEmailLink();
    if (previous) clearReceivedEmailLink(previous.token);
    mockAccept.mockResolvedValue(undefined);
    mockPost.mockResolvedValue({ data: { access_token: 'session', user: { id: 'self' } } });
  });
  afterEach(async () => { if (tree) await act(async () => tree!.unmount()); });

  it('redeems a cold-start URL without code entry', async () => {
    mockURL = link('1'.repeat(64));
    await act(async () => { tree = create(<Callback />); });
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockAccept).toHaveBeenCalledWith({ access_token: 'session', user: { id: 'self' } });
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/dashboard');
  });
  it('receives a warm link even when the native initial URL is unrelated', async () => {
    mockURL = 'kinnship://invite/INV-OLD';
    await act(async () => { tree = create(<Callback />); });
    expect(mockPost).not.toHaveBeenCalled();
    await act(async () => { captureEmailLink(link('2'.repeat(64))); });
    expect(mockPost.mock.calls[0][1].token).toBe('2'.repeat(64));
    expect(mockAccept).toHaveBeenCalledTimes(1);
  });
  it('receives a warm link captured before the callback mounted', async () => {
    mockURL = 'kinnship://invite/INV-OLD';
    captureEmailLink(link('3'.repeat(64)));
    await act(async () => { tree = create(<Callback />); });
    expect(mockPost.mock.calls[0][1].token).toBe('3'.repeat(64));
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/dashboard');
  });
  it('does not replace an existing signed-in identity', async () => {
    mockUser = { id: 'already-signed-in' };
    mockURL = link('4'.repeat(64));
    await act(async () => { tree = create(<Callback />); });
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockAccept).not.toHaveBeenCalled();
  });
  it('keeps missing-account creation explicit after email proof', async () => {
    mockPost.mockResolvedValueOnce({ data: { needs_profile: true } });
    mockURL = link('5'.repeat(64));
    await act(async () => { tree = create(<Callback />); });
    expect(JSON.stringify(tree!.toJSON())).toContain('Create my family');
    expect(mockAccept).not.toHaveBeenCalled();
  });
});
