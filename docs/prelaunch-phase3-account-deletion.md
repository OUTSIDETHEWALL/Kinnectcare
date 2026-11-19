# Phase 3B — account deletion investigation and incomplete draft

## Status: blocked, not a completed correction

**Independent review: FAIL; three unresolved High findings. Do not merge or
deploy.** The owner authorized minimal account-deletion corrections but requires
approval before architectural changes. A shared outbound-work reservation and
settlement boundary would affect notification/email paths. That portion is
paused for approval; no such new subsystem has been implemented.

The retained OTP and invitation findings also remain open. No follow-up review
or complete account-deletion certification is claimed. Phase 3C retention and
the consolidated final report have not started.

Baseline GitHub main: `56b0d7634e5cf3131c3f972fe0971f5f8d11cf67`.
Dedicated branch: `fix/account-deletion-care-records`, stacked on rotation draft
#199's branch at `496cc5d4cd7d0bab17d841ad04427c1327661b54`. The parent PR is
still unmerged; platform task completion is not GitHub merge evidence.

Incomplete [draft PR #200](https://github.com/OUTSIDETHEWALL/Kinnectcare/pull/200),
initial WIP implementation/evidence commit
`981913cfaa84faf501f994a1e593a7107b88d230`. Its explicit base is
`fix/family-code-rotation-security`, not `main`. The PR records all three open
High findings and must remain draft/unmerged pending approval and closure.

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

## Relationship and writer inventory

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

## Independent review findings

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

## Verification so far

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

## Database, privacy and delivery boundaries

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
