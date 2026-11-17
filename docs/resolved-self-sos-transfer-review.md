# Resolved self-SOS transfer correction — draft, NOT CLEAN

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
