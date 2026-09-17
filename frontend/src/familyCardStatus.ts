import { Member } from './api';
import { BatteryDisplay, getBatteryDisplay } from './batteryStatus';
import { DeviceCommunicationStatus, getDeviceCommunicationStatus } from './deviceStatus';
import { NeedsAttentionIssue } from './needsAttention';
import { selectPresenceTimestamp } from './timeFormat';

export type FamilyCardStatus = {
  device: DeviceCommunicationStatus;
  contactLabel: string | null;
  locationLabel: 'Location' | 'Last known location';
  locationAgeLabel: string | null;
  battery: BatteryDisplay | null;
  hasActiveProblem: boolean;
};

const MAX_CLOCK_SKEW_MS = 5_000;

export function getFamilyCardStatus(
  member: Member,
  issues: NeedsAttentionIssue[] = [],
  nowMs: number = Date.now(),
): FamilyCardStatus {
  const devicePresenceAt = usableTimestamp(member.device_presence_at, nowMs);
  const lastSeen = usableTimestamp(member.last_seen, nowMs);
  const batteryUpdatedAt = usableTimestamp(member.battery_updated_at, nowMs);
  const deviceMember = {
    device_presence_at: devicePresenceAt,
    last_seen: lastSeen,
    is_moving: member.is_moving,
  };
  const device = getDeviceCommunicationStatus(deviceMember, nowMs);
  const presenceTimestamp = selectPresenceTimestamp(deviceMember);
  const contactLabel = presenceTimestamp
    ? `${device.kind === 'healthy' ? 'Last update' : 'Last contact'} ${formatContactAge(presenceTimestamp, nowMs)}`
    : null;
  const batteryIssue = issues.find((issue) => issue.kind === 'battery');
  const condition = batteryIssue?.title === 'Battery Critical'
    ? 'critical'
    : batteryIssue?.title === 'Battery Low'
      ? 'low'
      : null;
  const locationStatus = getDeviceCommunicationStatus({
    device_presence_at: null,
    last_seen: lastSeen,
    is_moving: member.is_moving,
  }, nowMs);
  const batteryFreshness = batteryUpdatedAt
    ? getDeviceCommunicationStatus({
        device_presence_at: null,
        last_seen: batteryUpdatedAt,
        is_moving: member.is_moving,
      }, nowMs)
    : null;

  return {
    device,
    contactLabel,
    locationLabel: locationStatus.kind === 'healthy' ? 'Location' : 'Last known location',
    locationAgeLabel: lastSeen
      ? `${locationStatus.kind === 'healthy' ? 'Updated' : 'Last location update'} ${formatContactAge(lastSeen, nowMs)}`
      : null,
    battery: getBatteryDisplay(
      member.battery_level,
      member.is_charging,
      batteryUpdatedAt,
      device.kind === 'healthy' && batteryFreshness?.kind === 'healthy' ? 'current' : 'last-known',
      condition,
      nowMs,
    ),
    hasActiveProblem: issues.length > 0,
  };
}

function usableTimestamp(timestamp: string | null | undefined, nowMs: number): string | null {
  if (!timestamp) return null;
  const parsed = new Date(timestamp).getTime();
  if (!Number.isFinite(parsed) || parsed > nowMs + MAX_CLOCK_SKEW_MS) return null;
  return timestamp;
}

function formatContactAge(timestamp: string, nowMs: number): string {
  const ageMs = Math.max(0, nowMs - new Date(timestamp).getTime());
  const minutes = Math.max(1, Math.round(ageMs / 60_000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hr${hours === 1 ? '' : 's'} ago`;
}