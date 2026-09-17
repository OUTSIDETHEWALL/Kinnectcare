import { buildNeedsAttentionIssues } from '../needsAttention';
import { Alert, Member } from '../api';

const NOW = new Date('2026-09-17T12:00:00.000Z').getTime();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function member(id: string, overrides: Partial<Member> = {}): Member {
  return {
    id,
    user_id: `user-${id}`,
    name: `Member ${id}`,
    age: 70,
    phone: '',
    gender: '',
    role: 'senior',
    status: 'healthy',
    last_seen: ago(1),
    device_presence_at: ago(1),
    is_moving: false,
    battery_level: 0.19,
    battery_updated_at: ago(1),
    ...overrides,
  };
}

function batteryAlert(id: string, memberId: string, type: Alert['type']): Alert {
  return {
    id,
    member_id: memberId,
    member_name: `Member ${memberId}`,
    type,
    severity: 'warning',
    title: 'Battery',
    message: 'Battery issue',
    acknowledged: false,
    resolved: false,
    created_at: ago(1),
  };
}

const build = (members: Member[], activeAlerts: Alert[]) => buildNeedsAttentionIssues({
  members,
  activeAlerts,
  summary: [],
  missedMedicationDetails: [],
  nowMs: NOW,
});

describe('current Needs Attention issues', () => {
  it('does not infer an incident from a raw 21% reading', () => {
    expect(build([member('a', { battery_level: 0.21 })], [])).toEqual([]);
  });

  it('groups warning and critical rows into one escalated battery issue', () => {
    const issues = build(
      [member('a', { battery_level: 0.15 })],
      [
        batteryAlert('warning', 'a', 'low_battery_warning'),
        batteryAlert('critical', 'a', 'low_battery'),
      ],
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: 'battery', title: 'Battery Critical' });
  });

  it('counts separate members and automatically removes resolved incidents', () => {
    const members = [member('a'), member('b')];
    expect(build(members, [
      batteryAlert('a', 'a', 'low_battery_warning'),
      batteryAlert('b', 'b', 'low_battery_warning'),
    ])).toHaveLength(2);
    expect(build(members, [])).toHaveLength(0);
  });

  it('keeps an acknowledged battery condition active until recovery resolves it', () => {
    const alert = batteryAlert('a', 'a', 'low_battery_warning');
    alert.acknowledged = true;
    expect(build([member('a')], [alert])).toHaveLength(1);
    alert.resolved = true;
    expect(build([member('a')], [alert])).toHaveLength(0);
  });

  it('adds one issue for a prolonged communication outage and clears on resume', () => {
    expect(build([member('a', { device_presence_at: ago(241) })], []))
      .toEqual([expect.objectContaining({ kind: 'device', title: 'Device Not Responding' })]);
    expect(build([member('a', { device_presence_at: ago(1) })], [])).toEqual([]);
  });
});