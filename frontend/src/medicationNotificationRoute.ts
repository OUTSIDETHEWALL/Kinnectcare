export type MedicationSelfDueRoute = {
  pathname: '/(modals)/acknowledge';
  params: {
    type: 'medication';
    reminder_id: string;
    title: string;
    dosage: string;
    member_name: string;
    stage: string;
    member_id: string;
    slot_time: string;
    local_date: string;
    occurrence_id: string;
    notification_id: string;
  };
};

/**
 * Build the exact RootNav destination for a medication body tap.
 *
 * Keep this decision separate from the notification listener lifecycle: the
 * listener queues the payload, while RootNav owns navigation once its gates
 * are clear.  Returning null is intentional for family alerts and unrelated
 * notification types, which have different caregiver actions.
 */
export function medicationSelfDueRoute(data: any): MedicationSelfDueRoute | null {
  if (data?.type !== 'medication') return null;
  if (data?.subtype && data.subtype !== 'self_due') return null;

  return {
    pathname: '/(modals)/acknowledge',
    params: {
      type: 'medication',
      reminder_id: data?.reminder_id || '',
      title: data?.title || '',
      dosage: data?.dosage || '',
      member_name: data?.member_name || '',
      stage: data?.stage || '',
      member_id: data?.member_id || '',
      slot_time: data?.slot_time || '',
      local_date: data?.local_date || data?.occurrence_date || '',
      occurrence_id: data?.occurrence_id || '',
      notification_id: data?.notification_id || '',
    },
  };
}