const mockStorage = new Map<string, string>();
const mockPost = jest.fn();
const mockDismiss = jest.fn();

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: (key: string) => Promise.resolve(mockStorage.get(key) ?? null),
  setItem: (key: string, value: string) => {
    mockStorage.set(key, value);
    return Promise.resolve();
  },
  removeItem: (key: string) => {
    mockStorage.delete(key);
    return Promise.resolve();
  },
  getAllKeys: () => Promise.resolve(Array.from(mockStorage.keys())),
  multiGet: (keys: string[]) => Promise.resolve(
    keys.map((key) => [key, mockStorage.get(key) ?? null] as [string, string | null]),
  ),
}));

jest.mock('../api', () => ({
  api: { post: (...args: any[]) => mockPost(...args) },
}));

jest.mock('expo-notifications', () => ({
  dismissNotificationAsync: (...args: any[]) => mockDismiss(...args),
}));

import {
  handleMedicationAction,
  acknowledgeMedicationOccurrence,
  PENDING_MEDICATION_ACK_PREFIX,
} from '../medicationAcknowledgment';

function response(actionIdentifier = 'TOOK_IT', reminderId = 'reminder-1', notificationId = 'notification-1') {
  return {
    actionIdentifier,
    notification: {
      request: {
        identifier: notificationId,
        content: {
          data: {
            type: 'medication',
            reminder_id: reminderId,
            member_id: 'member-1',
            slot_time: '14:00',
            local_date: '2026-09-12',
          },
        },
      },
    },
  };
}

describe('medication notification acknowledgment reliability', () => {
  beforeEach(() => {
    mockStorage.clear();
    mockPost.mockReset().mockResolvedValue({ status: 200 });
    mockDismiss.mockReset().mockResolvedValue(undefined);
  });

  it('persists the exact occurrence and dismisses only after backend success', async () => {
    await expect(handleMedicationAction(response())).resolves.toBe(true);
    expect(mockPost).toHaveBeenCalledWith('/reminders/reminder-1/mark', {
      status: 'taken',
      member_id: 'member-1',
      slot_time: '14:00',
      local_date: '2026-09-12',
      occurrence_id: expect.stringContaining('2026-09-12'),
    });
    expect(mockDismiss).toHaveBeenCalledWith('notification-1');
    expect(Array.from(mockStorage.keys()).some((key) => key.startsWith(PENDING_MEDICATION_ACK_PREFIX))).toBe(false);
  });

  it('accepts a TaskManager-style wrapped response and supports DONE', async () => {
    await expect(handleMedicationAction({ data: { response: response('DONE') } })).resolves.toBe(true);
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('keeps failed acknowledgments pending and retries exactly once later', async () => {
    mockPost.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ status: 200 });

    await expect(handleMedicationAction(response())).resolves.toBe(false);
    expect(Array.from(mockStorage.keys()).filter((key) => key.startsWith(PENDING_MEDICATION_ACK_PREFIX))).toHaveLength(1);
    expect(mockDismiss).not.toHaveBeenCalled();

    await expect(handleMedicationAction(response())).resolves.toBe(true);
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(mockDismiss).toHaveBeenCalledTimes(1);
    expect(Array.from(mockStorage.keys()).some((key) => key.startsWith(PENDING_MEDICATION_ACK_PREFIX))).toBe(false);
  });

  it('does not submit a completed occurrence again on duplicate delivery', async () => {
    await expect(handleMedicationAction(response())).resolves.toBe(true);
    await expect(handleMedicationAction(response())).resolves.toBe(true);
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('uses the legacy body and a separate deterministic key when occurrence metadata is incomplete', async () => {
    const legacy = response();
    delete (legacy.notification.request.content.data as any).local_date;
    await expect(handleMedicationAction(legacy)).resolves.toBe(true);
    expect(mockPost).toHaveBeenCalledWith('/reminders/reminder-1/mark', { status: 'taken' });
    expect(Array.from(mockStorage.keys()).some((key) => key.startsWith(PENDING_MEDICATION_ACK_PREFIX))).toBe(false);
  });

  it('keeps independent foreground/headless actions in separate storage keys', async () => {
    mockPost.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ status: 200 });
    await expect(handleMedicationAction(response('TOOK_IT', 'reminder-1', 'notification-1'))).resolves.toBe(false);
    await expect(handleMedicationAction(response('TOOK_IT', 'reminder-2', 'notification-2'))).resolves.toBe(true);
    const pendingKeys = Array.from(mockStorage.keys())
      .filter((key) => key.startsWith(PENDING_MEDICATION_ACK_PREFIX));
    expect(pendingKeys).toHaveLength(1);
    await expect(handleMedicationAction(response('TOOK_IT', 'reminder-1', 'notification-1'))).resolves.toBe(true);
    expect(Array.from(mockStorage.keys()).filter((key) => key.startsWith(PENDING_MEDICATION_ACK_PREFIX))).toHaveLength(0);
  });

  it('does not invoke the self-only endpoint for a family escalation', async () => {
    const family = response();
    (family.notification.request.content.data as any).subtype = 'family_alert';
    await expect(handleMedicationAction(family)).resolves.toBe(false);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('surfaces the HTTP conflict to the foreground without consuming its durable action', async () => {
    const conflict = { response: { status: 409, data: { detail: 'Escalation is in progress' } } };
    mockPost.mockRejectedValueOnce(conflict).mockResolvedValueOnce({ status: 200 });
    const data = response().notification.request.content.data;
    await expect(acknowledgeMedicationOccurrence(data)).rejects.toBe(conflict);
    expect(mockDismiss).not.toHaveBeenCalled();
    expect(Array.from(mockStorage.keys()).filter(key =>
      key.startsWith(PENDING_MEDICATION_ACK_PREFIX))).toHaveLength(1);
    await expect(acknowledgeMedicationOccurrence(data)).resolves.toBe(true);
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(Array.from(mockStorage.keys()).filter(key =>
      key.startsWith(PENDING_MEDICATION_ACK_PREFIX))).toHaveLength(0);
  });

  it('shares one in-flight request but preserves foreground errors and headless boolean results', async () => {
    let reject!: (error: unknown) => void;
    mockPost.mockImplementationOnce(() => new Promise((_resolve, rejectRequest) => {
      reject = rejectRequest;
    }));
    const headless = handleMedicationAction(response());
    // Allow storage preparation to reach the API call before the panel joins.
    for (let i = 0; i < 20 && !reject; i++) await Promise.resolve();
    const foreground = acknowledgeMedicationOccurrence(response().notification.request.content.data);
    const conflict = { response: { status: 409 } };
    const foregroundAssertion = expect(foreground).rejects.toBe(conflict);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    reject(conflict);
    await expect(headless).resolves.toBe(false);
    await foregroundAssertion;
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockDismiss).not.toHaveBeenCalled();
  });
});