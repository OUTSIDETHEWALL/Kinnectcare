# Phase 3 — consolidated review and release-readiness report

## Decision

**The scoped source corrections have passed independent review. Phase 3 is NOT
ready to close as a released/accepted phase.** The owner-confirmed serving
database's index and anonymous SOS state were verified read-only. Credential
safety, a safe deployment boundary, operational acceptance and the two Android
phones remain open. No PR was merged and no release action was taken.

All three PRs are draft/open/unmerged. Independent agent review is not a GitHub
approval or CI result: the inspected PRs had no formal GitHub reviews and no
check runs. No whole-repository green or legal-compliance certification is made.
Final PR-head hashes are recorded in the live PR descriptions and delivery
message after committing this report; code identities below identify the
reviewed implementation, not a self-referential documentation commit.

## PR-by-PR assessment

### #199 — secure family-code rotation and invitation preservation

- Branch `fix/family-code-rotation-security`, base `main`.
- Verified head: `496cc5d4cd7d0bab17d841ad04427c1327661b54`.
- Root cause: **High, high confidence** — the existing client URL returned 404;
  simply exposing the dormant implementation would leave ownership/code updates
  outside admission's transaction fence.
- Corrected registered route, authoritative current owner checks, atomic rotation
  and read-only route authentication. Existing memberships and valid recipient
  invitations remain unchanged.
- Independent review **PASS**: initial Medium implicit-provisioning finding closed;
  no unresolved Critical/High/Medium in this correction.
- Prior evidence: **142 real Mongo passes + 126 offline passes, 21 skipped**.
  Three permission-fixture failures also reproduced with verified-main source.
  Reviewer independently checked source/AST/compilation, not Mongo runtime.
- Its 29-case rotation suite also passed in this assessment's 214-case combined
  run. Do not add overlapping historical and current totals.
- No new collection/index/migration/configuration or client/native change.
  Requires an approved backend deployment to reach phones.
- **Engineering-ready for owner merge approval first**, subject to the deployment
  hold below. A later successful rotation supersedes an earlier returned code;
  this is serialization, not permanent historical-code reservation.

### #200 — account deletion and access revocation

- Branch `fix/account-deletion-care-records`, base
  `fix/family-code-rotation-security` (#199).
- Verified head: `167a09a95c44f6857ddd7294ccac055c39a63752`.
  Delivery/identity implementation is unchanged from the reviewed `bc0c0465`;
  subsequent fixture, disclosure and evidence commits are documented separately.
- Root cause: **High, high confidence** — ordinary verified self-care history
  wrongly blocked deletion. Review also identified retained OTP replay, late
  invitation writers, unreserved sends and a WIP self-SOS namespace regression.
- Deletes only verified personal records atomically, revokes original identity,
  coordinates credential/invitation writers and reserves deletion-sensitive
  provider attempts. Preserves other people's care and resolved SOS history.
- Independent final review **PASS**, all four High findings closed, zero
  unresolved Critical/High in reviewed scope. Copy follow-up also **PASS**.
  Reviewer inspected evidence and independently confirmed 96-test collection;
  they did not independently rerun the passing suites.
- Prior final evidence: **536 distinct targeted passes**, plus **2 new disclosure
  assertions**. Current safety run rechecks deletion, coordination and related
  writers within its 214 passes; these totals overlap.
- The account-page hint no longer promises removal of all associated data.
  Confirmation discloses retained SOS/security records and interrupted-send
  blockers. The remaining shared privacy-policy correction is in #190.
- **Engineering-ready for owner merge approval after #199**, not independently
  ready for deployment/retention closure. Accept the fail-closed operational
  limitations below; deliver with the reconciled #190 policy.

#### Unknown/interrupted provider sends and deletion blockers

Provider calls occur outside transactions after a durable reservation. Caller
cancellation does not establish that a shielded task or email thread stopped.
Only the actual provider return permits completion settlement.

Process death, unknown provider outcome or failed settlement can leave an active
attempt blocking deletion **indefinitely**. There is no TTL, lease-expiry unlock,
bounded recovery promise or unattended resend/reconciliation. Do not blindly
clear attempts or resend: establish the original worker/provider is quiescent
and review the outcome first. A previously authorized notification may arrive
after deletion. Successful queue reservation is not proof of phone receipt.

Other explicit blockers: active/ambiguous SOS, dependent-care obligations,
ownership with remaining family members, ambiguous/cross-family identity or
records, oversized selections above 10,000 rows, missing linked-family authority,
and transaction/database failure. No partial successful deletion is reported.
Minimal hashed security/lifetime counters remain to reject old credentials.
Billing cancellation happens after commit and is best-effort, not guaranteed.
No Google Play Billing implementation was added.

#### Database and delivery requirements

Adds `deletion_deliveries`, account/mailbox counters and an SOS subject-kind
discriminator. The collection's intrinsic unique `_id` supports functional
correctness. No startup index, backfill or destructive migration is introduced.
Before significant volume, separately approve additive non-unique indexes for
`(state, user_ids)`, `(state, email_hash)` and `(state, operation_key)` to avoid
history scans. **Never TTL-expire active delivery attempts.**

Old application/scheduler workers and provider calls must be drained before
certifying the deletion guarantee. Mixed old/new workers can bypass reservation.
Extra short transactions depend on Mongo availability and may add latency,
including to SOS fanout. Accept physical latency and recovery handling before
release. Backend and client source need approved delivery; no native dependency,
permission, AAB or configuration change is inherently introduced by this fix.

### #190 — existing SOS retention, updated rather than replaced

- Branch `fix/sos-reopen-retention-timestamp`, now based on #200.
- Original head `b67bad5d5276d32053c5d18f36c0400e6d1a1db3` was conflicted
  against current main. It was not merge-ready.
- Preserved its history and synchronized the existing feature branch with
  reviewed #200 using ordinary merge commits. No PR/main merge or force-push.
- Current reviewed source/evidence commit:
  `80cbc8f94ef7edb666e524cb19ab39c240fdb45e`.
- Root cause: **Critical potential data-integrity risk, high confidence in the
  code path** — retaining a prior resolution date when reopening could make an
  active SOS eligible for automatic deletion. This is not evidence that a
  production incident was deleted.
- Reopening and removal of expiration occur in one transactional write, including
  an already-active legacy row. New resolutions obtain a datetime if omitted;
  repeated resolution preserves its original clock. New active SOS cannot inherit
  expiry. Existing fresh authority, incident-owner restriction, user/member
  namespace, SOS priority and history access fences are preserved.
- Shared privacy language now states resolution-based 30-day eligibility,
  asynchronous deletion, no active/unresolved expiration, original history scope,
  deletion blockers and retained hashed security records. It removes the false
  unconditional account-erasure deadline.
- Independent review **PASS**, no unresolved Critical/High source finding.
  Reviewer inspected ancestry/source/tests/whitespace; no independent runtime
  rerun or production-retention certification is claimed.
- **Engineering-ready for owner merge approval after #200**, with production
  index/state verification completed but operational acceptance still open.
  Startup neither creates nor
  alters the alerts TTL; do not run the superseded TTL-removal proposal.

## Current assessment verification

All mutation tests use synthetic data in owned loopback MongoDB replicas.
An explicit socket guard loads before pytest collection. Provider callbacks are
stubbed; no actual notification receipt, emergency call or billing action is
established by these results.

| Current check | Result |
| --- | --- |
| Lifecycle and actual TTL-monitor cases | **13 passed**: 7 lifecycle + 6 database cases |
| Combined family fence, deletion, coordinated delivery, rotation, invitations, medication midnight, check-in and SOS-priority cases | **214 passed** |
| SOS history/transfer authorization suite | **39 passed, 2 known failures** |
| SOS permission/send receipt/detail navigation and both disclosure suites | **90 passed**, including the 4 disclosure assertions |
| TypeScript | Same pre-existing `schedulingTracing.test.ts:68` TS2345; no additional reported error |
| Changed Python parsing, backend import provenance and whitespace | Passed |
| Web preview smoke | Restarted/bundled; public privacy page including revised retention section rendered. Signed-in deletion UI and Android remain unverified. |

This is **356 passing cases plus 2 known failures** in the current assessment,
not a whole-repository pass and not additive to historical #199/#200 totals.
The two history failures directly mutate Mongo outside participating application
writers: concurrent raw reopening and raw dependent insertion can bypass the
cooperative fence. They remain visible, unmodified, and within the owner's
previously accepted boundary. No claim protects arbitrary maintenance writes.

Actual local TTL tests observe expired resolved records disappear and active,
unresolved or not-yet-due records survive. Controlled cleanup transactions test
both commit orderings against reopening; they are not a simultaneous native
TTL-monitor stress test. Acknowledgment preserves the retention clock. Successful
account deletion does not rehome retained history or reset its expiry.

Missing/invalid-date legacy resolved records **do not expire** under a date TTL.
No safe original date can be invented. Untouched legacy active records carrying
a date are also a potential operational concern. The approved serving-database
snapshot below found neither anomaly. Any future evidence-based correction needs
separate approval—not an automatic cleanup/backfill hidden in startup.

The earlier #200 verification incident remains disclosed: a historical HTTP test
attempted one configured remote SOS POST and received 401 before its handler/
cleanup. It is not passing evidence or independent proof of production effects.
All subsequent assessment pytest batches use the collection-time loopback guard.

## Production retention and deployment gates

### Approved read-only verification — 2026-11-19 20:50 UTC

The owner supplied the serving cluster hostname and database name. The existing
connection's hostname and default database matched them; queries explicitly
selected the confirmed database. This closes the previous target uncertainty
**based on owner-confirmed configuration**, not independent access to Railway's
withheld database settings. No credentials or personal rows are recorded here.

Existing index: **`ttl_resolved_at`**, key `resolved_at: 1`,
**`expireAfterSeconds: 2592000`** (30 days), partial filter
**`resolved_at: {$exists: true}`**. The index does not enforce resolved status.
Application writers must keep active/unresolved incidents ineligible.

| Anonymous serving-database snapshot | Count |
| --- | --- |
| SOS records | 4 |
| Strictly resolved with scalar BSON resolution date | 4 |
| Not strictly resolved with a TTL-capable scalar/array date | 0 |
| Strictly resolved without a scalar BSON date | 0 |
| Strictly resolved and already older than 30 days | 0 |
| Strictly resolved with a future resolution date | 0 |
| Array-valued resolution date | 0 |

No index migration, timestamp repair or cleanup is indicated by this snapshot.
This is not proof of a production TTL deletion: no overdue record was present,
no live record was backdated, and native TTL deletion was observed only on the
owned local replica. The undeployed source correction and physical/operational
acceptance remain separate. Future index/data repairs require new approval.

### Credential safety — separate unresolved operational concern

Permission inspection showed the existing secret labelled read-only is actually
write-capable. An initial check stopped on that discovery; the subsequent
verification used an explicit command allowlist: collection/index metadata and
an `alerts` aggregate restricted to `$match`/`$group`. No `$out`, `$merge`,
record mutation, index operation or configuration change was performed.

A credential was also disclosed in chat. Treat it as exposed: arrange separately
authorized rotation through secure tooling and a genuinely least-privilege
verification login. Do not copy the credential into code, reports, task plans,
logs or comments. No credential value is retained in this report. No evidence
of unauthorized use is claimed. Rotation and any backend-secret/restart sequence
are production changes and were not performed under verification-only approval.

Read-only Railway inspection found the live backend-root service connected to
repository `main`, with source check-suite waiting disabled and a successful
latest deployment. Thus **merging main may deploy automatically**. Before any
merge, obtain a separately approved deployment hold or coordinated rollout
procedure; do not assume GitHub draft status/agent review is a release barrier.
No Railway setting or production database/index was changed in this assessment.

## Merge order without duplicate parent changes

Recommended stack: **#199 → #200 → #190**, while delivery is held.

1. After explicit owner approval and the deployment boundary is established,
   merge #199 using an ancestry-preserving merge commit.
2. Retarget #200 to `main`; verify its diff excludes #199, its head is expected
   and required checks/review remain satisfied. No rebase is necessary with the
   preserved parent ancestry. Obtain approval before merging #200.
3. Retarget #190 to `main` after #200 merges. Verify only retention/disclosure/
   evidence changes remain, with no overwritten accepted fixes. Obtain approval
   before merging it.
4. Reassess if any parent changes. Squash/rebase merging changes ancestry and
   requires explicit restacking/diff verification, not blindly merging duplicated
   parent commits. No history rewrite or force-push is authorized.

All three remain drafts. Passing scoped review makes them source candidates;
it does not authorize immediate merges, deployments or Phase 3 closure.

## Two-Android-phone acceptance — not yet performed

Use consenting synthetic accounts and a separately approved delivered candidate.
Never delete a real family or place a non-emergency emergency call.

1. **Rotation/invitations:** owner rotates; old wall code fails; new code succeeds;
   unrelated valid recipient invitation remains valid; retained/stale non-owner
   sessions cannot rotate; no membership/care records disappear.
2. **Deletion:** a self account with ordinary medication/check-in history can
   delete; dependent/owner/active-SOS and ambiguous cases block clearly; other
   phone's care remains. Read the actual hint, confirmation and privacy screens.
3. **Revocation/recreation:** deleted phone's old session, sign-in link, OTP and
   captured invitation work do not restore the old identity or affect a replacement
   account. Fresh legitimate onboarding still works; no stale queued send leaks.
4. **Provider interruption:** controlled rejection, caller cancellation, app/server
   interruption and unknown provider result show truthful outcomes and safe
   deletion blocking without duplicate resend. Do not manufacture a live emergency.
   Demonstrate the operator procedure; do not assume an automatic unlock.
5. **SOS:** activate/cancel/success/offline/retry with consent; verify the second
   phone's actual visible push, timing, acknowledgment/resolution and correct
   subject. Exercise GPS allowed/denied/pending/stale and emergency dialer access
   without completing a call. Measure reservation overhead and no duplicate fanout.
6. **Privacy/transfers/retention:** consent withdrawal during a pending fix and
   stale sessions cannot publish or read a new family's data. Retained resolved
   history stays in original scope; active SOS remains visible. Use approved
   isolated fixtures for 30-day expiration, never backdate production alerts.
7. **Phase 2:** with both apps closed, late-night dose across midnight escalates
   exactly once; acknowledgment suppresses it; missed check-in worker notifies
   without opening the dashboard. Verify timezone/quiet hours and legitimate
   medication/check-in state survive transfer/deletion rejection.

## Recommended next action and stop

The approved serving-target identification and read-only index/state verification
are complete. Next, approve a controlled credential-safety and deployment-hold
plan before any merge. Planning is not authorization to rotate credentials,
change configuration, repair data, alter indexes, merge or deploy.

Then review the remaining operational and two-phone evidence before deciding
whether to close Phase 3. Existing broader prelaunch holds remain; no Railway
deployment, production mutation/configuration change, OTA, AAB build/upload,
Google Play Billing implementation or Phase 4 work was performed.
