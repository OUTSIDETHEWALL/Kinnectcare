# Phase 3B — safe account deletion

## Status: independent final review PASS; draft remains unmerged

**Do not merge or deploy.** The owner explicitly approved correction of the
three High findings and minimum deletion-sensitive delivery coordination,
including interruption, retries and recovery. Implementation and focused tests
have been added. Independent code re-review explicitly closed the original
three High findings and the additional SOS regression, with no further concrete
Critical/High defect identified. Final security/data-integrity and evidence
review is **PASS**, with **zero unresolved Critical/High findings** in this scope.
PR #200 remains draft, stacked on unmerged PR #199.

The sections below through “Initial database, privacy and delivery boundaries” record the initial draft's
evidence and limitations, not the final corrected behavior. The approved
corrections and their operational implications follow that historical record.
The subsequent Phase 3C source assessment passed independent review in the
existing retention draft #190. Its production-database target verification and
physical acceptance remain OPEN; consult the consolidated Phase 3 report in
that draft before approving any merge or release.

Baseline GitHub main: `56b0d7634e5cf3131c3f972fe0971f5f8d11cf67`.
Dedicated branch: `fix/account-deletion-care-records`, stacked on rotation draft
#199's branch at `496cc5d4cd7d0bab17d841ad04427c1327661b54`. The parent PR is
still unmerged; platform task completion is not GitHub merge evidence.

Historical initial [draft PR #200](https://github.com/OUTSIDETHEWALL/Kinnectcare/pull/200),
initial WIP implementation/evidence commit
`981913cfaa84faf501f994a1e593a7107b88d230`. Its explicit base is
`fix/family-code-rotation-security`, not `main`. The initial PR recorded three
then-open High findings. All were subsequently closed, together with the later
SOS regression, as recorded in the final review sections. It remains
draft/unmerged pending the owner's approval.

## Original failure and partial correction

**High — legitimate account deletion blocked; high confidence.** An owned
disposable Mongo fixture with a self profile, owned active medication and normal
medication-notification history reproduced HTTP exception 409, “Resolve linked
care records before deleting your account.” The deletion helper rejected the
existence of notification/occurrence/welfare references without classifying
which child records were actually owned and safe to remove.

The current draft replaces blanket child-history blockers with subject,
reminder, family and ownership checks in the existing transaction/family fence.
It retains fail-closed handling for active/ambiguous SOS, dependents, other
people's care, family owners with remaining members, ambiguous identities and
active recognized send reservations. All cleanup rolls back on failure.
Read-only authentication avoids provisioning a family just to delete an account.
Existing billing cleanup remains best-effort after commit; no billing
implementation change was made.

These improvements are **not sufficient** to close the task because the
late-writer and external-send boundaries below remain incomplete.

## Initial relationship and writer inventory

| Records / authority | Current draft behavior and remaining limitation |
| --- | --- |
| `users`, JWT identity and embedded push tokens/subscription references | Deletes the account atomically; fresh authentication and own-history lookups reject the old user ID. Tokens disappear with the user. Billing calls remain outside the transaction. Retained OTP redemption can still cross identity replacement: blocker. |
| `family_groups`, memberships, ownership | Rechecks live family/account authority. Requires handoff rather than deleting another user's family/care. Empty solely owned family is removed; a minimal non-invitable envelope is retained when SOS history remains in its original scope. No historical family cleanup. |
| `members`, legacy `family_members` | Deletes only verified self profiles/identities. Rejects duplicate/colliding references, dependents and inconsistent legacy ownership. Startup self-member creation already rechecks account/family under the existing structural fence. |
| `reminders` (medications/routines), `medication_logs` | Deletes verified owned self-care, not another owner's assignments or another patient's records. Active medication history alone no longer blocks deletion. |
| `med_notifications`, `medication_occurrences` | Proves subject/reminder/family relationships, including provable legacy rows; rejects ambiguous/cross-family history and recognized sending states. Scheduler stage/occurrence creation uses the existing family fence. **DUE transport lacks a reservation spanning token selection through send: blocker.** |
| `checkins`, `checkin_requests`, `checkin_deliveries` | Removes verified owned receipts/prompts and relevant queued deliveries; refuses other-patient/cross-family requests and recognized sending/responding states. Missed-check-in reservation and structural receipt creation already use the family fence. Not a certification of every in-progress welfare transport window. |
| Ordinary `alerts` | Removes verified owned non-SOS records, preserving other people's data. Existing fenced background creation cannot recreate a departed/deleted subject's structural record. Actual unfenced writers must not be assumed covered by this test. |
| Historical/active SOS `alerts` | Preserves resolved records byte-for-byte in the original family, without changing timestamps or granting a new family access. Requires strict BSON boolean `true`; unresolved/ambiguous incidents block deletion, including known subjects/owned incidents outside the current family. Thirty-day expiration is approved policy, not certified here. |
| `location_history`, `location_ingest_log`, `recovery_push_evidence` | Removes verified private subject evidence. Necessary new persistence adapter performs a real parent-member write plus evidence insert/upsert in one transaction, so deletion cannot race a late child insertion. No family structural fence is acquired for ordinary telemetry. Recovery provider invocation still precedes this guard: blocker for transport, not private storage. |
| Recipient `family_invites` | Removes invitations bound to the deleted account as inviter/accepted identity/recipient. **Actual invitation creation checks owner too early and later inserts/sends unfenced: blocker.** Existing valid invitations for unrelated identities/families are not broadly purged. |
| `email_links`, `otp_codes`, `email_link_identities` | Removes existing account-bound credentials and its email identity row. Necessary issuance changes share the existing per-email transaction write and reject an observed account replacement. Email-link verification already identity-binds redemption. **Retained OTP verification is not similarly protected: blocker.** |
| Email/IP rate-limit hashes, shared blank-push/process diagnostics, migrations/configuration | Not a bulk purge target. Existing shared security/diagnostic lifetimes are not weakened. Third-party/process-log erasure and production TTL/index behavior are not audited or certified in this draft. |
| `family_sos_priority` | Existing short-lived, out-of-transaction coordination metadata; no new queue policy or production cleanup. |
| Expo/FCM, email provider, Stripe | Database transactions cannot recall external work. Existing submitted notifications may arrive later. **Current application-controlled token/email windows are broader than “already submitted”; shared reservation/settlement remains an open architectural question.** Billing callbacks are stubbed in tests. |

An oversized collection (over 10,000 selected rows), ambiguous legacy evidence,
missing family with linked care or unresolved authority currently fails closed;
there is no partially completed deletion. These are explicit operational
limitations, not a completed legal/account-deletion compliance claim.
Automatic removal of a non-personal archived family envelope after its final SOS
expires is not implemented here.

## Initial independent review findings

Review was independent static inspection of the implementation and tests, not an
independent rerun of the implementer's pass counts.

1. **High, high confidence — retained OTP identity replay.** Verification reads
   an OTP outside the identity transaction, ignores whether consumption deleted
   anything and later looks up the user by email. Pausing it around deletion and
   mailbox-account recreation can select the replacement identity. Issuance
   coordination alone is insufficient. Requires identity binding, transactional
   consumption and exact interleaving tests.
2. **High, high confidence — invitation resurrection.** The actual invitation
   route checks ownership before later awaits, then directly inserts and sends.
   A captured request can outlive owner deletion. Requires fresh fenced
   persistence/authorization and coordinated delivery; a generic structural
   insert test does not cover this writer.
3. **High, high confidence — unreserved outbound sends.** Medication DUE sends,
   cached push-token helpers, recovery refresh and authentication email delivery
   can start transport after cleanup. Existing manually seeded “sending” rows
   and post-deletion queue tests do not prove these exact windows safe.

The reviewer found private-evidence parent coordination, unchanged GPS
capture/publication, conservative SOS treatment, fresh JWT rejection and
unchanged billing implementation sound/minimal. It did **not** approve the
overall correction. All three findings remain open; no closure verdict exists.

## Initial verification

All integration data is synthetic in an owned loopback MongoDB replica set.
Non-loopback sockets are blocked; mail, push and billing callbacks are stubbed.
No production database URI is used.

| Check | Result / qualification |
| --- | --- |
| New deletion/access/ownership/rollback tests | **32 passed** |
| New transaction-race/queued-work/credential-issuance tests | **16 passed** |
| Combined new tests plus existing rotation, email-link, family-fence and Phase 2 check-in suites | **165 passed**; includes the 48 new tests, not an additional 165 |
| Location-history, pipeline and refresh-trace consent suites | **104 passed** |
| Other fully passing fresh-process offline groups | Email links **59**, optional-location SOS **7**, location-consent writes **11**, family-snapshot privacy **51**, device presence **11**, medication occurrence reliability **34** |
| Total across fully passing offline groups above | **277 passed** |
| Five additional offline groups, stopped at first failure | Check-in location **1 failed**; check-in history **21 passed, 1 failed**; self-member creation **1 failed**; startup sync **19 passed, 1 failed**; startup repair **1 failed** |
| Reproduction of those five failures with verified-main server source | Same first failure in each group, same partial pass counts, fresh interpreter each; shared mock/transaction compatibility failures were not repaired or hidden |
| Existing SOS-transfer suite without real-Mongo opt-in in offline pass | **41 skipped**, not verification of its real transactions |
| First broad combined offline attempt | Timed out with mixed failures; discarded as pass evidence, then isolated by group |
| TypeScript | Existing `schedulingTracing.test.ts:68` TS2345 remains; no additional reported error |
| Changed confirmation-file ESLint | **0 errors, 12 warnings** |
| Python compilation and whitespace | Passed |
| Web preview smoke | Restarted and bundled; screenshot reached existing Important Notice gate. Signed-in deletion modal was not visually verified. |

The old location unit storage model initially did not supply the new adapter's
session interface, causing positive history assertions to fail. Its shared
test-only mock now supports that interface/session keyword arguments. No consent
predicate or assertion was removed or weakened; the actual persistence adapter
still runs in these unit tests. Real isolation/deletion behavior is established
only by the disposable Mongo cases, not this mock session.

Coverage does not include the three newly identified exact interleavings,
physical Android delivery, signed-in visual acceptance or legal compliance.
The current tests therefore cannot justify merging the incomplete draft.

## Initial database, privacy and delivery boundaries

No new collection, startup/production index, migration, backfill, historical
deletion, infrastructure setting or native dependency is introduced by the
current draft. It adds internal parent-member evidence counters and reuses
existing email identity counters; this is necessary private persistence
coordination, not a GPS/consent/publication change.

The private diagnostic transactions can add request latency; physical-device
performance has not been accepted. They do not authorize a stale fix, change its
capture timestamp guard or enable sharing. No SOS notification/acknowledgment,
emergency calling, native GPS/motion or Phase 2 scheduling policy was changed.
Provider reservation/settlement is deliberately not implemented pending approval.

No app-store/privacy-policy compliance assertion is made. Retained SOS policy,
minimal historical scope, shared diagnostic/security lifetimes, external billing
failures and already-in-progress delivery require truthful disclosure. The
confirmation copy is a partial correction, not evidence all transport windows
are safe.

Nothing has been merged, deployed, sent through live providers, changed in
production, built/uploaded for Android or released via OTA. Any eventual backend
and confirmation-copy delivery requires separate owner approval after all
Critical/High findings close. The required consolidated Phase 3 report remains
downstream, not replaced by this interim document.

## Approved correction: OTP identity and single consumption

Fresh OTP issuance stores a random credential identity, its original random
account ID (or explicit absence), and the mailbox deletion generation.
Verification locks that mailbox and validates identity, expiry, attempts and
the exact credential. Consumption checks `deleted_count == 1`; account creation,
invitation acceptance/family-code transfer and self-member repair share the
same transaction. Wrong-attempt counters and expiry cleanup commit before the
HTTP error is raised. Invitation acceptance pushes occur only after commit.

Deletion increments and retains a **hashed** mailbox lifetime fence rather than
removing it. This prevents a captured absent/present account operation from
mistaking a replacement identity for its original one. It contains the hash and
coordination counters, not email, name, tokens or care history. Authentication
links and invitation creation also compare the observed deletion generation.
Old OTP rows missing identity binding fail closed and require a fresh code;
there is no backfill that legitimizes an unbound credential.

## Approved correction: invitation writers

Create and resend now recheck the live account, family and authoritative owner
inside the existing family transaction/fence. Creation also locks the recipient
mailbox lifetime, rechecks membership/duplicate/cap rules and then inserts.
No cached owner check authorizes a late insert. Delivery separately validates
the exact still-pending invitation and live owner/family under a reservation.
Recipient deletion shares the mailbox barrier and removes outstanding
recipient invitations. Unrelated legitimate families/invitations are preserved.

## Approved correction: provider reservation and completion

`deletion_delivery` is a deletion barrier, **not a replacement scheduler or
general notification queue**. Immediately before a push/email provider call:

1. A short transaction makes real writes to the exact live recipient/subject
   account rows and/or hashed mailbox fence.
2. It validates source credentials/invitations where applicable and inserts a
   durable active attempt. Stable event keys suppress replay while that event's
   original attempt remains active.
3. The provider runs outside the transaction. A strongly retained, shielded task
   survives caller cancellation, including while synchronous email transport
   continues in a thread.
4. Only a real return from the provider call permits exact completion
   persistence. Deletion refuses active attempts using the same conflicting
   user/mailbox writes; completed attempt metadata for that identity is cleaned
   with account deletion.

Covered actual transports: generic user pushes (including DUE medication,
family fanout and welfare responses), verified medication escalation,
check-in outbox transport, explicit recovery refresh, welfare silent refresh,
email links, OTP background email, invitation create/resend email. No changes
to Expo/FCM payload generation, battery/GPS capture, native tracking, consent
publication, SOS emergency policy, quiet hours or medication/check-in timing.

Review found an additional **High** WIP regression: treating every `member_id`
as a profile ID suppressed default/self SOS, whose subject is a user ID.
The corrected reservation uses the exact persisted incident and explicit
user/member subject kind. Legacy self incidents use their original owner/user
identity without guessing from a missing profile; namespace collisions fail
closed. Real-route tests verify actual visible provider invocation for default
and explicit-member SOS and both resolution forms. Suppressed pushes report
zero rather than a cached device count.

### Interruption, retries and recovery limitations

There is intentionally **no timeout, TTL or expired-lease auto-unlock of active
attempts**. An expired lease cannot prove a paused worker or email thread has
stopped. Caller cancellation leaves the original task responsible for eventual
completion; failed completion persistence can be retried for that exact known
completed attempt without sending again. A real killed-process test confirms
the durable blocker survives and a new worker cannot replay the same event.

A crash, provider exception or database failure can leave deletion blocked for
manual delivery review. Do not clear a blocker merely because it is old.
Recovery of a genuinely unknown call requires verified termination/quiescence
of its original worker and reviewed provider evidence. No public bypass,
automatic reconciliation job or production recovery mutation is introduced or
executed by this work. This availability tradeoff must be accepted before
release. Provider acceptance/display and app-call completion remain distinct:
previously authorized work can arrive after deletion even when its call ended.

## Migration/index and eventual rollout implications

- Adds `deletion_deliveries` with MongoDB's intrinsic unique `_id`, opaque attempt
  IDs, random account IDs, hashed mailbox/event identities, state and timestamps.
  No raw address, push token, message body, OTP or coordinates are stored there.
- Adds internal account delivery counters, mailbox deletion generations and a
  persisted SOS subject-kind discriminator; supports conservatively classified
  legacy SOS records. No historical rewrite or destructive migration.
- No new startup index, backfill or migration is automatically run. Functional
  local tests use only the intrinsic attempt `_id` index. Before significant
  production volume, separately approve additive non-unique indexes on
  `(state, user_ids)`, `(state, email_hash)` and `(state, operation_key)`; otherwise
  completed-history growth causes scans and can affect deletion/send latency.
  Active attempts must never be TTL-expired. No retention policy for unrelated
  records is changed.
- Mixed old/new workers are not safe deletion certification: old workers can
  hold tokens or credentials without reservations. Eventual rollout must drain
  all old application/scheduler workers and in-progress provider calls before
  treating the new deletion guarantee as active. That is a future approved
  deployment procedure, not an action taken here.
- No billing implementation, native dependency, OTA, AAB, Play configuration,
  provider configuration or production database/index change was performed.
  Physical Android behavior and signed-in visual acceptance remain unverified.
- The extra short reservation transactions depend on database availability and
  may add send latency, including to SOS fanout. Provider calls never hold a
  transaction open, and the existing emergency priority/quiet-hours exceptions
  remain intact; physical-device latency has not been accepted here.

## Verification incident

One historical SOS HTTP suite was mistakenly included in an otherwise offline
batch. Its first test attempted one POST to the configured remote `/api/sos`
using its embedded legacy credential. The response was **401 Invalid or expired
token**; execution stopped at that first failure, before its SOS handler and
before its database cleanup fixture. It is not passing verification, and no
live SOS/provider send was authorized. No production query was made to claim
independent side-effect verification.

The incident was disclosed immediately. Subsequent batches explicitly load
`backend/tests/loopback_guard_plugin.py` before collection, in addition to
synthetic provider/billing stubs and owned disposable databases. That guard
prohibits non-loopback TCP during imports as well as test execution.

## Independent approved-scope review

1. Initial independent review: **FAIL**, three High findings (OTP, invitations,
   unreserved external sends).
2. First approved-scope WIP review: **FAIL**, one additional High self-SOS
   user/member-namespace regression in the new reservation.
3. Follow-up independent code review: **PASS**, all four High findings explicitly
   **CLOSED**, no additional concrete Critical/High defect found. The reviewer
   inspected implementation and regression tests independently. Their attempt
   to run the focused Mongo suites was blocked by review-shell filesystem
   permissions before fixtures could start; no independent runtime pass count
   is claimed.
4. Final independent security/data-integrity/evidence review: **PASS**; all four
   High findings remain **CLOSED**, no unresolved Critical/High in the reviewed
   scope. The reviewer inspected the retained run logs, verified the
   `121 + 96 + 42 + 277 = 536` accounting and independently reran collection to
   confirm the 96-test passing prefix. They approved the test-adapter corrections
   as accurate fresh-issuance/transaction fixtures, not assertion weakening or
   security bypasses. They did not independently rerun the passing suites.

The reviewer explicitly confirmed that unknown interrupted sends remaining
blocked meets the approved fail-closed scope, not an unattended-recovery
guarantee. No review verdict is permission to merge, deploy, change production
indexes, publish OTA or build/upload Android.

## Final guarded verification

Implementation commit: `bc0c0465` (subsequent test-adapter/evidence updates do not
change production logic). GitHub `main` was rechecked and remains
`56b0d7634e5cf3131c3f972fe0971f5f8d11cf67`.

| Check | Final result / boundary |
| --- | --- |
| Deletion, coordination, email-link Mongo and family-write-fence suites | **121 passed** in one completed guarded run |
| Invitation-removal, medication-midnight Mongo, check-in scheduler and rotation | **96 passed** as the complete first four suites of the safety batch; a later refresh test stopped that batch |
| Refresh authorization/evidence and real-Mongo SOS priority | **42 passed** in the final completed guarded run after correcting the refresh storage fixture |
| Distinct guarded tests across these integration/focused groups | **259 passed**; do not add preceding partial-run pass counts again |
| New tests in this correction | **25 coordination tests**, in addition to the existing draft's **48 deletion/race tests**; all **73** are included in the 259, not additive |
| Fresh-process guarded offline groups | Email links **59**, optional-location SOS **7**, consent writes **11**, family-snapshot privacy **51**, location history **32**, pipeline **40**, refresh trace **32**, medication reliability **34**, device presence **11**: **277 passed** |
| Overall distinct targeted checks above | **536 passed**; not a full-repository green claim |
| Python compilation / whitespace | Passed for changed application/test modules; no dependency changes |
| Preview | Restarted, compiled, screenshot reached existing Important Notice; signed-in deletion and Android UI/delivery not verified |

The 96-test group count was independently collected to identify the passing
prefix exactly. Earlier combined attempts stopped at **100**, **125**, **139**
and **124** passes respectively because old AST/storage test adapters did not
yet model the helper extraction and bound-credential contract. These are not
additional pass counts. The adapters now execute both actual OTP functions and
issue credentials bound to the actual present/absent account and mailbox
generation, matching fresh issuance. Repeated fixture issuance replaces the
email's current credential, matching the route rather than accumulating
duplicate synthetic rows. Original transaction/authority assertions were kept.

The relay-sanitization test previously used a nontransactional fake database.
It now runs the **actual** authority lookup, reservation, provider stub and
private-evidence persistence against owned Mongo; the safe-field assertions are
unchanged. It explicitly requires the real-Mongo opt-in instead of pretending a
collection-only mock establishes transaction behavior.

All final groups loaded the precollection loopback prohibition. The separate
historical rejected remote test described above is excluded from these counts.
Run logs and the preview image are retained locally in `generated-artifacts/`;
they are intentionally excluded from Git and deployment uploads.

Baseline full-repository failures, including the previously reported TypeScript
error and five legacy offline transaction/mock groups, remain outside this
correction. No new full-repository or physical-device certification is claimed.
No source or assertions were changed to hide those baseline failures.

## Consolidated Phase 3 assessment follow-up

The subsequent readiness review found that the account-page danger hint still
promised removal of “all associated data,” despite the modal's qualifications.
The hint now qualifies retained resolved SOS and minimal security records. The
modal additionally explains that unknown notification/email attempts can delay
deletion pending review, and that hashed security records prevent old credential
reuse. These are copy-only corrections, not changed cleanup or recovery policy.

Two new frontend disclosure checks passed. Independent follow-up review is
**PASS**, no new Critical/High; all four prior High closures remain valid.
The reviewer inspected the assertions but did not independently rerun them.
This is **536 prior targeted checks plus 2 new copy checks**, not a claim that
the 536 backend/offline checks were rerun for a text-only change. Rendered
signed-in UI and physical Android acceptance remain separate gates.

### Current merge/release boundary

Read-only Railway inspection confirms the live backend-root service is connected
to GitHub `main`, with source check-suite waiting disabled. A main-branch merge
may therefore trigger a deployment. Before approving any merge, establish a
separately approved deployment hold or coordinated rollout; no Railway setting
was changed here. Unknown-send recovery and old-worker draining remain mandatory
operational decisions, not capabilities added by documentation.
