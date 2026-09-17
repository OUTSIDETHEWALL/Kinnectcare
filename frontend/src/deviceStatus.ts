import { Member } from './api';
import { selectPresenceTimestamp } from './timeFormat';

export type DeviceCommunicationKind = 'healthy' | 'delayed' | 'not-responding' | 'unknown';

export type DeviceCommunicationStatus = {
  kind: DeviceCommunicationKind;
  label: 'Tracking Healthy' | 'Update Delayed' | 'Device Not Responding' | 'Device Status Unknown';
  ageMs: number | null;
};

const MINUTE = 60 * 1000;

export function getDeviceCommunicationStatus(
  member: Pick<Member, 'device_presence_at' | 'last_seen' | 'is_moving'>,
  nowMs: number = Date.now(),
): DeviceCommunicationStatus {
  const timestamp = selectPresenceTimestamp(member);
  if (!timestamp) return { kind: 'unknown', label: 'Device Status Unknown', ageMs: null };

  const seenMs = new Date(timestamp).getTime();
  if (!Number.isFinite(seenMs)) {
    return { kind: 'unknown', label: 'Device Status Unknown', ageMs: null };
  }
  const ageMs = Math.max(0, nowMs - seenMs);

  const delayedAfter =
    member.is_moving === true ? 2 * MINUTE :
    member.is_moving === false ? 60 * MINUTE :
    10 * MINUTE;
  const notRespondingAfter =
    member.is_moving === true ? 5 * MINUTE :
    member.is_moving === false ? 240 * MINUTE :
    60 * MINUTE;

  if (ageMs > notRespondingAfter) {
    return { kind: 'not-responding', label: 'Device Not Responding', ageMs };
  }
  if (ageMs > delayedAfter) {
    return { kind: 'delayed', label: 'Update Delayed', ageMs };
  }
  return { kind: 'healthy', label: 'Tracking Healthy', ageMs };
}