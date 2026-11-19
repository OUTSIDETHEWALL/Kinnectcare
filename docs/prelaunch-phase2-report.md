# Phase 2 final report

## Baseline, delivery and authorization

Verified GitHub main and PR #196 merge: `0396e5b9b168699ca0e1baa7952b7afa08548a12`.
Both Phase 2 branches start separately from that main, not from one another.
Existing retention draft #190 was not modified.

- [Draft PR A #197 — medication midnight escalation](https://github.com/OUTSIDETHEWALL/Kinnectcare/pull/197)
  — branch fix/medication-midnight-escalation.
- [Draft PR B #198 — independent missed check-ins](https://github.com/OUTSIDETHEWALL/Kinnectcare/pull/198)
  — branch fix/independent-missed-checkins.

Both implementation reviews passed with no unresolved Critical/High findings
in the affected changes. Neither PR was merged or deployed by the agent.

## A. Medication midnight fix

Root cause: current-day-only slot resolution interpreted yesterday's late-night
dose as tonight's future occurrence after midnight and skipped it.

Implementation: recover previous-day medication slots only within the existing
inclusive 15–75-minute family window; keep original local date and identity.
Do not replay prior-day initial reminders or routines. Preserve existing
acknowledgment arbitration, alerts, ownership, recipients and retry behavior.

Independent review first found a relevant pre-existing High DST acknowledgment
mismatch. Aligning first-fold anchoring and UTC nearest-prior comparisons fixed
successful legacy acknowledgments incorrectly selecting yesterday. Actual
canonical legacy/exact taken transitions now suppress the subsequent escalation.
Re-review: **PASS**, high confidence.

Evidence:
- Implementer offline medication checks: **86 passed, 1 baseline failure**.
- Reviewer independent offline checks: **100 passed, 1 same baseline failure**.
- Real loopback Mongo coordination: **2 passed**; reviewer inspected but did not
  run this integration suite.
- Detailed tests and limits: `docs/prelaunch-phase2-medication-midnight.md`.

Ambiguous attempted sends retain existing unknown/no-resend semantics. Initial
due reminders remain best-effort; this narrow fix does not redesign all
medication-stage delivery or certify physical phone receipt.

## B. Independent missed check-in fix

Root cause: detection depended on GET alerts/summary. Once an alert was
inserted, fanout failure lacked durable recovery.

Implementation: startup-owned minute-cadence asyncio worker evaluates the latest
matured fixed/interval window for configured members, without client activity.
Atomic family-fenced alert/outbox creation and per-device conditional ownership
coordinate concurrent workers. Accepted devices are never replayed for another
device's failure. Explicit provider rejection retries; uncertain attempts become
unknown instead of being blindly resent.

Eligibility uses authoritative check-in records, current subject/recipient
membership, linked patient timezone, enabled settings/revision/effective time,
acknowledgment and quiet hours. Existing 15-minute deadline grace and 24-hour
new-member grace remain. No location is copied to delivery or alert payloads.

Independent review initially found two High issues: retroactive newly activated
fixed schedules and inconsistent/unfenced schedule writers. Both supported
writers now share generation/effective-time updates and the reservation fence.
Actual-route tests and a controlled concurrent disable/reservation test close
both. Re-review: **PASS**, no unresolved Critical/High.

Evidence:
- **40 real loopback Mongo tests passed**, including no-app worker execution,
  actual fresh-Python-process outbox recovery/deduplication, concurrent workers,
  restart/unknown behavior, explicit failure retry, unauthorized exclusion,
  disabled/removed members, both settings routes, timezones, DST and calendar
  boundaries.
- Reviewer independently ran offline boundary/lifetime checks; its read-only
  shell prevented running the real-Mongo suite. The 40 passes are implementer
  evidence, not independently reproduced integration results.
- Real family-fence regression: **6 passed, 26 deselected**.
- Detailed design/evidence: `docs/prelaunch-phase2-checkin-reliability.md`.

Read-only Railway inspection confirmed one online backend-root service/replica
and repository configuration for one Uvicorn worker. Two other same-repository
projects were offline. Coordination does not rely on only one replica.
No new infrastructure or Railway configuration changes are required.

## C. Three-stage medication review

Two automatic stages exist: T+0 patient/self (eligible through T+10) and
T+15 whole-family escalation (eligible through T+75). A user-triggered local
ten-minute snooze is not a third automatic stage and does not postpone the
backend family stage.

Recommend preserving existing stages and adding a separately owned occurrence
stage only after approval. Its interval, position, recipients, quiet-hour/snooze/
acknowledgment semantics and rollout policy remain unset. The string stage key
can represent another stage, but one current family claim is not a complete
multi-stage delivery design. Backend delivery ownership plus frontend
explanation/actions/settings would be medium-to-large scope; no destructive
schedule migration is inherently needed, but rollout versioning is.

Full evidence, design and owner decisions:
`docs/prelaunch-phase2-medication-stages-review.md`.

## D. Refill review

Optional refill response fields exist, but current add/edit inputs, request
models, persistence writers, scheduler, retry/recovery and refill completion
workflow do not implement a usable refill reminder. Android channel wording
still mentions refills; a notification-name helper is not a producer.

Recommend a minimal explicit date-based reminder before considering inventory
math. No lead threshold, delivery time, repeat cadence, recipients, family
escalation or completion policy is chosen. Owner approval is required for those
decisions and legacy-data activation. Estimated medium scope for date-based
entry/durable scheduling/completion; large scope for quantity-based inventory.

Full evidence and decisions: `docs/prelaunch-phase2-refill-review.md`.
**No third-stage or refill product behavior was implemented.**

## E. Regressions and honest limitations

| Check | Observed result |
| --- | --- |
| Medication offline checks, implementer | 86 passed, 1 unchanged baseline failure |
| Medication independent offline review checks | 100 passed, 1 same baseline failure; overlaps implementer coverage |
| Medication real Mongo | 2 passed |
| Check-in real Mongo | 40 passed |
| Focused real family-fence regression | 6 passed, 26 deselected |
| Existing check-in consent fixture suite | 2 passed, 23 failed unchanged |
| Existing check-in history fixture suite | 32 passed, 6 failed unchanged |
| Existing family-role fixture suite | 3 failed unchanged |
| Optional-location SOS | 7 passed on each implementation; overlapping coverage |
| Medication branch refresh authorization | 8 passed, 21 skipped |
| Medication branch refresh trace consent | 32 passed |
| Python compilation / whitespace | Passed |
| Python lint | No installed/configured lint tool; not claimed as run |
| TypeScript/frontend tests | Not rerun: no frontend changes |

Medication failure is an outdated test call missing a required argument.
All 32 privacy/permission fixture failures reproduce with verified-main source
and lack transaction-capable test storage. They remain unresolved; no tests were
deleted or assertions weakened. Previously reported whole-frontend baseline
failures remain a separate Phase 5 gate, not a current passing claim.

No SOS activation/cancel/create/confirmation/dialer/routing/acknowledgment/
resolution/location fallback/consent code, GPS/background/motion/stationary
services, location publication/privacy rules, onboarding, invitations,
family-transfer or billing implementation was changed. Shared server changes
are limited to medication legacy occurrence resolution (PR A) and check-in
worker/lifecycle/settings/discovery (PR B).

No physical notification receipt or signed-in phone UI was certified. Real
Mongo tests use synthetic disposable databases and stubbed provider calls with
unintended external sockets blocked. Unknown sends intentionally do not promise
eventual delivery or exactly-once physical presentation.
Web preview smoke capture reached the existing Important Notice gate without
a crash; it did not verify signed-in screens or Android behavior.

## F. Eventual release requirements

| Requirement | PR A | PR B |
| --- | --- | --- |
| Approved Railway backend deployment | Required | Required |
| Android OTA for these corrections | No | No |
| New native AAB for these corrections | No | No |
| Database change | Existing indexes only; no new migration | Additive outbox/revision metadata and startup indexes; no destructive migration/backfill |
| Railway configuration/new service | No | No |

PR B requires Mongo transactions and successful unique-alert/delivery/evidence
index creation; startup fails rather than running without coordination.
These operations have **not** been applied to production. The wider final
public-release AAB requirement remains, including Phase 1's embedded client fix.

Latest Railway topology observation was newer than the assignment's last
confirmed deployment. That observation is not certification that Phase 1's
physical acceptance passed. No agent deployment occurred.

## G. Remaining launch gates and stop

1. Owner review and merge of both Phase 2 drafts, followed by separately
   authorized backend rollout/index readiness and physical notification tests.
2. Phase 1 SOS/dialer/client delivery and physical acceptance remain uncertified.
3. Owner decisions on intended third-stage and refill scope; no implementation
   may start without approval.
4. Phase 3 family/account deletion/SOS retention review, including untouched
   draft #190 and actual retention/index behavior.
5. Phase 4 Google Play Billing architecture/implementation.
6. Phase 5 security triage and automated test remediation.
7. Phase 6 final approved AAB and Google Play/physical verification.

Tracker updated: `docs/prelaunch-phase1-sos-remediation.md`.
**STOPPED after Phase 2.** No merges, Railway deployments/config changes, OTA,
AAB, production database changes, live pushes/calls, subscription changes or
Phase 3 work were performed by the agent.
