import React from 'react';
import { act, create } from 'react-test-renderer';

let mockRoleState = {
  role: null as 'owner' | 'member' | null,
  loading: true,
  error: null,
  isOwner: false,
  isResolved: false,
};

jest.mock('react-native', () => {
  const React = require('react');
  const wrap = (name: string) => ({ children, ...props }: any) =>
    React.createElement(name, props, children);
  return {
    View: wrap('View'), Text: wrap('Text'), TextInput: wrap('TextInput'),
    TouchableOpacity: wrap('TouchableOpacity'), ScrollView: wrap('ScrollView'),
    KeyboardAvoidingView: wrap('KeyboardAvoidingView'),
    ActivityIndicator: wrap('ActivityIndicator'),
    Platform: { OS: 'android' },
    Alert: { alert: jest.fn() },
    StyleSheet: { create: (styles: any) => styles },
  };
});
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn() }),
  useLocalSearchParams: () => ({ memberId: 'member-1' }),
}));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children, ...props }: any) => {
    const React = require('react');
    return React.createElement('SafeAreaView', props, children);
  },
}));
jest.mock('../Icon', () => ({ Icon: () => null }));
jest.mock('../TimeSlotsEditor', () => ({
  TimeSlotsEditor: () => {
    const React = require('react');
    return React.createElement('time-slots-editor');
  },
  isValidHHMM: () => true,
}));
jest.mock('../api', () => ({ api: { post: jest.fn() } }));
jest.mock('../useFamilyGroupRole', () => ({
  useFamilyGroupRole: () => mockRoleState,
}));

import AddMedication from '../../app/add-medication/[memberId]';

function findByTestID(root: ReturnType<typeof create>['root'], testID: string) {
  return root.findAll((node: any) => node.props?.testID === testID, { deep: true })[0] ?? null;
}

describe('direct reminder route role gate', () => {
  test('does not flash mutation controls before the server role resolves', async () => {
    mockRoleState = { role: null, loading: true, error: null, isOwner: false, isResolved: false };
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(<AddMedication />); });

    expect(findByTestID(renderer.root, 'add-med-role-loading')).not.toBeNull();
    expect(findByTestID(renderer.root, 'add-med-submit')).toBeNull();
  });

  test('hides the direct form for a server-confirmed member', async () => {
    mockRoleState = { role: 'member', loading: false, error: null, isOwner: false, isResolved: true };
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(<AddMedication />); });

    expect(findByTestID(renderer.root, 'add-med-access-denied')).not.toBeNull();
    expect(findByTestID(renderer.root, 'add-med-submit')).toBeNull();
  });

  test('renders the mutation form only for a server-confirmed owner', async () => {
    mockRoleState = { role: 'owner', loading: false, error: null, isOwner: true, isResolved: true };
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(<AddMedication />); });

    expect(findByTestID(renderer.root, 'add-med-submit')).not.toBeNull();
    expect(findByTestID(renderer.root, 'add-med-access-denied')).toBeNull();
  });
});