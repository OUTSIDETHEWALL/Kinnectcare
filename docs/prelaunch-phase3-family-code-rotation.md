# Phase 3A — family-code rotation and invitation preservation

## Scope and verified baseline

Owner-authorized Phase 3, first correction only. GitHub main was verified at
`56b0d7634e5cf3131c3f972fe0971f5f8d11cf67`, including owner-merged PRs #196,
#197 and #198. Dedicated branch: `fix/family-code-rotation-security`.
Account deletion and SOS retention remain separate sequential tasks; existing
retention draft #190 was not modified.

## Root cause, severity and correction

**High — core family administration broken; high confidence.**
The existing client calls POST `/api/family-group/regenerate-code`, but the
corresponding nested handler had no route decorator. Actual server router
assembly returned HTTP 404. The new regression against verified-main backend
source reproduces that 404; the corrected source passes.

The dormant implementation also checked ownership and replaced the code in
separate, unfenced operations. Simply registering it would expose an
administrative write without the transaction boundary already used by family
admission.

The correction:

- Register the existing client URL; no frontend behavior or API response
  contract change.
- Read the account's current family from storage, not a retained authentication
  snapshot or cached owner role. Missing identity/setup fails explicitly without
  creating a family or modifying membership.
- Acquire the existing family transaction fence and recheck current membership
  plus authoritative `family_groups.owner_user_id` inside the transaction.
- Generate and save the replacement wall code within that transaction. The
  response is returned only after commit; failures roll back the fence and code.
- Leave memberships, care records and recipient-specific INV tokens unchanged.
  Valid recipient invitations do not need reissuing after wall-code rotation.
- Use read-only authentication for this route. The existing JWT verification and
  authoritative user lookup were extracted without changing normal
  authentication's provisioning/state sequence. All other routes retain their
  existing dependency; missing/dangling rotation scope cannot silently create a
  new family before the handler runs.

This is a necessary administration/admission coordination change, not a family
transfer redesign. Admission and retained OTP code paths are unchanged and are
tested against the same fence. A join committed before rotation remains valid;
an old-code request paused before admission loses to an already committed
rotation and cannot move or create an account.

## Tests and limitations

All integration storage is an owned disposable MongoDB 7 replica set with
synthetic records. No production URI is read by the integration fixtures.
The new suite blocks non-loopback socket connections and uses no live
mail/push callbacks. Offline suites ran in fresh processes with sockets blocked.

| Check | Result |
| --- | --- |
| New real Mongo rotation suite | **29 passed** |
| Existing email-link, invitation-removal, family-fence and Phase 2 check-in Mongo suites | **113 passed** |
| Email-link offline suite | **59 passed** |
| Invitation resend offline suite | **9 passed** |
| Optional-location SOS offline suite | **7 passed** |
| Refresh authorization offline suite | **8 passed, 21 skipped** |
| Refresh trace-consent offline suite | **32 passed** |
| Device-presence offline suite | **11 passed** |
| Existing family-role/reminder-permission suite | **3 failed**, identical with verified-main family backend source |
| New route regression against verified main | Expected failure: **HTTP 404**, corrected source passes |
| Python compilation and whitespace | Passed |

New coverage includes real server family-router registration and client URL,
successful replacement/response consistency, old/new preview and admission,
unchanged records/invitations, authoritative ownership despite cached roles,
scope changes/removal/deletion while waiting, setup without auto-creation,
concurrent rotations, both admission/rotation orderings, retained OTP new/existing
accounts, rollback, active-code generation collisions, retained session scope,
recipient acceptance during rotation, and invalid invitations staying invalid.
Seven final cases additionally execute actual authentication and router
registration with synthetic signed JWTs: missing/dangling family without
mutation, ordinary legacy GET provisioning preserved, signed-owner success,
and missing/invalid/expired/deleted identity rejection. The final combined real
Mongo run passed **142 tests (29 + 113)**; offline checks passed **126**.

The three existing permission tests use storage doubles without a transaction
client; the same failures reproduce against verified main. They were not fixed,
hidden, deleted or weakened. These counts do not claim whole-repository green.
No frontend code changed, so frontend/type checks were not rerun; no configured
Python lint tool is claimed. No Android physical test or signed-in visual
acceptance was performed.
Web smoke capture reached the existing Important Notice gate without a crash;
it did not inspect the signed-in family screen. No production backend was
started for preview testing.

Concurrent rotation is serialized, not idempotent: a later successful owner
rotation replaces the code returned by an earlier one. Only the final code
remains active. Existing valid memberships are not undone by later rotation.
The existing random-code generator and current-code collision checks are
preserved; this is not a new permanent historical-code registry.

## Independent review

Initial **FAIL**: one Medium finding, no Critical/High in the rotation
transaction. Shared authentication automatically created/backfilled a family
before entering the handler for missing/dangling scope. Synthetic authentication
in the first tests did not expose that real-dependency behavior.

Closed with the narrowly scoped read-only rotation authentication described
above and seven actual-authentication regression cases. Follow-up **PASS**:
no remaining Critical, High or Medium findings in the scoped correction; high
confidence in inspected implementation.

The reviewer independently passed whitespace, in-memory Python compilation and
AST equivalence checks proving unchanged JWT/user lookup and unchanged ordinary
authentication provisioning/state sequence. It inspected the full final tests
but could not run Mongo: its read-only shell blocked disposable server-log
creation. The **142 integration passes are implementer execution evidence**,
not reviewer-reproduced passes. The verdict does not certify release readiness.

## Database, privacy and delivery implications

No new collection, schema migration, startup index or production index change.
Uses existing MongoDB transaction support and family fence metadata. No
destructive migration, backfill or historic invitation cleanup.

No added personal-data retention or payload fields. Rotation does not expose
member data, authenticate an invite holder, revoke legitimate recipient links
or alter privacy/consent. Existing recipient identity proof, removal invalidation,
transactional transfer, location-sharing defaults and Phase 2 scheduling remain
unchanged.

Only the active `backend/` family route, necessary server authentication
extraction/wiring and focused tests are changed; the stale root backend copy is
not the deployment target. No SOS persistence,
notification, acknowledgment, location/fallback/dialer, GPS/motion, medication,
check-in scheduling or billing implementation was modified. Normal onboarding
and authentication behavior is preserved; the necessary shared-helper extraction
was explicitly explained and independently reviewed.

Eventual delivery requires an owner-approved backend deployment only. No OTA,
native dependency, permission, AAB, infrastructure or Railway configuration
change is required by this correction. Merge and deployment remain unauthorized.

## Delivery evidence

[Draft PR #199](https://github.com/OUTSIDETHEWALL/Kinnectcare/pull/199), branch
`fix/family-code-rotation-security`, base
`56b0d7634e5cf3131c3f972fe0971f5f8d11cf67`.
Reviewed implementation commit:
`1feaee3753b7553b2851f7bc471de18e064bba3f`.
The subsequent documentation commit records this evidence and does not change
the reviewed implementation.

Account deletion and SOS retention/reporting are already queued downstream;
no duplicate follow-up scope was proposed.
No agent merge, deployment, production database/configuration change, live
invitation/push/call, OTA or Android build/upload was performed.
