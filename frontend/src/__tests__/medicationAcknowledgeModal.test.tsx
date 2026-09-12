import React from 'react';
import { act, create } from 'react-test-renderer';

const mockAlert = jest.fn();
const mockPost = jest.fn();
const mockDismiss = jest.fn();
let mockParams: Record<string, string> = {
  type: 'medication',
  reminder_id: 'reminder-1',
  stage: 'family_alert',
  member_name: 'Joyce',
};

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
    TouchableOpacity: wrap('TouchableOpacity'),
    ActivityIndicator: wrap('ActivityIndicator'),
    Platform: { OS: 'android', select: (options: any) => options.android },
    Alert: { alert: (...args: any[]) => mockAlert(...args) },
    StyleSheet: { create: (styles: any) => styles },
  };
});

jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: jest.fn() }),
  useLocalSearchParams: () => mockParams,
}));

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children, ...props }: any) => {
    const React = require('react');
    return React.createElement('SafeAreaView', props, children);
  },
}));

jest.mock('expo-notifications', () => ({
  dismissNotificationAsync: (...args: any[]) => mockDismiss(...args),
}));

jest.mock('../api', () => ({
  api: { post: (...args: any[]) => mockPost(...args) },
}));

jest.mock('../medicationAcknowledgment', () => ({
  acknowledgeMedicationOccurrence: jest.fn(),
}));

import NotificationActionScreen from '../../app/(modals)/acknowledge';

function findByTestID(root: ReturnType<typeof create>['root'], testID: string) {
  return root.findAll((node: any) => node.props?.testID === testID, { deep: true })[0] ?? null;
}

describe('family medication acknowledgment modal', () => {
  beforeEach(() => {
    mockParams = {
      type: 'medication',
      reminder_id: 'reminder-1',
      stage: 'family_alert',
      member_name: 'Joyce',
    };
    mockAlert.mockReset();
    mockPost.mockReset().mockResolvedValue({ status: 200 });
    mockDismiss.mockReset().mockResolvedValue(undefined);
  });

  it('does not false-success or dismiss when alert_id is absent', async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(<NotificationActionScreen />); });
    await act(async () => {
      await findByTestID(renderer.root, 'notif-acknowledge')?.props.onPress();
    });
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockDismiss).not.toHaveBeenCalled();
    expect(mockAlert).toHaveBeenCalled();
    expect(findByTestID(renderer.root, 'notif-acknowledge')).not.toBeNull();
  });

  it('acknowledges and dismisses only the exact notification after success', async () => {
    mockParams = {
      ...mockParams,
      alert_id: 'alert-1',
      notification_id: 'notification-1',
    };
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(<NotificationActionScreen />); });
    await act(async () => {
      await findByTestID(renderer.root, 'notif-acknowledge')?.props.onPress();
    });
    expect(mockPost).toHaveBeenCalledWith('/alerts/alert-1/ack');
    expect(mockDismiss).toHaveBeenCalledWith('notification-1');
    expect(findByTestID(renderer.root, 'notif-acknowledge')).toBeNull();
  });
});