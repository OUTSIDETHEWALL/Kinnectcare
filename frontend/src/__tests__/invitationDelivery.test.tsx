import React from 'react';
import { act, create } from 'react-test-renderer';

const mockSend = jest.fn();
const mockResend = jest.fn();
const mockAlert = jest.fn();
jest.mock('react-native', () => ({
  View: 'View', Text: 'Text', StyleSheet: { create: (s: any) => s },
  TextInput: 'TextInput', TouchableOpacity: 'TouchableOpacity', ScrollView: 'ScrollView',
  KeyboardAvoidingView: 'KeyboardAvoidingView', ActivityIndicator: 'ActivityIndicator',
  Modal: 'Modal', Platform: { OS: 'android', select: (options: any) => options.android ?? options.default },
  Alert: { alert: (...args: any[]) => mockAlert(...args) }, Share: { share: jest.fn() },
}));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn() }),
  useFocusEffect: (callback: any) => require('react').useEffect(callback, [callback]),
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
jest.mock('../AuthContext', () => ({ useAuth: () => ({ user: { id: 'owner' }, refreshUser: jest.fn() }) }));
jest.mock('../locationRefresh', () => ({ setMyMemberId: jest.fn() }));
jest.mock('../store/memberStore', () => ({ fetchAll: jest.fn() }));
jest.mock('../Icon', () => ({ Icon: 'Icon' }));
jest.mock('../api', () => ({
  sendFamilyInvite: (...args: any[]) => mockSend(...args),
  resendFamilyInvite: (...args: any[]) => mockResend(...args),
  isPaywall: () => null,
  getFamilyGroup: async () => ({
    group: { id: 'family', name: 'Owner Family', owner_user_id: 'owner', invite_code: 'KINN-OTHER' },
    my_role: 'owner', members: [],
  }),
  listFamilyInvites: async () => ({ invites: [] }),
}));
import Screen from '../../app/add-member';
import FamilyScreen from '../../app/family-group';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
describe('real invitation delivery and recovery form', () => {
  let tree: ReturnType<typeof create>;
  beforeEach(() => {
    jest.clearAllMocks();
    mockSend.mockResolvedValue({ delivered: false, invite: { id: 'original-invite', token: 'NEVER-TYPE-THIS' } });
    mockResend.mockResolvedValue({ delivered: true, invite: { id: 'original-invite' } });
  });
  afterEach(async () => { if (tree) await act(async () => tree.unmount()); });
  const modalVisible = (testID: string) => tree.root.findAllByType('Modal' as any)
    .find((modal: any) => modal.findAllByProps({ testID }).length > 0)?.props.visible;
  async function send() {
    await act(async () => { tree = create(<Screen />); });
    await act(async () => {
      tree.root.findByProps({ testID: 'invite-name-input' }).props.onChangeText('Invited Person');
      tree.root.findByProps({ testID: 'invite-email-input' }).props.onChangeText('invited@example.test');
    });
    await act(async () => { await tree.root.findByProps({ testID: 'invite-submit' }).props.onPress(); });
  }
  it('offers resend instead of manual entry when delivery fails, reusing the same invitation', async () => {
    await send();
    expect(JSON.stringify(tree.toJSON())).toContain('Email not delivered');
    expect(JSON.stringify(tree.toJSON())).not.toContain('NEVER-TYPE-THIS');
    await act(async () => { await tree.root.findByProps({ testID: 'invite-delivery-retry' }).props.onPress(); });
    expect(mockResend).toHaveBeenCalledWith('original-invite');
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(tree.toJSON())).toContain('Invitation sent');
  });
  it('reports resend throttling without claiming an email was sent', async () => {
    mockResend.mockRejectedValue({ response: { data: { detail: 'Please wait one minute before resending this invitation.' } } });
    await send();
    await act(async () => { await tree.root.findByProps({ testID: 'invite-delivery-retry' }).props.onPress(); });
    expect(JSON.stringify(tree.toJSON())).toContain('Please wait one minute');
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
  it.each(['throttle', 'network'])('keeps the original retry prompt through %s and allows retry after waiting', async kind => {
    jest.useFakeTimers();
    try {
      mockResend.mockRejectedValueOnce(kind === 'throttle'
        ? { response: { status: 429, data: { detail: 'Please wait one minute before resending this invitation.' } } }
        : new Error('Network Error'));
      await send();
      await act(async () => { await tree.root.findByProps({ testID: 'invite-delivery-retry' }).props.onPress(); });
      expect(modalVisible('invite-success-modal')).toBe(true);
      expect(JSON.stringify(tree.toJSON())).toContain(kind === 'throttle' ? 'Please wait one minute' : 'Your invitation is still saved');
      await act(async () => { jest.advanceTimersByTime(61000); });
      await act(async () => { await tree.root.findByProps({ testID: 'invite-delivery-retry' }).props.onPress(); });
      expect(mockResend.mock.calls).toEqual([['original-invite'], ['original-invite']]);
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(tree.toJSON())).toContain('Invitation sent');
    } finally {
      jest.useRealTimers();
    }
  });
  it('keeps duplicate-invitation recovery open after a temporary resend failure', async () => {
    mockSend.mockRejectedValue({ response: { data: { detail: {
      code: 'pending_invite_exists', invite_id: 'original-invite',
    } } } });
    mockResend.mockRejectedValueOnce(new Error('Network Error'));
    await send();
    await act(async () => { await tree.root.findByProps({ testID: 'pending-invite-resend' }).props.onPress(); });
    expect(modalVisible('pending-invite-modal')).toBe(true);
    expect(JSON.stringify(tree.toJSON())).toContain('Your invitation is still saved');
    await act(async () => { await tree.root.findByProps({ testID: 'pending-invite-resend' }).props.onPress(); });
    expect(mockResend.mock.calls).toEqual([['original-invite'], ['original-invite']]);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(tree.toJSON())).toContain('Invitation sent');
  });
  it('the family dashboard handles an existing invitation with same-link resend, not code entry', async () => {
    mockSend.mockRejectedValue({ response: { data: { detail: {
      code: 'pending_invite_exists', invite_id: 'original-invite',
    } } } });
    await act(async () => { tree = create(<FamilyScreen />); });
    await act(async () => {
      tree.root.findByProps({ testID: 'fg-invite-name' }).props.onChangeText('Invited Person');
      tree.root.findByProps({ testID: 'fg-invite-email' }).props.onChangeText('invited@example.test');
    });
    await act(async () => { await tree.root.findByProps({ testID: 'fg-invite-submit' }).props.onPress(); });
    expect(mockAlert).toHaveBeenCalledWith('Invitation already sent', expect.any(String), expect.any(Array));
    const buttons = mockAlert.mock.calls[0][2];
    await act(async () => { await buttons.find((b: any) => b.text === 'Resend invitation').onPress(); });
    expect(mockResend).toHaveBeenCalledWith('original-invite');
    expect(mockAlert).toHaveBeenLastCalledWith('Invitation sent', expect.stringContaining('same email'));
    expect(mockAlert.mock.calls.flat().join(' ')).not.toContain('NEVER-TYPE-THIS');
  });
});
