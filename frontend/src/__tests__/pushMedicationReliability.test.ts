;(global as any).IS_REACT_ACT_ENVIRONMENT = true;

const mockDismiss = jest.fn();
const mockSchedule = jest.fn();
const mockAddReceived = jest.fn();
const mockAddResponse = jest.fn();
const mockLastResponse = jest.fn();
const mockClearLastResponse = jest.fn();
const mockStorageGet = jest.fn();
const mockStorageSet = jest.fn();
const mockStorageRemove = jest.fn();

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: (...args: any[]) => mockStorageGet(...args),
    setItem: (...args: any[]) => mockStorageSet(...args),
    removeItem: (...args: any[]) => mockStorageRemove(...args),
  },
}));

jest.mock('../api', () => ({
  api: { post: jest.fn() },
  migrateTokenForBackgroundActions: jest.fn(() => Promise.resolve()),
}));

jest.mock('../medicationAcknowledgment', () => ({
  handleMedicationAction: jest.fn(),
  replayPendingMedicationAcknowledgments: jest.fn(() => Promise.resolve()),
}));

jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: { currentState: 'active' },
}));

jest.mock('expo-task-manager', () => ({
  isTaskDefined: jest.fn(() => false),
  defineTask: jest.fn(),
  registerTaskAsync: jest.fn(() => Promise.resolve()),
}));

jest.mock('expo-device', () => ({ isDevice: true }));
jest.mock('expo-constants', () => ({
  expoConfig: { extra: { eas: { projectId: 'test-project' } } },
}));

jest.mock('expo-notifications', () => ({
  AndroidNotificationPriority: { MIN: 'min', MAX: 'max' },
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
  setNotificationHandler: jest.fn(),
  dismissNotificationAsync: (...args: any[]) => mockDismiss(...args),
  scheduleNotificationAsync: (...args: any[]) => mockSchedule(...args),
  registerTaskAsync: jest.fn(() => Promise.resolve()),
  addNotificationReceivedListener: (...args: any[]) => mockAddReceived(...args),
  addNotificationResponseReceivedListener: (...args: any[]) => mockAddResponse(...args),
  getLastNotificationResponseAsync: (...args: any[]) => mockLastResponse(...args),
  clearLastNotificationResponseAsync: (...args: any[]) => mockClearLastResponse(...args),
}));

import React from 'react';
import { act, create } from 'react-test-renderer';
import {
  notificationOccurrenceKey,
  rePresentSticky,
  shouldRePresentLocally,
  snoozeNotificationId,
  stableNotificationId,
  setAppReadyForDeepLink,
  useNotificationListeners,
  __resetNotificationResponseStateForTests,
} from '../push';
import { medicationSelfDueRoute } from '../medicationNotificationRoute';

const occurrence = {
  type: 'medication',
  reminder_id: 'reminder-1',
  member_id: 'member-1',
  slot_time: '08:00',
  local_date: '2026-09-12',
};

function notification(data: Record<string, any>): any {
  return {
    request: {
      identifier: 'remote-request-1',
      content: { title: 'Reminder', body: 'Take it', data },
    },
  };
}

function bodyResponse(id = 'response-1'): any {
  return {
    actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
    notification: {
      date: Date.now() - 10 * 60 * 1000,
      request: {
        identifier: id,
        content: {
          data: {
            type: 'medication',
            subtype: 'self_due',
            reminder_id: 'aspirin-reminder',
            member_id: 'joyce-member',
            slot_time: '14:00',
            local_date: '2026-09-16',
            occurrence_id: `occurrence-${id}`,
          },
        },
      },
    },
  };
}

describe('medication and routine notification reliability', () => {
  beforeEach(() => {
    mockDismiss.mockReset().mockResolvedValue(undefined);
    mockSchedule.mockReset().mockResolvedValue('scheduled-id');
    mockAddReceived.mockReset().mockReturnValue({ remove: jest.fn() });
    mockAddResponse.mockReset().mockReturnValue({ remove: jest.fn() });
    mockLastResponse.mockReset().mockResolvedValue(null);
    mockClearLastResponse.mockReset().mockResolvedValue(undefined);
    mockStorageGet.mockReset().mockResolvedValue(null);
    mockStorageSet.mockReset().mockResolvedValue(undefined);
    mockStorageRemove.mockReset().mockResolvedValue(undefined);
    __resetNotificationResponseStateForTests();
    setAppReadyForDeepLink(false);
  });

  it('gives repeated deliveries of one occurrence the same stable identity', () => {
    expect(stableNotificationId(occurrence)).toBe(stableNotificationId({ ...occurrence }));
    expect(notificationOccurrenceKey(occurrence)).toBe(
      notificationOccurrenceKey({
        ...occurrence,
        occurrence_id: undefined,
      }),
    );
  });

  it('separates same-day slots and the next day', () => {
    const morning = stableNotificationId(occurrence);
    const evening = stableNotificationId({ ...occurrence, slot_time: '20:00' });
    const nextDay = stableNotificationId({ ...occurrence, local_date: '2026-09-13' });

    expect(morning).not.toBe(evening);
    expect(morning).not.toBe(nextDay);
    expect(evening).not.toBe(nextDay);
  });

  it('uses backend occurrence metadata when available', () => {
    const first = stableNotificationId({ ...occurrence, occurrence_id: 'occurrence-abc' });
    const replay = stableNotificationId({
      ...occurrence,
      occurrence_id: 'occurrence-abc',
      slot_time: '20:00',
      local_date: '2026-09-13',
    });

    expect(first).toBe(replay);
  });

  it('does not locally re-present remote medication or routine pushes', async () => {
    const medication = notification(occurrence);
    const routine = notification({
      type: 'routine',
      reminder_id: 'routine-1',
      slot_time: '09:00',
      local_date: '2026-09-12',
    });

    expect(shouldRePresentLocally(medication.request.content.data)).toBe(false);
    expect(shouldRePresentLocally(routine.request.content.data)).toBe(false);
    await rePresentSticky(medication);
    await rePresentSticky(routine);

    expect(mockDismiss).not.toHaveBeenCalled();
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('uses one deterministic snooze identifier for repeated responses', () => {
    const first = snoozeNotificationId(occurrence, 'remote-request-1');
    const replay = snoozeNotificationId({ ...occurrence }, 'remote-request-1');
    const otherSlot = snoozeNotificationId(
      { ...occurrence, slot_time: '20:00' },
      'remote-request-2',
    );

    expect(first).toBe(replay);
    expect(first).not.toBe(otherSlot);
    expect(first).toContain('snooze10');
  });

  it('keeps one native response listener while RootNav callback rerenders', async () => {
    const callbacks: Array<(data: any) => void> = [];
    function ListenerHarness({ callback }: { callback: (data: any) => void }) {
      useNotificationListeners(callback);
      return null;
    }
    mockAddResponse.mockImplementation((callback: (data: any) => void) => {
      callbacks.push(callback);
      return { remove: jest.fn() };
    });

    const first = jest.fn();
    const latest = jest.fn();
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(React.createElement(ListenerHarness, { callback: first }));
    });
    await act(async () => {
      renderer.update(React.createElement(ListenerHarness, { callback: latest }));
    });

    expect(mockAddResponse).toHaveBeenCalledTimes(1);
    expect(callbacks).toHaveLength(1);

    const response = {
      actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
      notification: {
        request: {
          identifier: 'warm-medication-request',
          content: {
            data: {
              type: 'medication',
              subtype: 'self_due',
              reminder_id: 'aspirin-reminder',
              member_id: 'joyce-member',
              slot_time: '14:00',
              local_date: '2026-09-16',
              occurrence_id: 'occurrence-aspirin-1400',
            },
          },
        },
      },
    };
    await act(async () => {
      await callbacks[0](response);
      setAppReadyForDeepLink(true);
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
    expect(latest).toHaveBeenCalledWith(expect.objectContaining({
      type: 'medication',
      subtype: 'self_due',
      reminder_id: 'aspirin-reminder',
      member_id: 'joyce-member',
      slot_time: '14:00',
      local_date: '2026-09-16',
      occurrence_id: 'occurrence-aspirin-1400',
      notification_id: 'warm-medication-request',
    }));
    expect(medicationSelfDueRoute(latest.mock.calls[0][0])).toEqual({
      pathname: '/(modals)/acknowledge',
      params: {
        type: 'medication',
        reminder_id: 'aspirin-reminder',
        title: '',
        dosage: '',
        member_name: '',
        stage: '',
        member_id: 'joyce-member',
        slot_time: '14:00',
        local_date: '2026-09-16',
        occurrence_id: 'occurrence-aspirin-1400',
        notification_id: 'warm-medication-request',
      },
    });
  });

  it('recovers a cold-start medication body tap once with full occurrence metadata', async () => {
    const callback = jest.fn();
    const response = {
      actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
      notification: {
        // Expo's date is delivery time, not tap time. A killed-app response
        // must remain actionable even after the phone was unattended.
        date: Date.now() - 10 * 60 * 1000,
        request: {
          identifier: 'cold-medication-request',
          content: {
            data: {
              type: 'medication',
              subtype: 'self_due',
              reminder_id: 'aspirin-reminder',
              member_id: 'joyce-member',
              slot_time: '14:00',
              local_date: '2026-09-16',
              occurrence_id: 'occurrence-aspirin-1400-cold',
            },
          },
        },
      },
    };
    mockLastResponse.mockResolvedValue(response);
    mockAddResponse.mockReturnValue({ remove: jest.fn() });

    function ListenerHarness() {
      useNotificationListeners(callback);
      return null;
    }
    create(React.createElement(ListenerHarness));
    await new Promise(resolve => setTimeout(resolve, 10));
    await act(async () => {
      setAppReadyForDeepLink(true);
      await new Promise(resolve => setTimeout(resolve, 10));
    });

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({
      type: 'medication',
      subtype: 'self_due',
      reminder_id: 'aspirin-reminder',
      member_id: 'joyce-member',
      slot_time: '14:00',
      local_date: '2026-09-16',
      occurrence_id: 'occurrence-aspirin-1400-cold',
      notification_id: 'cold-medication-request',
    }));
    expect(mockStorageSet).toHaveBeenCalledWith(
      '@kinnship/notification_response_consumed_v1',
      JSON.stringify(['cold-medication-request']),
    );
    expect(mockClearLastResponse).toHaveBeenCalledTimes(1);

    // Simulate a fresh JS process: in-memory state is gone, but the bounded
    // durable request-id marker remains.
    __resetNotificationResponseStateForTests();
    mockStorageGet.mockResolvedValue(JSON.stringify(['cold-medication-request']));
    const restartedCallback = jest.fn();
    function RestartedListenerHarness() {
      useNotificationListeners(restartedCallback);
      return null;
    }
    mockLastResponse.mockResolvedValue(response);
    create(React.createElement(RestartedListenerHarness));
    await new Promise(resolve => setTimeout(resolve, 10));
    await act(async () => {
      setAppReadyForDeepLink(true);
      await new Promise(resolve => setTimeout(resolve, 10));
    });
    expect(restartedCallback).not.toHaveBeenCalled();
    expect(mockClearLastResponse).toHaveBeenCalledTimes(2);
  });

  it('does not enqueue or consume a tap when pending storage fails', async () => {
    mockStorageSet.mockRejectedValue(new Error('storage unavailable'));
    const callback = jest.fn();
    const callbacks: Array<(response: any) => Promise<void>> = [];
    mockAddResponse.mockImplementation((handler: any) => {
      callbacks.push(handler);
      return { remove: jest.fn() };
    });
    function ListenerHarness() {
      useNotificationListeners(callback);
      return null;
    }
    create(React.createElement(ListenerHarness));
    await new Promise(resolve => setTimeout(resolve, 10));
    await act(async () => {
      await callbacks[0](bodyResponse('storage-failure')).catch(() => {});
      setAppReadyForDeepLink(true);
      await new Promise(resolve => setTimeout(resolve, 10));
    });
    expect(callback).not.toHaveBeenCalled();
    expect(mockClearLastResponse).not.toHaveBeenCalled();
  });

  it('replays a pending record after a crash before enqueue/flush', async () => {
    const pending = {
      requestId: 'crash-before-flush',
      payload: { ...bodyResponse('crash-before-flush').notification.request.content.data },
    };
    const callbackHandlers: Array<(response: any) => Promise<void>> = [];
    mockAddResponse.mockImplementation((handler: any) => {
      callbackHandlers.push(handler);
      return { remove: jest.fn() };
    });
    function InitialHarness() {
      useNotificationListeners(jest.fn());
      return null;
    }
    create(React.createElement(InitialHarness));
    await new Promise(resolve => setTimeout(resolve, 10));
    await act(async () => {
      await callbackHandlers[0](bodyResponse('crash-before-flush'));
    });
    __resetNotificationResponseStateForTests();
    mockStorageGet.mockImplementation(async (key: string) => (
      key === '@kinnship/notification_response_pending_v1'
        ? JSON.stringify(pending)
        : null
    ));
    const replayed = jest.fn();
    function RestartedHarness() {
      useNotificationListeners(replayed);
      return null;
    }
    create(React.createElement(RestartedHarness));
    await new Promise(resolve => setTimeout(resolve, 10));
    await act(async () => {
      setAppReadyForDeepLink(true);
      await new Promise(resolve => setTimeout(resolve, 10));
    });
    expect(replayed).toHaveBeenCalledTimes(1);
    expect(replayed).toHaveBeenCalledWith(pending.payload);
  });

  it('keeps pending when the routing callback throws, then retries successfully', async () => {
    const callbacks: Array<(response: any) => Promise<void>> = [];
    mockAddResponse.mockImplementation((handler: any) => {
      callbacks.push(handler);
      return { remove: jest.fn() };
    });
    const failing = jest.fn(() => { throw new Error('RootNav not ready'); });
    function FailingHarness() {
      useNotificationListeners(failing);
      return null;
    }
    create(React.createElement(FailingHarness));
    await new Promise(resolve => setTimeout(resolve, 10));
    await act(async () => {
      await callbacks[0](bodyResponse('callback-failure'));
      setAppReadyForDeepLink(true);
      await new Promise(resolve => setTimeout(resolve, 10));
    });
    expect(failing).toHaveBeenCalledTimes(1);
    expect(mockClearLastResponse).not.toHaveBeenCalled();
    expect(mockStorageSet).not.toHaveBeenCalledWith(
      '@kinnship/notification_response_consumed_v1',
      expect.any(String),
    );

    __resetNotificationResponseStateForTests();
    const pending = {
      requestId: 'callback-failure',
      payload: { ...bodyResponse('callback-failure').notification.request.content.data },
    };
    mockStorageGet.mockImplementation(async (key: string) => (
      key === '@kinnship/notification_response_pending_v1'
        ? JSON.stringify(pending)
        : null
    ));
    const retried = jest.fn();
    function RetriedHarness() {
      useNotificationListeners(retried);
      return null;
    }
    create(React.createElement(RetriedHarness));
    await new Promise(resolve => setTimeout(resolve, 10));
    await act(async () => {
      setAppReadyForDeepLink(true);
      await new Promise(resolve => setTimeout(resolve, 10));
    });
    expect(retried).toHaveBeenCalledTimes(1);
    expect(mockClearLastResponse).toHaveBeenCalledTimes(1);
  });

  it('reconciles consumed plus pending remnant without routing again', async () => {
    const requestId = 'consumed-pending-remnant';
    const pending = {
      requestId,
      payload: { ...bodyResponse(requestId).notification.request.content.data },
    };
    mockStorageGet.mockImplementation(async (key: string) => {
      if (key === '@kinnship/notification_response_pending_v1') return JSON.stringify(pending);
      if (key === '@kinnship/notification_response_consumed_v1') return JSON.stringify([requestId]);
      return null;
    });
    const callback = jest.fn();
    function ListenerHarness() {
      useNotificationListeners(callback);
      return null;
    }
    create(React.createElement(ListenerHarness));
    await new Promise(resolve => setTimeout(resolve, 10));
    await act(async () => {
      setAppReadyForDeepLink(true);
      await new Promise(resolve => setTimeout(resolve, 10));
    });
    expect(callback).not.toHaveBeenCalled();
    expect(mockStorageRemove).toHaveBeenCalledWith(
      '@kinnship/notification_response_pending_v1',
    );
    expect(mockClearLastResponse).not.toHaveBeenCalled();
  });

  it('merges crash-pending A with newer cold response B and drains FIFO once', async () => {
    const a = bodyResponse('pending-a').notification.request.content.data;
    let pendingStorage = JSON.stringify([{
      requestId: 'pending-a',
      payload: a,
    }]);
    let consumedStorage: string | null = null;
    mockStorageGet.mockImplementation(async (key: string) => (
      key === '@kinnship/notification_response_pending_v1'
        ? pendingStorage
        : consumedStorage
    ));
    mockStorageSet.mockImplementation(async (key: string, value: string) => {
      if (key === '@kinnship/notification_response_pending_v1') pendingStorage = value;
      if (key === '@kinnship/notification_response_consumed_v1') consumedStorage = value;
    });
    mockStorageRemove.mockImplementation(async (key: string) => {
      if (key === '@kinnship/notification_response_pending_v1') pendingStorage = null as any;
    });
    mockLastResponse.mockResolvedValue(bodyResponse('cold-b'));
    const routed: any[] = [];
    function ListenerHarness() {
      useNotificationListeners((payload) => { routed.push(payload); });
      return null;
    }
    create(React.createElement(ListenerHarness));
    await new Promise(resolve => setTimeout(resolve, 10));
    await act(async () => {
      setAppReadyForDeepLink(true);
      await new Promise(resolve => setTimeout(resolve, 40));
    });
    expect(routed.map((payload) => payload.notification_id)).toEqual([
      undefined,
      'cold-b',
    ]);
    expect(JSON.parse(consumedStorage || '[]')).toEqual(['pending-a', 'cold-b']);
  });

  it('appends a live B behind pending A and dedupes duplicate B', async () => {
    const a = bodyResponse('pending-a').notification.request.content.data;
    let pendingStorage = JSON.stringify([{ requestId: 'pending-a', payload: a }]);
    mockStorageGet.mockImplementation(async (key: string) => (
      key === '@kinnship/notification_response_pending_v1' ? pendingStorage : null
    ));
    mockStorageSet.mockImplementation(async (key: string, value: string) => {
      if (key === '@kinnship/notification_response_pending_v1') pendingStorage = value;
    });
    mockStorageRemove.mockImplementation(async (key: string) => {
      if (key === '@kinnship/notification_response_pending_v1') pendingStorage = null as any;
    });
    mockLastResponse.mockResolvedValue(null);
    const responses: Array<(response: any) => Promise<void>> = [];
    mockAddResponse.mockImplementation((handler: any) => {
      responses.push(handler);
      return { remove: jest.fn() };
    });
    const routed: any[] = [];
    function ListenerHarness() {
      useNotificationListeners((payload) => { routed.push(payload); });
      return null;
    }
    create(React.createElement(ListenerHarness));
    await new Promise(resolve => setTimeout(resolve, 10));
    await act(async () => {
      await responses[0](bodyResponse('live-b'));
      await responses[0](bodyResponse('live-b'));
      setAppReadyForDeepLink(true);
      await new Promise(resolve => setTimeout(resolve, 40));
    });
    expect(routed.map((payload) => payload.notification_id)).toEqual([
      undefined,
      'live-b',
    ]);
  });

  it('blocks FIFO on callback failure, then retries A before B without dropping either', async () => {
    const a = bodyResponse('pending-a').notification.request.content.data;
    let pendingStorage = JSON.stringify([{ requestId: 'pending-a', payload: a }]);
    mockStorageGet.mockImplementation(async (key: string) => (
      key === '@kinnship/notification_response_pending_v1' ? pendingStorage : null
    ));
    mockStorageSet.mockImplementation(async (key: string, value: string) => {
      if (key === '@kinnship/notification_response_pending_v1') pendingStorage = value;
    });
    mockStorageRemove.mockImplementation(async (key: string) => {
      if (key === '@kinnship/notification_response_pending_v1') pendingStorage = null as any;
    });
    mockLastResponse.mockResolvedValue(null);
    const responses: Array<(response: any) => Promise<void>> = [];
    mockAddResponse.mockImplementation((handler: any) => {
      responses.push(handler);
      return { remove: jest.fn() };
    });
    let fail = true;
    const routed: any[] = [];
    const callback = jest.fn((payload) => {
      routed.push(payload.notification_id);
      if (fail) throw new Error('RootNav not ready');
    });
    function ListenerHarness() {
      useNotificationListeners(callback);
      return null;
    }
    create(React.createElement(ListenerHarness));
    await new Promise(resolve => setTimeout(resolve, 10));
    await act(async () => {
      await responses[0](bodyResponse('live-b'));
      setAppReadyForDeepLink(true);
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    expect(routed).toEqual([undefined]);
    fail = false;
    await act(async () => {
      setAppReadyForDeepLink(false);
      setAppReadyForDeepLink(true);
      await new Promise(resolve => setTimeout(resolve, 40));
    });
    expect(routed).toEqual([undefined, undefined, 'live-b']);
  });

  it('retains and drains more than the former cap across a restart during drain', async () => {
    let pendingStorage = JSON.stringify([]);
    let consumedStorage: string | null = null;
    mockStorageGet.mockImplementation(async (key: string) => (
      key === '@kinnship/notification_response_pending_v1'
        ? pendingStorage
        : consumedStorage
    ));
    mockStorageSet.mockImplementation(async (key: string, value: string) => {
      if (key === '@kinnship/notification_response_pending_v1') pendingStorage = value;
      if (key === '@kinnship/notification_response_consumed_v1') consumedStorage = value;
    });
    mockStorageRemove.mockImplementation(async (key: string) => {
      if (key === '@kinnship/notification_response_pending_v1') pendingStorage = JSON.stringify([]);
    });
    mockLastResponse.mockResolvedValue(null);
    const responseHandlers: Array<(response: any) => Promise<void>> = [];
    mockAddResponse.mockImplementation((handler: any) => {
      responseHandlers.push(handler);
      return { remove: jest.fn() };
    });
    const routed: string[] = [];
    let restarted = false;
    const callback = jest.fn((payload) => {
      routed.push(payload.notification_id);
      if (!restarted) {
        restarted = true;
        __resetNotificationResponseStateForTests();
      }
    });
    function ListenerHarness() {
      useNotificationListeners(callback);
      return null;
    }
    create(React.createElement(ListenerHarness));
    await new Promise(resolve => setTimeout(resolve, 10));

    for (let i = 0; i < 21; i += 1) {
      await responseHandlers[0](bodyResponse(`queue-${i}`));
    }
    await act(async () => {
      setAppReadyForDeepLink(true);
      await new Promise(resolve => setTimeout(resolve, 30));
    });

    function RestartedHarness() {
      useNotificationListeners(callback);
      return null;
    }
    create(React.createElement(RestartedHarness));
    await new Promise(resolve => setTimeout(resolve, 10));
    await act(async () => {
      setAppReadyForDeepLink(true);
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    expect(routed).toHaveLength(21);
    expect(new Set(routed).size).toBe(21);
    expect(routed).toEqual(Array.from({ length: 21 }, (_, i) => `queue-${i}`));
    expect(JSON.parse(consumedStorage || '[]')).toEqual(
      Array.from({ length: 21 }, (_, i) => `queue-${i}`),
    );
  });
});
