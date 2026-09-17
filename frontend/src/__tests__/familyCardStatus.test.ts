import { Member } from '../api';
import { getFamilyCardStatus } from '../familyCardStatus';
import { NeedsAttentionIssue } from '../needsAttention';

const NOW = new Date('2026-09-18T12:00:00.000Z').getTime();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function member(overrides: Partial<Member> = {}): Member {
  return {
    id: 'member-1',
    user_id: 'user-1',
    name: 'Member One',
    age: 72,
    phone: '',
    gender: '',
    role: 'senior',
    status: 'healthy',
    last_seen: ago(1),
    device_presence_at: ago(1),
    is_moving: false,
    battery_level: 0.82,
    battery_updated_at: ago(1),
    is_charging: false,
    location_name: 'Home',
    ...overrides,
  };
}

function issue(kind: 'battery' | 'device', title: string): NeedsAttentionIssue {
  return {
    id: `${kind}:member-1`,
    memberId: 'member-1',
    memberName: 'Member One',
    kind,
    severity: title.includes('Critical') ? 'critical' : 'medium',
    title,
    detail: '',
    action: '',
  };
}

describe('Family card caregiver presentation', () => {
  it('shows a healthy device with current battery and location', () => {
    expect(getFamilyCardStatus(member(), [], NOW)).toMatchObject({
      device: { label: 'Tracking Healthy' },
      contactLabel: 'Last update 1 min ago',
      locationLabel: 'Location',
      locationAgeLabel: 'Updated 1 min ago',
      battery: { statusText: 'Battery 82%' },
      hasActiveProblem: false,
    });
  });

  it('shows charging in plain English with the current percentage', () => {
    expect(getFamilyCardStatus(member({ battery_level: 0.43, is_charging: true }), [], NOW).battery)
      .toMatchObject({ statusText: 'Charging · 43%' });
  });

  it('uses the active Needs Attention incident for low and critical wording', () => {
    expect(getFamilyCardStatus(
      member({ battery_level: 0.19 }),
      [issue('battery', 'Battery Low')],
      NOW,
    ).battery).toMatchObject({ statusText: 'Battery Low · 19%' });

    expect(getFamilyCardStatus(
      member({ battery_level: 0.14 }),
      [issue('battery', 'Battery Critical')],
      NOW,
    ).battery).toMatchObject({ statusText: 'Battery Critical · 14%' });
  });

  it('keeps an active critical incident visible while the phone is charging', () => {
    expect(getFamilyCardStatus(
      member({ battery_level: 0.14, is_charging: true }),
      [issue('battery', 'Battery Critical')],
      NOW,
    ).battery).toMatchObject({
      statusText: 'Battery Critical · 14% · Charging',
      tone: 'low',
    });
  });

  it('labels delayed information as last known instead of current', () => {
    expect(getFamilyCardStatus(member({
      is_moving: true,
      device_presence_at: ago(3),
      battery_level: 0.72,
    }), [], NOW)).toMatchObject({
      device: { label: 'Update Delayed' },
      contactLabel: 'Last contact 3 min ago',
      locationLabel: 'Location',
      locationAgeLabel: 'Updated 1 min ago',
      battery: { statusText: 'Last known battery: 72%' },
    });
  });

  it('does not make an old GPS location current because another device signal is recent', () => {
    expect(getFamilyCardStatus(member({
      device_presence_at: ago(1),
      last_seen: ago(241),
    }), [], NOW)).toMatchObject({
      device: { label: 'Tracking Healthy' },
      contactLabel: 'Last update 1 min ago',
      locationLabel: 'Last known location',
      locationAgeLabel: 'Last location update 4 hrs ago',
    });
  });

  it('does not invent a low-battery incident from a percentage alone', () => {
    expect(getFamilyCardStatus(member({ battery_level: 0.19 }), [], NOW)).toMatchObject({
      battery: { statusText: 'Battery 19%', tone: 'ok' },
      hasActiveProblem: false,
    });
  });

  it('renders an old low reading neutrally when there is no active incident', () => {
    expect(getFamilyCardStatus(member({
      is_moving: true,
      device_presence_at: ago(6),
      battery_level: 0.19,
      battery_updated_at: ago(6),
    }), [issue('device', 'Device Not Responding')], NOW).battery).toMatchObject({
      statusText: 'Last known battery: 19%',
      tone: 'ok',
    });
  });

  it('labels an old battery sample last known even when device contact is healthy', () => {
    expect(getFamilyCardStatus(member({
      device_presence_at: ago(1),
      battery_level: 0.43,
      battery_updated_at: ago(241),
      is_charging: true,
    }), [], NOW).battery).toMatchObject({
      statusText: 'Last known battery: 43% · was charging',
      tone: 'ok',
    });
  });

  it('uses one clock and safely labels a future battery timestamp', () => {
    const future = new Date(NOW + 60_000).toISOString();
    expect(getFamilyCardStatus(member({
      battery_updated_at: future,
    }), [], NOW).battery).toMatchObject({
      statusText: 'Last known battery: 82%',
      ageLabel: 'Last update unknown',
    });
  });

  it('does not present future device or GPS timestamps as current', () => {
    const future = new Date(NOW + 60_000).toISOString();
    expect(getFamilyCardStatus(member({
      device_presence_at: future,
      last_seen: future,
    }), [], NOW)).toMatchObject({
      device: { label: 'Device Status Unknown' },
      contactLabel: null,
      locationLabel: 'Last known location',
      locationAgeLabel: null,
    });
  });

  it('keeps an unresolved critical incident prominent while marking its percentage last known', () => {
    expect(getFamilyCardStatus(
      member({ is_moving: true, device_presence_at: ago(6), battery_level: 0.14 }),
      [
        issue('device', 'Device Not Responding'),
        issue('battery', 'Battery Critical'),
      ],
      NOW,
    ).battery).toMatchObject({
      statusText: 'Battery Critical · last known 14%',
      tone: 'low',
    });
  });

  it('matches a prolonged outage issue and clears when communication resumes', () => {
    const outage = issue('device', 'Device Not Responding');
    const stopped = getFamilyCardStatus(member({ is_moving: true, device_presence_at: ago(6) }), [outage], NOW);
    expect(stopped.device.label).toBe('Device Not Responding');
    expect(stopped.hasActiveProblem).toBe(true);

    const resumed = getFamilyCardStatus(member({ is_moving: true, device_presence_at: ago(1) }), [], NOW);
    expect(resumed.device.label).toBe('Tracking Healthy');
    expect(resumed.hasActiveProblem).toBe(false);
  });

  it('keeps eight members independently readable with only current problems flagged', () => {
    const cards = Array.from({ length: 8 }, (_, index) => getFamilyCardStatus(
      member({ id: `member-${index}`, name: `Member ${index}`, battery_level: 0.8 - index * 0.05 }),
      index === 7 ? [issue('battery', 'Battery Low')] : [],
      NOW,
    ));
    expect(cards).toHaveLength(8);
    expect(cards.filter(card => card.hasActiveProblem)).toHaveLength(1);
    expect(cards.every(card => card.device.label === 'Tracking Healthy')).toBe(true);
  });

  it('highlights every current issue kind represented by Needs Attention', () => {
    const medication = {
      ...issue('device', 'Missed Medication'),
      kind: 'medication' as const,
    };
    expect(getFamilyCardStatus(member(), [medication], NOW).hasActiveProblem).toBe(true);
  });
});