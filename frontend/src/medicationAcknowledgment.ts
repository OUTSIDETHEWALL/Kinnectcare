import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { api } from './api';

/**
 * Notification actions can arrive as a NotificationResponse or wrapped by
 * Expo TaskManager.  Both the live listener and the headless task use this
 * module so their persistence behavior stays identical.
 */
export const PENDING_MEDICATION_ACK_PREFIX =
  '@kinnship/pending_medication_acknowledgment_v2:';
export const COMPLETED_MEDICATION_ACK_PREFIX =
  '@kinnship/completed_medication_acknowledgment_v2:';

export type MedicationAcknowledgment = {
  actionIdentifier: string;
  notificationId?: string;
  reminder_id: string;
  member_id?: string;
  slot_time?: string;
  local_date?: string;
  occurrence_id?: string;
  queue_key: string;
  category?: string;
  data: Record<string, any>;
};

type PendingAcknowledgment = MedicationAcknowledgment;

export function unwrapNotificationResponse(input: any): any | null {
  if (!input) return null;
  if (typeof input.actionIdentifier === 'string') return input;
  if (input.response && typeof input.response.actionIdentifier === 'string') {
    return input.response;
  }
  if (input.data) return unwrapNotificationResponse(input.data);
  return null;
}

function nonEmptyString(value: any): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function canonicalOccurrenceId(
  reminderId: string,
  memberId: string,
  slotTime: string,
  localDate: string,
): string {
  return [reminderId, memberId, slotTime, localDate]
    .map((part) => `${part.length}:${part}`)
    .join('|');
}

function storageKey(prefix: string, queueKey: string): string {
  return `${prefix}${encodeURIComponent(queueKey)}`;
}

export function acknowledgmentFromResponse(input: any): MedicationAcknowledgment | null {
  const response = unwrapNotificationResponse(input);
  if (!response) return null;
  const actionIdentifier = response.actionIdentifier;
  if (actionIdentifier !== 'TOOK_IT' && actionIdentifier !== 'DONE') return null;

  const notification = response.notification;
  const data: Record<string, any> =
    (notification?.request?.content?.data as Record<string, any>) || {};
  const reminderId = nonEmptyString(data.reminder_id);
  if (!reminderId) return null;

  // Family escalation notifications are addressed to caregivers.  They must
  // never accidentally call the senior-only medication mark endpoint.
  const isFamilyAlert = data.subtype === 'family_alert' || data.stage === 'family_alert';
  if (isFamilyAlert || (data.type !== 'medication' && data.type !== 'routine')) return null;

  const memberId = nonEmptyString(data.member_id);
  const slotTime = nonEmptyString(data.slot_time) || nonEmptyString(data.scheduled_time);
  const localDate = nonEmptyString(data.local_date) || nonEmptyString(data.occurrence_date);
  const notificationId = nonEmptyString(notification?.request?.identifier);
  const hasOccurrenceMetadata = !!memberId && !!slotTime && !!localDate;
  const occurrenceId = hasOccurrenceMetadata
    ? nonEmptyString(data.occurrence_id)
      || canonicalOccurrenceId(reminderId, memberId!, slotTime!, localDate!)
    : undefined;

  // Legacy pushes did not carry enough information to safely identify a
  // scheduled occurrence.  Their queue key is deliberately separate from the
  // occurrence key, and their request uses the legacy endpoint body.
  const queueKey = hasOccurrenceMetadata
    ? `occurrence:${occurrenceId}`
    : `legacy:${reminderId}:${notificationId || 'no-notification'}:${actionIdentifier}`;

  return {
    actionIdentifier,
    notificationId,
    reminder_id: reminderId,
    member_id: memberId,
    slot_time: slotTime,
    local_date: localDate,
    occurrence_id: occurrenceId,
    queue_key: queueKey,
    category: data.type,
    data,
  };
}

async function readPending(queueKey: string): Promise<PendingAcknowledgment | null> {
  try {
    const raw = await AsyncStorage.getItem(storageKey(PENDING_MEDICATION_ACK_PREFIX, queueKey));
    if (!raw) return null;
    return JSON.parse(raw) as PendingAcknowledgment;
  } catch (_e) {
    return null;
  }
}

async function listPending(): Promise<PendingAcknowledgment[]> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const pendingKeys = keys.filter((key) => key.startsWith(PENDING_MEDICATION_ACK_PREFIX));
    const pairs = await AsyncStorage.multiGet(pendingKeys);
    return pairs.flatMap(([, raw]) => {
      if (!raw) return [];
      try {
        return [JSON.parse(raw) as PendingAcknowledgment];
      } catch (_e) {
        return [];
      }
    });
  } catch (_e) {
    return [];
  }
}

async function enqueuePending(item: PendingAcknowledgment): Promise<void> {
  // Each action has its own key.  A headless runtime cannot overwrite an
  // unrelated foreground action by serializing a whole queue document.
  await AsyncStorage.setItem(
    storageKey(PENDING_MEDICATION_ACK_PREFIX, item.queue_key),
    JSON.stringify(item),
  );
}

async function removePending(queueKey: string): Promise<void> {
  await AsyncStorage.removeItem(storageKey(PENDING_MEDICATION_ACK_PREFIX, queueKey));
}

async function isCompleted(queueKey: string): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(storageKey(COMPLETED_MEDICATION_ACK_PREFIX, queueKey))) === '1';
  } catch (_e) {
    return false;
  }
}

async function markCompleted(queueKey: string): Promise<void> {
  await AsyncStorage.setItem(storageKey(COMPLETED_MEDICATION_ACK_PREFIX, queueKey), '1');
}

const inFlight = new Map<string, Promise<boolean>>();

async function dismissAcknowledgment(item: PendingAcknowledgment): Promise<void> {
  if (!item.notificationId) return;
  try {
    await Notifications.dismissNotificationAsync(item.notificationId);
  } catch (_e) {
    // Dismissal is cosmetic. Persistence has already succeeded.
  }
}

async function processPending(item: PendingAcknowledgment): Promise<boolean> {
  const current = inFlight.get(item.queue_key);
  if (current) return current;

  const work = (async () => {
    try {
      if (await isCompleted(item.queue_key)) {
        await removePending(item.queue_key);
        await dismissAcknowledgment(item);
        return true;
      }

      const body = item.occurrence_id && item.member_id && item.slot_time && item.local_date
        ? {
            status: 'taken',
            member_id: item.member_id,
            slot_time: item.slot_time,
            local_date: item.local_date,
            occurrence_id: item.occurrence_id,
          }
        : { status: 'taken' };
      await api.post(`/reminders/${item.reminder_id}/mark`, body);
      await markCompleted(item.queue_key);
      await removePending(item.queue_key);
      await dismissAcknowledgment(item);
      return true;
    } catch (_e) {
      // Keep the per-action record durable and do not consume the response.
      return false;
    } finally {
      inFlight.delete(item.queue_key);
    }
  })();
  inFlight.set(item.queue_key, work);
  return work;
}

/**
 * Returns true only after backend confirmation. Callers may consume/dismiss
 * the native action only when this resolves true.
 */
export async function handleMedicationAction(input: any): Promise<boolean> {
  const item = acknowledgmentFromResponse(input);
  if (!item) return false;
  if (await isCompleted(item.queue_key)) {
    await dismissAcknowledgment(item);
    return true;
  }
  await enqueuePending(item);
  return processPending(item);
}

/** Used by the foreground acknowledge panel, preserving the same retry path. */
export async function acknowledgeMedicationOccurrence(data: Record<string, any>): Promise<boolean> {
  const response = {
    actionIdentifier: data.type === 'routine' ? 'DONE' : 'TOOK_IT',
    notification: {
      request: {
        identifier: data.notification_id,
        content: { data },
      },
    },
  };
  return handleMedicationAction(response);
}

/** Replay every durable action after authenticated startup. */
export async function replayPendingMedicationAcknowledgments(): Promise<void> {
  const pending = await listPending();
  for (const item of pending) {
    // A malformed/stale item must not prevent other independent actions from
    // being replayed.
    await processPending(item);
  }
}