import { medicationSelfDueRoute } from '../medicationNotificationRoute';

describe('medication notification RootNav route', () => {
  it('routes self_due body taps to the acknowledge modal with exact occurrence params', () => {
    expect(medicationSelfDueRoute({
      type: 'medication',
      subtype: 'self_due',
      reminder_id: 'aspirin-reminder',
      title: 'Aspirin',
      dosage: '81 mg',
      member_name: 'Joyce',
      member_id: 'joyce-member',
      slot_time: '14:00',
      local_date: '2026-09-16',
      occurrence_id: 'occurrence-aspirin-1400',
      notification_id: 'notification-1',
    })).toEqual({
      pathname: '/(modals)/acknowledge',
      params: {
        type: 'medication',
        reminder_id: 'aspirin-reminder',
        title: 'Aspirin',
        dosage: '81 mg',
        member_name: 'Joyce',
        stage: '',
        member_id: 'joyce-member',
        slot_time: '14:00',
        local_date: '2026-09-16',
        occurrence_id: 'occurrence-aspirin-1400',
        notification_id: 'notification-1',
      },
    });
  });

  it('does not route family alerts through the self_due destination', () => {
    expect(medicationSelfDueRoute({
      type: 'medication',
      subtype: 'family_alert',
      reminder_id: 'aspirin-reminder',
      occurrence_id: 'occurrence-aspirin-1400',
    })).toBeNull();
  });
});