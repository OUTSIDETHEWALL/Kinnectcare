import React from 'react';
import { act, create } from 'react-test-renderer';

const mockRequest = jest.fn();
const mockPending = jest.fn();
const mockConsumed = jest.fn();
const mockReplace = jest.fn();
let mockUser: any = null;
let mockAuthLoading = false;
let mockParams: any = {};
jest.mock('../AuthContext', () => ({ useAuth: () => ({ user: mockUser, loading: mockAuthLoading }) }));
jest.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator', ScrollView: 'ScrollView', Text: 'Text',
  TextInput: 'TextInput', TouchableOpacity: 'TouchableOpacity',
  StyleSheet: { create: (v: any) => v },
}));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace, push: jest.fn() }),
  useLocalSearchParams: () => mockParams,
}));
jest.mock('../emailLinks', () => ({
  requestEmailLink: (...args: any[]) => mockRequest(...args),
  emailLinkError: (e: any) => e.message,
}));
jest.mock('../pendingInvite', () => ({
  getPendingInvite: () => mockPending(),
  isInviteConsumed: (token: string) => mockConsumed(token),
}));
import Screen from '../EmailSignInScreen';

describe('invitation context on sign-in recovery', () => {
  let tree: ReturnType<typeof create>;
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = {};
    mockUser = null; mockAuthLoading = false;
    mockPending.mockResolvedValue({ token: 'INV-SAVED' });
    mockConsumed.mockResolvedValue(false);
    mockRequest.mockResolvedValue(undefined);
  });
  afterEach(async () => { if (tree) await act(async () => tree.unmount()); });
  function sendButton() {
    return tree.root.findAllByType('TouchableOpacity' as any).find((n: any) => n.props.onPress && n.props.disabled !== undefined)!;
  }
  it('resumes an invitation using a restored secure session without another email', async () => {
    mockUser = { id: 'existing' };
    await act(async () => { tree = create(<Screen createFamily />); });
    await act(async () => { await sendButton().props.onPress(); });
    expect(mockReplace).toHaveBeenCalledWith('/invite/INV-SAVED');
    expect(mockRequest).not.toHaveBeenCalled();
    expect(JSON.stringify(tree.toJSON())).not.toContain('Create your family');
  });
  it('does not send email while the existing secure session is being restored', async () => {
    mockAuthLoading = true;
    await act(async () => { tree = create(<Screen />); });
    await act(async () => { await sendButton().props.onPress(); });
    expect(mockRequest).not.toHaveBeenCalled();
  });
  it('uses durable invitation context even after route parameters are lost on create-family entry', async () => {
    await act(async () => { tree = create(<Screen createFamily />); });
    expect(JSON.stringify(tree.toJSON())).toContain('Join your family');
    expect(JSON.stringify(tree.toJSON())).not.toContain('Create your family');
    await act(async () => { await sendButton().props.onPress(); });
    expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({
      inviteToken: 'INV-SAVED', createFamily: false,
    }));
  });
  it('does not send a context-free creation request while storage is still loading', async () => {
    let resolve: any;
    mockPending.mockImplementation(() => new Promise(r => { resolve = r; }));
    await act(async () => { tree = create(<Screen createFamily />); });
    expect(sendButton().props.disabled).toBe(true);
    await act(async () => { await sendButton().props.onPress(); });
    expect(mockRequest).not.toHaveBeenCalled();
    await act(async () => { resolve({ token: 'INV-SAVED' }); });
    expect(sendButton().props.disabled).toBe(false);
  });
  it('does not restore an already consumed invitation', async () => {
    mockConsumed.mockResolvedValue(true);
    await act(async () => { tree = create(<Screen />); });
    expect(JSON.stringify(tree.toJSON())).toContain('Welcome back');
    expect(JSON.stringify(tree.toJSON())).not.toContain('Join your family');
  });
  it('gives an explicit new invitation priority over an older stored invitation', async () => {
    mockParams = { invite_token: 'INV-NEW' };
    await act(async () => { tree = create(<Screen />); });
    await act(async () => { await sendButton().props.onPress(); });
    expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({ inviteToken: 'INV-NEW', createFamily: false }));
  });
});
