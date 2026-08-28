const mockPost = jest.fn();
const mockDismiss = jest.fn();
jest.mock('../api', () => ({
  api: { post: (...args: any[]) => mockPost(...args) },
  migrateTokenForBackgroundActions: jest.fn(() => Promise.resolve()),
}));

jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: { addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
}));

jest.mock('expo-task-manager', () => ({
  isTaskDefined: jest.fn(() => false),
  defineTask: jest.fn((_name: string, callback: (payload: any) => Promise<void>) => {
    (global as any).__welfareCheckBackgroundTask = callback;
  }),
}));

jest.mock('expo-notifications', () => ({
  AndroidNotificationPriority: { MIN: 'min', MAX: 'max' },
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
  setNotificationHandler: jest.fn(),
  dismissNotificationAsync: (...args: any[]) => mockDismiss(...args),
  registerTaskAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('expo-device', () => ({ isDevice: true }));
jest.mock('expo-constants', () => ({
  expoConfig: { extra: { eas: { projectId: 'test-project' } } },
}));

import { handleWelfareCheckAction } from '../push';
import * as Notifications from 'expo-notifications';

const response = {
  actionIdentifier: 'IM_OK',
  notification: {
    request: {
      identifier: 'notification-123',
      content: {
        data: {
          request_id: 'request-123',
          member_id: 'member-123',
        },
      },
    },
  },
};

describe('welfare-check notification action', () => {
  beforeEach(() => {
    mockPost.mockReset().mockResolvedValue({ status: 200 });
    mockDismiss.mockReset().mockResolvedValue(undefined);
  });

  it("sends the member-scoped response and dismisses without opening the app", async () => {
    await expect(handleWelfareCheckAction(response)).resolves.toBe(true);
    expect(mockPost).toHaveBeenCalledWith(
      '/members/member-123/welfare-check-response',
      { request_id: 'request-123' },
    );
    expect(mockDismiss).toHaveBeenCalledWith('notification-123');
  });

  it('registers a background task that handles an action while the app is terminated', async () => {
    expect(Notifications.registerTaskAsync).toHaveBeenCalledWith('KINNSHIP_WELFARE_CHECK_RESPONSE');
    const task = (global as any).__welfareCheckBackgroundTask;
    expect(task).toBeDefined();
    await task({ data: response });
    expect(mockPost).toHaveBeenCalledWith(
      '/members/member-123/welfare-check-response',
      { request_id: 'request-123' },
    );
  });

  it('leaves ordinary notification-body taps for the normal deep-link handler', async () => {
    await expect(handleWelfareCheckAction({
      ...response,
      actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
    })).resolves.toBe(false);
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockDismiss).not.toHaveBeenCalled();
  });
});