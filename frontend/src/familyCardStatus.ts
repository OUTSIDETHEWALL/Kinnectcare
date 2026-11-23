import { Member } from './api';
import { BatteryDisplay, getBatteryDisplay } from './batteryStatus';
import { DeviceCommunicationStatus, getDeviceCommunicationStatus } from './deviceStatus';
import { NeedsAttentionIssue } from './needsAttention';
import { selectPresenceTimestamp } from './timeFormat';
import { getGpsFreshness } from './gpsFreshness';

export type FamilyCardStatus = {
  device: DeviceCommunicationStatus;
  contactLabel: string | null;
  locationLabel: 'Location' | 'Last known location';
  locationAgeLabel: string | null;
  gpsWarning: string | null;
  battery: BatteryDisplay | null;
  hasActiveProblem: boolean;
  indicator: 'healthy' | 'warning' | 'danger' | 'unknown' | 'private';
};

const MAX_CLOCK_SKEW_MS = 5_000;

export function getFamilyCardStatus(
  member: Member,
  issues: NeedsAttentionIssue[] = [],
  nowMs: number = Date.now(),
): FamilyCardStatus {
  const devicePresenceAt = usableTimestamp(member.device_presence_at, nowMs);
  const lastSeen = usableTimestamp(member.last_seen, nowMs);
  const coordinateAt = usableTimestamp(member.coordinate_captured_at, nowMs);
  const batteryUpdatedAt = usableTimestamp(member.battery_updated_at, nowMs);
  const deviceMember = {
    device_presence_at: devicePresenceAt,
    last_seen: lastSeen,
    is_moving: member.is_moving,
  };
  const device = getDeviceCommunicationStatus(deviceMember, nowMs);
  const presenceTimestamp = selectPresenceTimestamp(deviceMember);
  const contactLabel = presenceTimestamp
    ? `Last contact ${formatContactAge(presenceTimestamp, nowMs)}`
    : null;
  const batteryIssue = issues.find((issue) => issue.kind === 'battery');
  const condition = batteryIssue?.title === 'Battery Critical'
    ? 'critical'
    : batteryIssue?.title === 'Battery Low'
      ? 'low'
      : null;
  const locationStatus = getGpsFreshness(coordinateAt, nowMs);
  // Keep existing prolonged-outage escalation; only the FIRST warning loses
  // its dependence on motion. Do not weaken an existing critical condition.
  const prolongedLocationFailure = getDeviceCommunicationStatus({
    device_presence_at: null, last_seen: coordinateAt, is_moving: member.is_moving,
  }, nowMs).kind === 'not-responding';
  const batteryFreshness = batteryUpdatedAt
    ? getDeviceCommunicationStatus({
        device_presence_at: null,
        last_seen: batteryUpdatedAt,
        is_moving: member.is_moving,
      }, nowMs)
    : null;

  // Overall warning may include GPS; the device badge uses device.kind alone.
  // Retain existing danger escalation. First GPS warning is fifteen minutes.
  const indicator: FamilyCardStatus['indicator'] = member.location_sharing_enabled === false ? 'private'
    : member.status === 'critical' || issues.some(issue => issue.severity === 'critical') || device.kind === 'not-responding'
      || prolongedLocationFailure ? 'danger'
    : member.status === 'warning' || issues.length > 0 || device.kind === 'delayed'
      || locationStatus.kind === 'stale' ? 'warning'
    : member.status !== 'healthy' || device.kind !== 'healthy' || locationStatus.kind !== 'fresh' ? 'unknown'
    : 'healthy';

  return {
    indicator,
    device,
    contactLabel,
    locationLabel: locationStatus.kind === 'fresh' ? 'Location' : 'Last known location',
    gpsWarning: member.location_sharing_enabled !== false && locationStatus.kind === 'stale'
      ? 'GPS location stale — last known location' : null,
    locationAgeLabel: coordinateAt
      ? `Last location captured ${formatContactAge(coordinateAt, nowMs)}`
      : 'Capture time unavailable',
    battery: getBatteryDisplay(
      member.battery_level,
      member.is_charging,
      batteryUpdatedAt,
      device.kind === 'healthy' && batteryFreshness?.kind === 'healthy' ? 'current' : 'last-known',
      condition,
      nowMs,
    ),
    hasActiveProblem: issues.length > 0
      || (member.location_sharing_enabled !== false && locationStatus.kind === 'stale'),
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