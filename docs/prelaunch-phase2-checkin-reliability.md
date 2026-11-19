# Phase 2B — independent missed check-in detection

## Root cause and correction

Verified base: main `0396e5b9b168699ca0e1baa7952b7afa08548a12`. This branch
does not include unmerged medication PR #197.

**Critical safety notification reliability, high confidence:** detection was
invoked by GET alerts/summary. With no client requests, no warning was created.
After insertion, failed notification fanout had no durable retry ownership.

The startup-owned asyncio worker uses the existing background scheduling pattern,
not a client timer, external queue, or new service. Each cycle evaluates one
latest matured window per configured member; it does not enumerate historical
days. Retained read-triggered discovery uses the same coordinated path and
does not independently send.

Existing fixed/interval settings, 15-minute grace and 24-hour new-member grace
are retained. Fixed schedules use the linked patient's timezone, or the owner
for an unlinked dependent, never the polling caregiver's timezone. UTC instants
handle elapsed intervals and DST. Latest previous-day discovery recovers
midnight deadlines without an unbounded history scan.

Actual check-in records suppress both on-time and already-saved late completion.
Alerts remain family-scoped missed_checkin records and member warning status
continues to feed existing history/dashboard readers. Neither alert nor
delivery copies location.

## Coordination, delivery and recovery

- Alert and per-device outbox creation commit together under existing family
  transaction fences. Existing unique alert slot identity prevents duplicates.
- Existing legacy alerts are never replayed: their original push may already
  have been delivered.
- Tokens are deduplicated across the family's current recipients. Outbox records
  store hashes, not raw push tokens; current registration is checked at send.
- Reservation rechecks current family/subject/owner/recipient authorization,
  enabled settings and revision, check-in completion, alert acknowledgment and
  quiet hours. External sends are outside retryable transactions.
- A conditional ownership transition allows only one worker to attempt a device.
  Accepted ticket evidence is saved per device; accepted devices are never
  included in another recipient's retry.
- Explicit provider 429 or MessageRateExceeded rejection retries after the
  technical worker cadence. Timeout/exception/ambiguous acceptance becomes
  terminal unknown, not successful delivery and not a blind resend.
- A process crash before reservation leaves pending work recoverable. Stale
  attempted reservations become unknown after two minutes. Deleted-family
  queues terminate. No uncertain external send is re-executed.
- One-minute cadence, batched current-member reads and at most 500 ready-device
  deliveries per cycle bound each delivery batch. Backpressure/outage can delay
  completion; this is not an exact-deadline or eventual-delivery guarantee.

Both schedule-writing routes share the reservation fence, fresh owner/self
authorization and additive generation/effective-time metadata. New settings
cannot manufacture yesterday's overdue occurrence; disabling/re-enabling cannot
revive an old queued revision. No existing schedules are rewritten.

## Independent adversarial review

Initial **FAIL**, two High findings: retroactive fixed-schedule activation and
inconsistent/unfenced revisions across supported settings routes.
Both corrected with actual-route and barrier-controlled transaction tests.

Closure **PASS**, no unresolved Critical/High findings, high confidence in
closure. Reviewer independently exercised offline activation, revision,
supported-interval grace, new-member, DST and calendar calculations. Reviewer
inspected the real-Mongo tests but could not execute them because its read-only
shell blocked disposable log creation. Do not attribute the implementer's
Mongo execution to the reviewer.

## Verification

- **40 passed** against an owned loopback MongoDB replica set; synthetic data
  and stubbed provider only; external socket connections blocked.
- Includes actual worker-loop execution with no API requests, a fresh Python
  process consuming persisted outbox state and another fresh process proving
  deduplication, concurrent workers/read discovery, per-ticket/429 retry,
  unknown/crash handling, authorized recipient exclusion, quiet hours,
  token changes, disable/removal, both real settings routes, schedule revisions,
  patient timezones, DST and midnight/month/year boundaries.
- Relevant existing privacy/permission suites: **34 passed, 32 failed**.
  Verified main source reproduces the identical failures: 23 consent-fixture,
  six history-fixture and three role/permission-fixture tests lack a
  transaction-capable storage fixture. Not fixed, hidden or reclassified as
  passing by this work.
- Optional-location SOS regression: **7 passed** with sockets blocked.
- Focused real Mongo family-fence regression: **6 passed, 26 deselected**,
  covering acknowledgment rollback, transfer-first writer reauthorization and
  dependent deletion. This was not a full family suite run.
- Python compilation and whitespace checks passed. No installed/configured
  Python linter; no frontend code changed, so TypeScript is not applicable.
- No physical push display, phone acceptance or production test was performed.

## Railway topology — read-only observation

On 2026-11-19, live Railway inspection identified zonal-freedom / Kinnectcare
as online, source root backend, one running sfo replica, repository main source,
no cron. Repository start command specifies one Uvicorn worker. Active deployment
was `94ab0505-10bf-44f7-81a2-d70ab27aace1`, newer than the assignment's last
confirmed deployment. This is topology evidence, not a physical acceptance
certification of Phase 1. The other two same-repository projects were offline
with no active deployments. Existing staged work was left untouched.

Database coordination nevertheless supports overlapping workers/replicas.
No Railway configuration changes or new infrastructure are needed.

## Eventual release and limits

Requires separately approved backend deployment, existing Mongo transaction
support and successful startup index creation. Adds checkin_deliveries and
additive member revision metadata; startup ensures the existing unique alert
index plus delivery-readiness/check-in-evidence indexes. No production database
operation, backfill or destructive migration has been run. Review/apply index
requirements only as part of an approved backend rollout; index failure prevents
startup instead of running a race-unsafe worker.

No Android OTA, new native AAB, permission or native dependency is required by
this backend correction. Broader public-release AAB gates remain separate.
No SOS/GPS/location privacy/onboarding/family-transfer/billing implementation
was modified. Both PRs remain drafts; no agent merge or release is authorized.

Notification explainability: missed authoritative window is the cause; currently
authorized registered family devices are the recipients; existing quiet-hour
policy governs visibility; deadline/grace and worker cadence explain timing;
unique slot, atomic per-device ownership and saved acceptance/unknown state
explain why a device is not knowingly notified twice.
