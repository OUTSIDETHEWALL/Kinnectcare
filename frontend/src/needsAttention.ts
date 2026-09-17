import { Alert, Member, MemberSummary, MissedMedicationDetail } from './api';
import { getDeviceCommunicationStatus } from './deviceStatus';

export type NeedsAttentionSeverity = 'medium' | 'critical';
export type NeedsAttentionIssueKind = 'battery' | 'device' | 'sos' | 'medication' | 'check-in';

export type NeedsAttentionIssue = {
  id: string;
  memberId: string;
  memberName: string;
  kind: NeedsAttentionIssueKind;
  severity: NeedsAttentionSeverity;
  title: string;
  detail: string;
  action: string;
};

type ActiveEmergency = { id: string; member_id: string; member_name: string } | null | undefined;

function percent(level?: number | null): number | null {
  return level == null ? null : Math.round(level * 100);
}

export function buildNeedsAttentionIssues({
  members,
  summary,
  missedMedicationDetails,
  activeAlerts,
  activeEmergency,
  nowMs = Date.now(),
}: {
  members: Member[];
  summary: MemberSummary[];
  missedMedicationDetails: MissedMedicationDetail[];
  activeAlerts: Alert[];
  activeEmergency?: ActiveEmergency;
  nowMs?: number;
}): NeedsAttentionIssue[] {
  const issues: NeedsAttentionIssue[] = [];
  const summaries = new Map(summary.map((row) => [row.member_id, row]));
  const membersById = new Map(members.map((member) => [member.id, member]));

  if (activeEmergency) {
    issues.push({
      id: `sos:${activeEmergency.id}`,
      memberId: activeEmergency.member_id,
      memberName: activeEmergency.member_name,
      kind: 'sos',
      severity: 'critical',
      title: 'Active SOS',
      detail: 'An emergency alert is still active.',
      action: 'Open the emergency alert for details.',
    });
  }

  const batteryAlerts = new Map<string, Alert>();
  for (const alert of activeAlerts) {
    if (
      (alert.type === 'low_battery' || alert.type === 'low_battery_warning') &&
      !alert.resolved
    ) {
      const existing = batteryAlerts.get(alert.member_id);
      if (
        !existing ||
        alert.battery_stage === 'critical' ||
        (alert.type === 'low_battery' && existing.type === 'low_battery_warning')
      ) {
        batteryAlerts.set(alert.member_id, alert);
      }
    }
  }

  for (const member of members) {
    const alert = batteryAlerts.get(member.id);
    if (alert) {
      const batteryPercent = percent(member.battery_level);
      const critical = alert.battery_stage === 'critical' || (
        alert.battery_stage == null &&
        alert.type === 'low_battery' &&
        /critical/i.test(`${alert.title} ${alert.message}`)
      ) || (
        batteryPercent !== null && batteryPercent <= 15
      );
      issues.push({
        id: `battery:${member.id}`,
        memberId: member.id,
        memberName: member.name,
        kind: 'battery',
        severity: critical ? 'critical' : 'medium',
        title: critical ? 'Battery Critical' : 'Battery Low',
        detail: batteryPercent === null
          ? 'The last reported battery level was low.'
          : `Last reported battery: ${batteryPercent}%`,
        action: critical
          ? `${member.name}'s phone should be charged as soon as possible.`
          : `${member.name}'s phone should be charged soon.`,
      });
    }

    if (member.user_id) {
      const device = getDeviceCommunicationStatus(member, nowMs);
      if (device.kind === 'not-responding') {
        issues.push({
          id: `device:${member.id}`,
          memberId: member.id,
          memberName: member.name,
          kind: 'device',
          severity: 'medium',
          title: 'Device Not Responding',
          detail: 'Kinnship has not received expected communication from this device.',
          action: 'Check that the phone is powered on and can connect to the internet.',
        });
      }
    }
  }

  for (const detail of missedMedicationDetails) {
    issues.push({
      id: `medication:${detail.alert_id || `${detail.member_id}:${detail.missed_at || detail.scheduled_time}`}`,
      memberId: detail.member_id,
      memberName: detail.member_name,
      kind: 'medication',
      severity: 'medium',
      title: 'Missed Medication',
      detail: detail.medication_name
        ? `${detail.medication_name}${detail.dosage ? ` — ${detail.dosage}` : ''}`
        : detail.description || 'Medication details unavailable.',
      action: 'Review the missed medication details.',
    });
  }

  for (const member of members) {
    if (member.role !== 'senior') continue;
    const row = summaries.get(member.id);
    if (
      row &&
      (member.daily_checkin_time || member.checkin_interval_hours) &&
      !row.checked_in_today
    ) {
      issues.push({
        id: `check-in:${member.id}`,
        memberId: member.id,
        memberName: member.name,
        kind: 'check-in',
        severity: 'medium',
        title: 'Check-in Missed',
        detail: 'The scheduled check-in has not been completed.',
        action: `Check in with ${member.name}.`,
      });
    }
  }

  // Include an active battery alert even if a stale legacy member row is absent.
  for (const [memberId, alert] of batteryAlerts) {
    if (membersById.has(memberId)) continue;
    issues.push({
      id: `battery:${memberId}`,
      memberId,
      memberName: alert.member_name,
      kind: 'battery',
      severity: alert.battery_stage === 'critical' ? 'critical' : 'medium',
      title: alert.battery_stage === 'critical' ? 'Battery Critical' : 'Battery Low',
      detail: alert.message,
      action: `${alert.member_name}'s phone should be charged.`,
    });
  }

  return issues;
}