# Phase 2 — refill reminder gap analysis (no implementation)

## Finding

There is **no complete refill-reminder workflow** in the active application.
Model/response fields and notification naming support are not proof that a
refill can be entered, scheduled or delivered. Confidence: high for inspected
source; no live data or physical delivery was queried or mutated.

| Question | Current result |
| --- | --- |
| Enter refill dates or remaining quantities? | No fields in current add/edit medication forms. No supported remaining-quantity inventory input found. |
| Persist refill data? | Reminder response model can preserve days_supply, refill_reminder_days, last_refill_at and run_out_at from an existing record. Normal create/update request models omit them, and writers do not calculate/persist them. New supported UI requests therefore do not establish a refill schedule. |
| Edit refill data? | No supported form or request-model fields; generic response typing is not write support. |
| Scheduled notifications? | No refill stage/worker or due-query in the active backend scheduler. |
| Delivered to intended recipient? | No refill notification generator, hence no demonstrated recipient/delivery path. |
| Survive app restart? | Legacy stored fields can remain, but no scheduled reminder workflow exists to recover. |
| Backend interruption/retry? | No refill delivery reservation, retry, deduplication or restart policy. |
| Dismiss/complete reminder? | Generic alert handling is not a refill completion lifecycle; no refill-generated incident exists. |
| Update after obtaining refill? | No supported refill event/mark-refilled operation to reset supply or revision. |
| Family notifications? | No refill fanout policy implemented; recipients cannot be inferred from medication dose escalation. |
| UI promise? | Main add/edit forms do not promise a complete refill workflow. Android medication channel description still mentions “refill reminders”; response types/comments and notification-ID helpers also suggest support that is not implemented. |

Evidence:
- `backend/server.py`: Reminder contains four optional supply/refill fields;
  ReminderCreate and ReminderUpdate omit them; create_reminder and
  update_reminder write name/dosage/times rather than refill state.
- `backend/med_scheduler.py`: only due/family_alert medication stages and
  routine due handling; no refill producer.
- `frontend/app/add-medication/[memberId].tsx` and
  `frontend/app/edit-medication/[reminderId].tsx`: input state and submitted
  payloads contain medication name, dosage and times.
- `frontend/src/api.ts`: optional refill response fields.
- `frontend/src/push.ts`: medication channel description and refill-aware
  stable notification naming. A naming branch is not scheduling/delivery.

Comments mentioning a seven-day default are dormant documentation, **not an
approved threshold or implemented product behavior**.

## Smallest reliable implementation recommendation

Prefer an explicit **date-based refill reminder** over automatic pill depletion
for a first implementation. A date does not require assumptions about dose
quantity, missed doses, PRN medication or refill stock. This is a recommendation,
not an approved product choice or an implemented change.

After approval:
- Add owner-authorized input/editing, timezone-aware validation and explicit
  reminder enable/disable/completion.
- Store the approved refill target/date and a refill-cycle identity/revision;
  retain existing optional fields without silently initializing old schedules.
- Use backend scheduling independent of the app, transactional incident/outbox
  creation, unique cycle-stage/device delivery ownership and safe retries.
- Revalidate current family access, preferences, settings revision and
  completion before reservation; never include location.
- Provide truthful state/history and “refilled”/next-date update behavior with
  authorized recipients and duplicate suppression.
- Test edits, disabled/removal/transfer, timezone/DST boundaries, restarts,
  concurrent workers, explicit failures and ambiguous provider outcomes.

If quantity-based calculation is chosen instead, scope increases: quantities,
units, consumption rules, missed/PRN doses, corrections and replenishment must
all be approved and validated. Do not derive medical adherence or pill depletion
from an unchecked assumed dosage string.

## Decisions requiring owner approval

1. Date-based reminder versus quantity/supply tracking and who enters it.
2. Date meaning/timezone, notification time, lead threshold, repeat policy and
   stale/recovery window. **No values are chosen here.**
3. Patient versus owner/designated caregivers/family recipients; quiet hours
   and escalation policy. Dose reminder recipients are not implicit authority.
4. Dismiss versus completed/refilled semantics and how a next cycle is entered.
5. Existing legacy records: retain inactive, validate/migrate, or explicitly
   opt into reminders; no silent notification activation.
6. Whether to remove the currently misleading channel description pending
   implementation or approve the actual feature separately.

Estimated scope: **medium** for explicit date-entry plus durable backend
reminders and completion; **large** for inventory/quantity-based tracking.
Needs frontend forms/types/states, backend request models/persistence/scheduler,
additive cycle/outbox indexes, comprehensive tests, independent review and
separately approved physical notification acceptance. A native change is not
inherently required for a date-based backend reminder, but final delivery
requirements depend on the approved actions/UI.

No refill fields, routes, reminders, thresholds or recipients were implemented
or changed in Phase 2.
