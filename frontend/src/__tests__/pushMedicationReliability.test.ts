const mockDismiss = jest.fn();
const mockSchedule = jest.fn();

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
}));

import {
  notificationOccurrenceKey,
  rePresentSticky,
  shouldRePresentLocally,
  snoozeNotificationId,
  stableNotificationId,
} from '../push';

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

describe('medication and routine notification reliability', () => {
  beforeEach(() => {
    mockDismiss.mockReset().mockResolvedValue(undefined);
    mockSchedule.mockReset().mockResolvedValue('scheduled-id');
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
});