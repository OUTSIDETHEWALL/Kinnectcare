# Phase 2A — medication midnight reliability

## Scope and cause

Base: verified GitHub main `0396e5b9b168699ca0e1baa7952b7afa08548a12`,
the merge of Phase 1 PR #196. Merge does not establish deployment.

**Critical safety reliability finding, high confidence:** the scheduler resolved
only today's dose. After midnight, a previous-day 23:50/23:59 dose became a
future tonight dose and its eligible family escalation was skipped.

The correction discovers yesterday only for medication family escalation aged
15–75 elapsed UTC minutes, using the existing window and original slot/date
identity. It adds no history scan, stage, recipient or timing. Initial due and
routine reminders are not replayed from yesterday.

Independent adversarial review also reproduced a pre-existing **High**, relevant
DST acknowledgment mismatch: at second-fold 01:02, a legacy acknowledgment of
first-fold 01:50 could target yesterday. The scheduler and legacy nearest-prior
resolver now consistently anchor a slot/date to fold 0 and compare instants in
UTC. An exact-identity acknowledgment control and a real canonical legacy
transition both verify no subsequent family escalation.

## Existing delivery semantics preserved

Occurrence claims, acknowledgment arbitration, family fences, unique stage/alert
indexes, provider completion evidence and recovery are unchanged. Safe pre-send
failures can recover; attempted/ambiguous sends remain explicitly unknown and
are **not** blindly resent. This preserves the approved no-duplicate policy,
not a guarantee of eventual delivery after an ambiguous provider result.

Notification explainability:
- Why: one established medication occurrence remains unacknowledged.
- Who: existing family-scoped recipient path; no new recipients.
- Visibility: existing medication channel and recipient preferences.
- When: existing T+15 through T+75 elapsed-minute family window.
- Once: existing exact occurrence claim, unique stage/alert and attempted-send
  markers; no new date generated at midnight.

## Verification

- Offline, socket-blocked medication suites: **86 passed, 1 failed**.
- Failure: unchanged `test_manual_miss_after_success_retains_terminal_ownership_through_recovery`
  calls `_arbitrate_manual_missed_occurrence` with an outdated signature.
  Reproduced with the verified-main scheduler loaded; not suppressed or repaired.
- New offline boundary tests: 23:50, 23:59, daytime, bounded window,
  acknowledgment, duplicate/concurrent scans, pre-send retry, unknown-send
  no-resend, routine preservation, timezone, DST, month/year rollover.
- Disposable loopback MongoDB replica set: **2 passed**, real unique indexes,
  family-fenced concurrent scans, persisted-state rescan and acknowledged
  previous-date suppression. No production connection or credentials used.
- Python compilation and `git diff --check` passed. No Python linter is
  configured/installed; no frontend changes, so TypeScript is not applicable.
- Independent review initially failed the DST acknowledgment case; closure
  review **PASS**, high confidence, no unresolved Critical/High findings.
  Reviewer independently ran **100 passed, 1 baseline failure**, including
  post-escalation acknowledgment coverage. Mongo execution was by the
  implementing agent, not the reviewer.
- Additional socket-blocked regressions: optional-location SOS **7 passed**;
  refresh authorization **8 passed, 21 skipped**; refresh trace consent
  **32 passed**. Skipped tests are not represented as passes.

## Limits and eventual release

Rescanning durable state models recovery but is not a physical phone test or an
OS process-death certification. Provider acceptance is not physical delivery.
Actual phone delivery/acknowledgment remains unverified. Unrelated baseline
failures and launch gates remain; this is not a full-repository green claim.

Backend-only correction: eventual separately approved Railway backend deployment
is required. No Android OTA, native AAB, new database migration, new index,
Railway configuration change, native dependency or permission is introduced.
Existing safety indexes remain startup prerequisites.

No SOS, GPS/background service, location privacy, onboarding, family, billing or
subscription implementation is modified. Neither draft may be merged or
released by the agent. Phase 3 and unapproved three-stage/refill behavior remain
out of scope.
