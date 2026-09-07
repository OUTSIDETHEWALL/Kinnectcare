(global as any).IS_REACT_ACT_ENVIRONMENT = true;

const mockGetFamilyGroup = jest.fn();
const mockLeaveFamilyGroup = jest.fn();
const mockRefreshUser = jest.fn();
const mockFetchAll = jest.fn();
const mockSetMyMemberId = jest.fn();

jest.mock('react-native', () => {
  const React = require('react');
  const wrap = (name: string) => {
    const Component = ({ children, ...props }: any) =>
      React.createElement(name, props, children);
    Component.displayName = name;
    return Component;
  };

  return {
    View: wrap('View'),
    Text: wrap('Text'),
    ScrollView: wrap('ScrollView'),
    TouchableOpacity: wrap('TouchableOpacity'),
    TextInput: wrap('TextInput'),
    ActivityIndicator: wrap('ActivityIndicator'),
    Modal: ({ visible, children, ...props }: any) =>
      visible ? React.createElement('Modal', props, children) : null,
    Alert: { alert: jest.fn() },
    Share: { share: jest.fn() },
    Platform: {
      OS: 'android',
      select: (options: any) => options.android ?? options.default,
    },
    StyleSheet: { create: (styles: any) => styles },
  };
});

jest.mock('expo-router', () => ({
  useRouter: () => ({
    canGoBack: () => true,
    back: jest.fn(),
    replace: jest.fn(),
  }),
  useFocusEffect: (callback: () => void) => {
    const React = require('react');
    React.useEffect(callback, []);
  },
}));

jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  return {
    SafeAreaView: ({ children, ...props }: any) =>
      React.createElement('SafeAreaView', props, children),
  };
});

jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn(),
}));

jest.mock('../Icon', () => ({ Icon: () => null }));
jest.mock('../theme', () => ({
  Colors: {
    background: '#F9F5F0',
    surface: '#FFFFFF',
    textPrimary: '#111111',
    textSecondary: '#444444',
    textTertiary: '#666666',
    primary: '#0B5135',
    tertiary: '#EEF4EF',
    border: '#DDDDDD',
    error: '#B42318',
    errorBg: '#FEE4E2',
    success: '#067647',
    successBg: '#ECFDF3',
  },
}));
jest.mock('../legal', () => ({ APP_NAME: 'Kinnship' }));
jest.mock('../AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'member-user', full_name: 'Member User', email: 'member@example.test' },
    refreshUser: (...args: any[]) => mockRefreshUser(...args),
  }),
}));
jest.mock('../locationRefresh', () => ({
  setMyMemberId: (...args: any[]) => mockSetMyMemberId(...args),
}));
jest.mock('../store/memberStore', () => ({
  fetchAll: (...args: any[]) => mockFetchAll(...args),
}));
jest.mock('../api', () => ({
  getFamilyGroup: (...args: any[]) => mockGetFamilyGroup(...args),
  leaveFamilyGroup: (...args: any[]) => mockLeaveFamilyGroup(...args),
  listFamilyInvites: jest.fn(() => Promise.resolve({ invites: [] })),
  renameFamilyGroup: jest.fn(),
  regenerateInviteCode: jest.fn(),
  joinFamilyGroup: jest.fn(),
  removeFamilyMember: jest.fn(),
  sendFamilyInvite: jest.fn(),
  revokeFamilyInvite: jest.fn(),
}));

import React from 'react';
import { act, create } from 'react-test-renderer';
import FamilyGroupScreen from '../../app/family-group';

const familyResponse = {
  group: { name: 'Smith Family', invite_code: 'KINN-TEST' },
  my_role: 'member',
  member_count: 2,
  members: [
    {
      user_id: 'member-user',
      full_name: 'Member User',
      email: 'member@example.test',
      role: 'member',
    },
    {
      user_id: 'owner-user',
      full_name: 'Owner User',
      email: 'owner@example.test',
      role: 'owner',
    },
  ],
};

function findByTestID(root: ReturnType<typeof create>['root'], testID: string) {
  return root.findAll(
    (node: any) => node.props?.testID === testID,
    { deep: true },
  )[0] ?? null;
}

async function renderScreen(response = familyResponse) {
  mockGetFamilyGroup.mockResolvedValue(response);
  mockFetchAll.mockResolvedValue([{ id: 'member-record', user_id: 'member-user' }]);
  mockRefreshUser.mockResolvedValue(undefined);
  mockSetMyMemberId.mockResolvedValue(undefined);

  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<FamilyGroupScreen />);
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
  return renderer;
}

describe('Leave Family confirmation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('opening and cancelling the in-app confirmation never calls the API', async () => {
    const renderer = await renderScreen();

    await act(async () => {
      findByTestID(renderer.root, 'fg-leave').props.onPress();
    });
    expect(findByTestID(renderer.root, 'fg-leave-confirm-modal')).not.toBeNull();
    expect(mockLeaveFamilyGroup).not.toHaveBeenCalled();

    await act(async () => {
      findByTestID(renderer.root, 'fg-leave-cancel').props.onPress();
    });
    expect(findByTestID(renderer.root, 'fg-leave-confirm-modal')).toBeNull();
    expect(mockLeaveFamilyGroup).not.toHaveBeenCalled();
  });

  test('rapid confirmation taps issue exactly one leave request', async () => {
    let resolveLeave!: () => void;
    mockLeaveFamilyGroup.mockImplementation(
      () => new Promise<void>((resolve) => { resolveLeave = resolve; }),
    );
    const renderer = await renderScreen();

    await act(async () => {
      findByTestID(renderer.root, 'fg-leave').props.onPress();
    });
    const confirm = findByTestID(renderer.root, 'fg-leave-confirm');

    await act(async () => {
      const first = confirm.props.onPress();
      const second = confirm.props.onPress();
      expect(mockLeaveFamilyGroup).toHaveBeenCalledTimes(1);
      resolveLeave();
      await Promise.all([first, second]);
    });

    expect(mockLeaveFamilyGroup).toHaveBeenCalledTimes(1);
    expect(findByTestID(renderer.root, 'fg-leave-confirm-modal')).toBeNull();
  });

  test('members do not render owner invite or removal controls', async () => {
    const renderer = await renderScreen();

    expect(findByTestID(renderer.root, 'fg-invite-code-section')).toBeNull();
    expect(findByTestID(renderer.root, 'fg-email-invites')).toBeNull();
    expect(findByTestID(renderer.root, 'fg-rename')).toBeNull();
    expect(findByTestID(renderer.root, 'fg-remove-member-user')).toBeNull();
    expect(findByTestID(renderer.root, 'fg-leave')).not.toBeNull();
  });

  test('owners render family administration controls', async () => {
    const renderer = await renderScreen({
      ...familyResponse,
      my_role: 'owner' as const,
      members: [
        { ...familyResponse.members[0], role: 'owner' as const },
        { ...familyResponse.members[1], role: 'member' as const },
      ],
    });

    expect(findByTestID(renderer.root, 'fg-invite-code-section')).not.toBeNull();
    expect(findByTestID(renderer.root, 'fg-copy-code')).not.toBeNull();
    expect(findByTestID(renderer.root, 'fg-share-code')).not.toBeNull();
    expect(findByTestID(renderer.root, 'fg-regen-code')).not.toBeNull();
    expect(findByTestID(renderer.root, 'fg-email-invites')).not.toBeNull();
    expect(findByTestID(renderer.root, 'fg-rename')).not.toBeNull();
    expect(findByTestID(renderer.root, 'fg-remove-owner-user')).not.toBeNull();
  });
});