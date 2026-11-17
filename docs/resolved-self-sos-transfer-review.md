# Resolved self-SOS transfer correction — draft, NOT CLEAN

## Current retention policy — supersedes the historical review below

Resolved SOS records are automatically eligible for deletion 30 days after
`resolved_at`, even while the account remains active. Expiration is asynchronous.
Permanent retention is not required. Keep the existing production alerts TTL
unchanged; the proposal to remove it is superseded and must not be executed.

Transfer-time preservation means retaining the incident unchanged within its
retention period, not retaining it indefinitely. New active SOS has no expiry
date; reopening must atomically remove the previous `resolved_at`. Resolving
again starts a new 30-day period. An idempotent resolve preserves its timestamp.

The sections below document earlier review stages, not the current merge status.

## Corrective revision after the independent review of `35e0c02a`

- Alert listing now reads a consistent snapshot and rechecks current family
  authority before returning SOS details. Acknowledgment checks authority
  under the family fence; the already-resolved SOS response also takes the
  fenced path. Clear-all does not delete SOS.
- Leave shares the verified join departure and self-record movement rules;
  it rejects unresolved or ambiguous owned SOS and does not move SOS history.
- Legacy family setup and its care backfill run together. Unscoped SOS is
  not attributed to a newly created family. Legacy SOS promotion/pruning and
  demo-data purge no longer run at startup; date repair skips SOS.
- Account/member deletion performs admitted database mutations atomically
  under the family fence. Ambiguous linked records cause rejection rather
  than partial deletion. SOS is retained; Stripe cleanup follows commit.

**Evidence:** 303 backend tests passed, plus 11 GPS consent/publication
regressions and 112 frontend tests. The two original raw-Mongo tests were
unchanged and still expected 409 but received 200. New tests cover overlapping
archive access and transfer, leave with an active SOS for another member,
startup repair versus join, deletion rollback and conflicting writes.
On a disposable local replica, 30 samples per path measured raw SOS insert
at 3.70 ms median / 5.37 ms p95 and fenced persistence at 7.31 ms median /
13.72 ms p95. One forced contention schedule took 200.38 ms. Internal retry
tests passed; this does not establish production latency or cross-request
exactly-once delivery. No production system was tested or changed.

**Fresh independent verdict: NOT CLEAN.** The review identified two
application-level blockers outside the requested correction: owner-initiated
removal still uses an unscoped ownership selector that can move records from
another family, and ordinary (non-SOS) alert resolution can use stale
membership. The reviewer also flagged that a non-owner departure can leave
dependent obligations behind. The existing `alerts` TTL expires dated records;
under the final product decision this is intended for resolved SOS after 30
days, and the existing index must remain unchanged. These historical risks are
distinct from the two accepted raw-Mongo limitations. Stop for approval.

## Current family-write-fence revision

This section records the preceding `35e0c02a` revision. The owner approved
cooperative writer changes, including SOS persistence, while expressly retaining
the two direct-Mongo reproductions as limitations. Nothing here authorizes a
merge, production data change, configuration change, build or release.

### Implementation and confidence

**Severity: Critical privacy/data-integrity boundary.** Confidence is high for the
tested application schedules, not for arbitrary database writers or production
SOS latency. The fence increments a real `family_write_epoch` on each affected
family in sorted order, in the same transaction as the domain mutation.
Authorization and membership are re-read after acquisition.

- Verified invitation and retained family-code transfers, recipient OTP joins,
  retained family-code OTP joins, family leave/removal, dependent creation,
  lazy family/self-row creation, reminders, medication logs, check-ins, SOS
  insertion/resolution and incident-producing background inserts participate.
- SOS delivery stays outside transaction callbacks. A single event identity is
  reused through callback retries; fanout uses the committed actor/family.
  Uncertain commit results retry the commit, not domain creation or delivery.
- The installed Motor helper auto-committed its transaction context outside its
  documented commit-retry loop. A real failpoint reproduced the escaping error.
  The shared wrapper now explicitly commits inside its callback and retries
  `UnknownTransactionCommitResult`; Motor retains transient callback retries.
- Ordinary transaction deadlines are two seconds; transfer wrappers use one
  second. Timeouts return an explicit 503, not success. These are application
  cancellation budgets, not a claim that an already-dispatched database command
  cannot finish later. Cross-request emergency idempotency and a durable delivery
  outbox are not established by these tests.
- Resolved self-SOS documents remain unchanged, in their original family.
  Identity, dependent, active-SOS and private-history predicates remain in use.
  Historical documents are not used as lock records.
- No fence was added to GPS acquisition, location/battery sample persistence,
  routine reads/polling or tracking state. Battery fencing occurs only when an
  incident record is actually inserted.

### Final verification

The following full backend run completed after all production-code edits:

```sh
KINNSHIP_RUN_LOCAL_MONGO_TESTS=1 PYTHONPATH=backend python -m pytest \
  backend/tests/test_family_write_fence_mongo.py \
  backend/tests/test_sos_history_transfer.py \
  backend/tests/test_email_links.py \
  backend/tests/test_email_links_mongo_integration.py \
  backend/tests/test_invitation_removal_mongo.py \
  backend/tests/test_invitation_resend.py \
  backend/tests/test_sos_optional_location.py \
  backend/tests/test_medication_occurrence_reliability.py \
  backend/tests/test_post_escalation_acknowledgment.py \
  backend/tests/test_battery_alert_lifecycle.py \
  -q -s --tb=short -W ignore::DeprecationWarning
```

**276 passed, 2 failed in 83.88 seconds**, one pending-deprecation warning.
The 22 new application-boundary cases all passed. They cover both writer/transfer
orderings; dependent, SOS reopen/new SOS and care-log obligations; competing real
transfers; sorted locks; rollback/deadline; fresh authority/subject checks; real
SOS endpoint delivery after transient and uncertain-commit retries; real retained
OTP endpoint success, code-rotation races and account/linkage rollback; and
partial-collection leave failure. Endpoint bodies are compiled from actual
application source to avoid importing production clients/jobs. Cryptography,
session issuance, models and external notification delivery are stubbed where
appropriate; transaction and domain storage use owned loopback MongoDB.

The two failures are deliberately unchanged direct-Mongo bypass probes:

- `test_resolution_change_during_transfer_retries_and_blocks`
- `test_concurrent_dependent_insert_after_snapshot_must_block`

Their assertions still require 409 and observe 200. Neither is skipped, marked
xfail, weakened or described as a protected application writer.

The older isolated SOS/medication/battery algorithm tests explicitly stub the
new persistence seam because their fake databases are not transactional. They
are regression evidence for those algorithms, NOT additional fencing proof.

The original five frontend suites also passed: **112 tests, 5 suites**, unchanged
frontend source. The running web preview rendered its unauthenticated notice;
signed-in UI and a production backend were not exercised.

### SOS latency and retry findings

Owned loopback replica, 30 warm sequential samples per path:

| Persistence path | Median | p95 | Maximum |
| --- | ---: | ---: | ---: |
| Raw alert insert | 6.42 ms | 7.41 ms | 8.18 ms |
| Fenced SOS persistence | 18.46 ms | 21.32 ms | 23.19 ms |

Added local median cost: **12.04 ms**. One deliberately contended transfer/SOS
schedule completed in **186.74 ms**, persisting once in the committed current
family. Both transient insertion and uncertain-commit retries produced one
visible emergency notification plus the existing data-only companion. These
measurements do not establish WAN, load, failure-tail or physical-phone latency.

### Independent review and subsequent fixes

Exactly one independent adversarial review was run for this revision. It returned
**NOT CLEAN** with two high-severity retained OTP/KINN bypasses and a
medium-severity leave helper that swallowed collection errors.

Subsequent fixes route both retained OTP family-code branches through the shared
transactional join, include unique-name linkage and new-user insertion in that
transaction, revalidate the destination code/current owner after acquisition,
and make a failed leave move abort the whole transaction. Raw calls to the old
bulk-move helper are refused. Lazy family backfill is now one transaction too.
The new real-application regressions pass. The implementing agent also found and
fixed the Motor uncertain-commit behavior described above.

**Those subsequent fixes have NOT been independently re-reviewed.** No second
review was run or implied. Final verdict remains **NOT CLEAN / do not merge**.

### Remaining uncovered writers and operational boundaries

The cooperative protocol is not a database-enforced predicate lock. Identified
unfenced paths include:

- `backend/server.py::_migrate_family_groups`: startup-owned-data backfill after
  creation of its group. The group helper is fenced; its separate bulk backfill
  is not one atomic admission.
- `backend/server.py::_migrate_alerts_backfill_v50`: raw resolution backfill and
  promotion of legacy acknowledged SOS; no family counter is acquired.
- Other startup cleanup/backfill tasks, including legacy reminder migration,
  legacy-demo cleanup and identity/metadata repair, are not comprehensively
  enrolled or concurrency-certified by this change.
- Account deletion and the member-deletion cascade retain their existing
  destructive workflows; they are not certified as atomic participants.
- `backend/scripts/cleanup_duplicate_missed_checkins.py` directly deletes alerts.
  Other operator/admin/raw Mongo scripts and any external writers do not gain
  protection automatically.
- Root-level historical backend copies are not revised; this evidence applies
  to the active `backend/` application tree only.

Do not run unfenced structural maintenance concurrently and infer safety from
these application tests. Production data, memberships, invitations and settings
were not changed. There was no merge, Railway deployment, OTA publication, EAS
build or Google Play upload.

### Exact changed-file manifest for this revision

```text
backend/family_write_fence.py
backend/email_links.py
backend/family_group.py
backend/med_scheduler.py
backend/server.py
backend/tests/family_fence_unit_seams.py
backend/tests/test_family_write_fence_mongo.py
backend/tests/test_battery_alert_lifecycle.py
backend/tests/test_email_links.py
backend/tests/test_email_links_mongo_integration.py
backend/tests/test_medication_occurrence_reliability.py
backend/tests/test_post_escalation_acknowledgment.py
backend/tests/test_sos_history_transfer.py
backend/tests/test_sos_optional_location.py
docs/resolved-self-sos-transfer-review.md
.agents/memory/MEMORY.md
.agents/memory/motor-commit-retry-boundary.md
.agents/memory/sos-history-transfer-boundary.md
```

## Historical baseline — before the approved fence revision

Everything below is the preserved earlier history-only implementation and review,
not the results or scope of the current revision.

## Authorized scope

Backend-only repair on a dedicated branch. Recognize strictly verified resolved
self-SOS history, preserve its entire stored document and family context, retain
dependent/active-obligation protections, and prevent disclosure to a destination
or former family. No production data/configuration writes, merges, releases,
OTA updates, native builds or changes to SOS sending/tracking/performance.

## Root cause and implementation

Normal SOS requests omit a member ID. The server records the triggering account
ID as the SOS subject. The invitation guard historically recognized only member
row IDs. It consequently classified legitimate self-SOS history as an unrelated
care obligation.

- `backend/sos_history.py`: shared server-derived identity classification;
  collision/duplicate checks; strict BSON boolean resolution; source-family and
  owner predicates; separate ordinary movement and retained-history predicates.
- `backend/email_links.py`: recognize qualifying history during transactional
  acceptance without updating it; never move SOS under the ordinary record
  selector; block unresolved or ambiguous owned SOS. Existing invitation account
  matching, roles, retries and transactional acceptance remain in place.
- `backend/family_group.py`: preserve qualifying history during owner removal and
  explicit leave. Preserve vacated containers with remaining data. Refuse legacy
  family-code/OTP bulk moves involving resolved self-SOS before changing records;
  request the verified personal email-invitation flow instead.
- `backend/server.py`: hide resolved SOS whose owner has departed/deleted their
  account from family alert listing, acknowledgment, resolution and clear-all.
  This is deliberately conservative for ambiguous subjects too. No SOS sender,
  notification payload/routing, GPS or background code was changed.

### Guard/movement invariant

Ordinary move authority is owner + verified source self-member + source family,
and excludes SOS. Retained history requires owner + unambiguous self subject
(account ID or verified member ID) + source family + SOS + explicit boolean
resolved. The guard accepts only the union of these two classes. Only the
ordinary class moves. Other people's/dependent records never gain authority from
the SOS exception. These predicates are evaluated inside the existing transaction.

## Own-history retrieval

`GET /api/auth/self/sos-history` derives identity solely from the authenticated
principal and requires that account to still exist. It ignores caller-supplied
user/family parameters and returns only strictly verified resolved self-SOS.
Response fields: `id`, `type`, `resolved`, `created_at`, `resolved_at`; envelope
`items` (newest 100 maximum) and `has_more`. A true `has_more` explicitly signals
truncation; this endpoint does not claim complete paginated export.

No coordinates, messages/titles (which can embed coordinates), member names,
resolver names, source family identifiers or unknown stored extras are returned.
It grants no general access to a former family and adds no new family feed.
No frontend/history screen is added by this backend-only change. A later approved
UI can consume this safe summary; a full incident/detail/export API needs a
separate privacy review. Missing historical identity proof fails closed.

## Validation evidence

All MongoDB writes in testing use a disposable, explicitly owned loopback
replica set with synthetic accounts. No production endpoint or database is used.

Commands:

```sh
KINNSHIP_RUN_LOCAL_MONGO_TESTS=1 PYTHONPATH=backend python -m pytest \
  backend/tests/test_sos_history_transfer.py \
  backend/tests/test_email_links.py \
  backend/tests/test_email_links_mongo_integration.py \
  backend/tests/test_invitation_removal_mongo.py \
  backend/tests/test_invitation_resend.py -q --tb=short
```

**143 passed, 2 failed**, two deprecation warnings. The failing tests are not
skipped, xfailed or weakened:

- `test_resolution_change_during_transfer_retries_and_blocks`
- `test_concurrent_dependent_insert_after_snapshot_must_block`

Both expected rejection and observed a successful join after a concurrent
server-only write. Membership/role/idempotency, unchanged BSON archives, mixed
records, dependents without login accounts, ordinary care obligations, malformed
resolution flags, ambiguous/colliding subjects, legacy bypass rejection,
leave/removal retention, and history authorization checks passed.

```sh
cd frontend
npm test -- --runInBand --watch=false \
  src/__tests__/emailLinkCallback.test.tsx \
  src/__tests__/emailSignInInvitation.test.tsx \
  src/__tests__/inviteTerminalNavigation.test.tsx \
  src/__tests__/pendingInviteConsumed.test.ts \
  src/__tests__/rootLocationPermissionRecovery.test.tsx
```

**112 passed, five suites.** No frontend changes.

## Independent adversarial review

An independent reviewer returned **NOT CLEAN**:

1. **High: stale archive classification.** Another server writer can make the
   SOS unresolved after this transaction's snapshot; the transaction can still
   commit. Setting `resolved=True` to its existing value was tested as a possible
   fence: it did not protect the row. That ineffective no-op was removed.
2. **High: phantom care obligations.** A new dependent can be inserted after
   the transaction snapshot but before eligibility queries; it is invisible to
   the snapshot, and the transfer commits. Mongo transactions are not predicate
   locks. Repeating a snapshot query does not fix this.
3. **High: legacy archive handling.** Addressed after review by refusing
   unguarded legacy history transfers and preserving nonempty containers on
   leave. Local regressions pass.
4. **Former-family history visibility.** Addressed for sequential requests
   after review with family alert scopes and actual endpoint-body regressions
   for list, ack, resolve and clear. Former-family membership alone no longer
   grants access to these departed-owner archives.

The independent review was run once. Subsequent bounded fixes were checked by
the implementing agent; they were not represented as independently re-reviewed.

## Unresolved security boundary — do not merge

**NOT CLEAN.** Requirements for concurrent server-only changes and new obligations
are not met. There is also no claim that the new family-alert ownership read is
atomically fenced against a simultaneous removal/clear operation: sequential
authorization tests are not proof against this class of race.

A shared source-family/account admission fence works only if all relevant
obligation writers and transfer/removal operations participate. In-flight
nonparticipating writes can otherwise bypass it. Supporting arbitrary direct
database inserts would require a database-enforced invariant or operational
exclusion, not just a helper in the invitation route.

Do not mutate incident fields temporarily, auto-resolve an emergency, add a
second unlocked check, or weaken the tests to obtain a green result.

Explicit approval is required to scope coordinated writer changes, including
SOS/member/care creation and resolution and retained entrypoints. That exceeds
the current restriction against changes to SOS sending and other protected
behavior. This draft intentionally preserves the failing evidence and stops for
the owner's decision. No merge/release is authorized.
