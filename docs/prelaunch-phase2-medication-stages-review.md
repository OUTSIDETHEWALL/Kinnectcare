# Phase 2 — three-stage medication review (no implementation)

## Evidence and actual behavior

Reviewed active backend tree and current frontend source, plus the separately
reviewed midnight correction in draft PR #197. No new stage is implemented.

| Path | Actual timing | Actual recipient | Durable identity / limits |
| --- | --- | --- | --- |
| `due` | T+0, eligible through T+10; 15-second worker cadence | linked member's own account; otherwise member owner/reminder owner | Exact reminder/member/slot/local date; unique stage; initial send is best-effort, not durable provider-confirmed retry |
| `family_alert` | T+15, eligible through T+75 | existing whole-family fanout, not a newly designated escalation contact | Exact occurrence claim competes with Taken; durable alert, stage, ownership, provider evidence and recovery |
| User-selected snooze | Ten minutes after an explicit SNOOZE tap | local device only | Client-scheduled local notification with occurrence-scoped snooze ID; not an automatic server stage |
| Third automatic stage | **Absent** | **Not defined** | No registered offset, stale window, delivery policy or complete UI |
| Routines | T+0 self reminder only | existing self recipient | Deliberately no family medication escalation |

Sources:
- `backend/med_scheduler.py`: STAGE_OFFSETS_MIN, STAGE_MAX_STALE_MIN,
  process_pending_notifications, occurrence claim/stage/recovery helpers.
- `backend/server.py`: push_to_family_group, medication action/arbitration,
  Reminder/ReminderCreate/ReminderUpdate.
- `backend/medication_delivery.py`: provider completion evidence.
- `frontend/src/push.ts`: MEDICATION_DUE action category, SNOOZE_10,
  snoozeNotificationId and response listener.
- `frontend/src/medicationAcknowledgment.ts`: exact occurrence action identity,
  durable pending actions and suppression of caregiver-family action misuse.
- Add/edit medication screens: title, dosage and times, not stage configuration.

Snooze does not change the backend occurrence or postpone T+15 family escalation.
There is no basis to count it as a complete third reminder stage. Presence of
generic stage fields in payload/notification IDs is not implementation evidence.
No device delivery was tested in this investigation.

## Data-model capability and required work

The stage index includes a string stage key and can distinguish an additional
stage for the same occurrence without renumbering existing occurrences.
However, storing a new stage name alone is insufficient. The occurrence-level
family claim and terminal sent/unknown states currently model one family
escalation and must not be reused to swallow or duplicate another approved
stage. Additional family-facing behavior needs explicit stage-specific delivery
ownership while preserving the existing Taken-versus-send arbitration.

Backend scope after approval:
- Explicit stage offset, eligible window, suppression/recipient policy and
  restart/retry semantics.
- Per-stage/per-device delivery records, durable accepted/failed/unknown
  evidence, safe concurrency and provider/receipt observability.
- All stage decisions share original occurrence identity, current family
  authorization and acknowledgment outcome.
- Quiet hours, removed members, changed schedules, historical alert feeds and
  ambiguous sends require defined handling and regression tests.

Frontend scope after approval:
- Truthful description of the approved stages, timing and recipients.
- Optional settings only if the owner approves user-configurable behavior.
- Correct routing/actions/history labels and snooze wording that does not
  imply family escalation was delayed.

Existing medication schedules do not inherently require a destructive migration:
preserve their times and exact occurrence IDs. Any rollout needs an explicit
effective date/version so the additional stage is not retroactively applied to
old occurrences. Backfill/default configuration is a product decision, not an
assumption. Existing native notification actions may be reusable; a native
change/AAB cannot be determined until the approved interaction design is known.

## Recommended minimal design — approval required

Keep the current patient T+0 and existing family T+15 stages unchanged.
Represent one additional stage as a separate explicit occurrence stage, not
a reused snooze and not a new dose. **Its timing and recipients remain unset.**
Choose its position and policy with the owner before implementation; preserving
current T+15 is the default constraint, not authorization to invent an offset.

All automatic stages should have one durable delivery owner and suppress
remaining unsent stages after successful acknowledgment. Preserve sent history,
allow approved late Taken behavior, and never claim physical receipt from
provider acceptance. Prefer recovering known-unsent work over resending an
ambiguous notification.

Owner decisions:
1. Purpose, position, offset and eligible window of the additional stage.
2. Patient, designated caregiver, whole family or another explicitly approved
   recipient set; whether any existing recipient policy should change.
3. Interaction with snooze, quiet hours, Taken, explicit missed marks and
   provider-failed/unknown outcomes.
4. Fixed versus configurable policy, schedule rollout/effective date, opt-in,
   and whether existing schedules should receive it.
5. Required physical-device acceptance and whether configuration/UI promises
   should be withheld until that acceptance.

Estimated implementation scope: **medium-to-large**, cross-backend delivery
state and frontend explanation/actions/settings, deterministic concurrency/DST
tests, independent review and separately authorized physical acceptance.
This is not a trivial third timer. Exact effort depends on the decisions above.

The existing best-effort initial reminder's lack of durable provider retry is
a reliability limitation, not corrected by the midnight fix. It should be
included in any approved stage-delivery redesign, not silently represented as
already reliable.
