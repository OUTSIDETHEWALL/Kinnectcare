# Senior-friendly family invitations — review only

## Authorization and scope

Code, local tests, and a review-only pull request were authorized. Merging,
backend deployment, OTA publication, AAB generation, and production family-data
changes were not authorized and were not performed.

GPS, SOS, medication behavior, permissions implementation, and Transistorsoft
configuration are unchanged. Existing transactional invitation acceptance and
ownership/privacy safeguards are retained.

## Diagnosis and changes

Severity: **High** for onboarding friction; confidence **high** in the identified
code paths. The exact historical phone error remains unproven.

- The old email had only an acceptance button. It now has exactly two prominent
  buttons: **Download Kinnship** and **Join [Inviter]'s Family**. Installed users
  skip downloading; new installations return to the same invitation email.
- The browser bridge previously attempted the custom scheme and automatically
  redirected to Google Play on a timer. It now offers explicit Open/Download
  actions and clear return-to-email instructions. GET does not redeem anything;
  responses prohibit caching, referrer disclosure, and external page resources.
- Delivery failure previously instructed the caregiver to share a code manually.
  Both invitation forms now report failure honestly and offer resend. Resend
  keeps the original token, expiry, recipient, and assigned role; it does not
  revoke earlier emails. An atomic one-minute claim prevents concurrent resend
  taps from sending multiple emails.
- An already authenticated installation on the sign-in screen resumes its
  invitation without requesting another verification email. Opening an old
  sign-in email retains the current secure identity and resumes the pending
  invitation or dashboard, rather than replacing accounts.
- Invitation context is resolved before showing independent-family creation
  fields. Existing profile-completion and real root/permission handoff coverage
  enforce joining the intended family rather than creating a separate family.
- Signed-in family transfers retain explicit confirmation and the existing
  transactional join. The confirmation explains movement of only the user's
  own records, retention of other family records, and the existing sharing-off
  behavior. This PR does not change that behavior.
- A pending invitation confirmed by an already-current member no longer
  overwrites later caregiver role/relationship edits. New members and
  transferring users still receive the invitation's assigned role.
- Repeated join taps are guarded immediately, and transient verification
  failures offer Try again without discarding the invitation. Terminal errors
  retain a working exit. Read-only current-membership recognition still sends
  existing members to the dashboard without replaying a transfer.
- Successful email-session cleanup clears only the matching invitation, not a
  different invitation saved concurrently.

## Security boundaries

An invitation supplies family context, not mailbox identity. Signed-in users do
not need another email. Signed-out users without independent identity proof
still need a device-bound secure email sign-in tap. Removing that proof would
allow forwarded invitation links to become account-access credentials.

The server resolves the invited mailbox; invitation forwarding does not choose
another account. Existing-account transfers require explicit authenticated
confirmation. Membership, assigned role, and invitation consumption remain in
one MongoDB transaction; failures roll back, and accepted retries do not replay
roles or repeat a transfer after the account has moved elsewhere.

No schema/index migration, automatic production cleanup, identity merge, new
authentication provider, or release workflow is introduced.

## Read-only production findings

The invited user's current account belongs to the intended owner's family,
with one linked self-member record and the `family` care role.

The newest matching invitation was still pending at inspection. No accepted
invitation was attributed to the current account. Older accepted invitations
for the same mailbox do not prove acceptance by this account. Manual joining
with another family-entry path is a possible explanation; these observations
do not authorize relinking, rejoining, or marking any live invitation accepted.
**The original invitation cannot be certified as properly consumed.**

Railway confirmed the previous invitation-recovery commit as successfully
deployed. In the bounded November 15, 2026, 23:09–November 16, 00:00 UTC window:

- Public invitation preview: 19 POSTs, all HTTP 410, between 23:20:18 and 23:32:40.
- Authenticated-status path: HTTP 404 at 23:09:22, HTTP 403 at 23:09:32,
  and HTTP 410 at 23:34:30.

The public handler intentionally returns 410 for unavailable invitations, and
the client maps that response to the inactive-invitation screen. Proxy logs do
not identify the invitation token, authenticated account, device, or rendered
screen. They cannot attribute these calls to the affected phone. Nor does OTA
publication establish phone activation.

**Conclusion:** an old/revoked link or a launch without the new active OTA is
consistent with the evidence, but not proven. An inactive response is expected
for an inactive link; incorrect rejection of a signed-in current member would
be a defect. The available evidence cannot choose between them for that launch.
Confidence in the specific historical cause is **limited**. No live records
were changed to make the findings appear resolved.

## Android App Links: partial verification, release check outstanding

The live `/.well-known/assetlinks.json` returned HTTP 200 and declared
`app.kinnship.client` with fingerprint:

`26:14:C3:5A:E5:5A:E2:C0:41:55:8B:7D:00:C0:BE:E6:91:84:72:F5:2D:3F:CE:70:B7:C8:E7:53:61:D0:2F:0F`

Source configuration declares HTTPS `/invite/` and `/auth/email-link` handlers
on the same backend host with Android auto-verification.

**Not verified:** equality with Google Play's actual app-signing certificate.
A read-only Publisher API check could not proceed because the saved
service-account secret was not parseable as usable credentials. No credential
values were displayed or saved. No new integration or publishing automation
was introduced. Upload/AAB certificate evidence is not a substitute.

Before release, compare that fingerprint with Google Play Console's **App
integrity → App signing key certificate → SHA-256** (not the upload certificate),
including any applicable rotated signing key. Then confirm verified domain
status on the actual Play-installed binary and tap a real invitation from the
phone's email app. Mail clients or user link settings can still require the
explicit browser fallback.

**Native changes:** none in this PR. HTML/backend changes require an approved
backend release; compatible JavaScript changes could use an approved OTA.
Changing host/path intent filters, native linking configuration, package ID,
or native dependencies would require a separately approved new AAB. Publishing
the correct certificate association alone is a server configuration change,
not an AAB change.

## Verification

- **178 frontend tests passed across 12 suites:** invitation screens, both email
  callback/sign-in recovery paths, delivery/resend forms, durable pending and
  consumed markers, install-referrer handling, real root/permission handoff,
  family-role permissions, location disclosure, and SOS permission regressions.
  Jest used the existing `--forceExit` workaround for open handles; this is not
  evidence that the unrelated test-runner shutdown issue is fixed.
- **73 backend/template tests passed:** email identity boundaries, new/existing
  users, role preservation, read-only status recovery, ownership restrictions,
  failed delivery/resend, expiration/revocation, throttling, and escaping.
- **16 real MongoDB integration tests passed** against a disposable loopback
  replica set with synthetic data only: transactional rollback, concurrent
  acceptance/redemption, retries, assigned roles, existing records and later
  role edits. No production URI is used by these integration tests.
- Python compilation and `git diff --check` passed.
- Full TypeScript checking remains blocked by one pre-existing error in
  `src/__tests__/schedulingTracing.test.ts:68` (Jest callback tuple typing).
  Its identical source exists on the base branch; unrelated tracing code was
  not changed. No invitation-file errors remain in the check.
- The web preview starts and renders the initial disclaimer at a phone-sized
  viewport. The fresh browser cannot reach signed-in UI; the changed signed-in
  screens were **not visually verified**. Component tests are not physical
  Android/App Links acceptance.

Reproduce:

```sh
cd frontend
npm test -- --runInBand --forceExit --runTestsByPath \
  src/__tests__/invitationDelivery.test.tsx \
  src/__tests__/inviteTerminalNavigation.test.tsx \
  src/__tests__/emailSignInInvitation.test.tsx \
  src/__tests__/emailLinkCallback.test.tsx \
  src/__tests__/emailLinks.test.ts \
  src/__tests__/pendingInviteConsumed.test.ts \
  src/__tests__/pendingInviteCancellation.test.ts \
  src/__tests__/installReferrerInvite.test.ts \
  src/__tests__/rootLocationPermissionRecovery.test.tsx \
  src/__tests__/familyRolesPermissionsContract.test.ts \
  src/__tests__/onboardingLocationDisclosure.test.tsx \
  src/__tests__/sosPermissionRegression.test.tsx
npx tsc --noEmit --pretty false
cd ..
PYTHONPATH=backend:backend/tests python -m pytest \
  backend/tests/test_email_links.py \
  backend/tests/test_invitation_resend.py \
  tests/test_invitation_presentation.py -q
KINNSHIP_RUN_LOCAL_MONGO_TESTS=1 PYTHONPATH=backend python -m pytest \
  backend/tests/test_email_links_mongo_integration.py -q
```

## Manual acceptance before release approval

Use authorized disposable test accounts, not existing family records.

1. Confirm the actual Play signing fingerprint and Android verified-link status.
2. Installed, securely signed-in invitee: original email opens the app, no second
   verification mail, explicit confirmation before a family change, correct role.
3. Fresh Play installation: Download, install/open, return to the same email,
   Join, mailbox proof only if needed, correct family/role without family creation
   or manual invitation entry.
4. Interrupt at authentication and permissions, close normally, reopen, and
   confirm the same invitation resumes.
5. Reopen a completed email as a current member: dashboard, no duplicate member
   or transfer. Verify a signed-out user can sign in without identity replacement.
6. Expired/withdrawn link and offline check: clear explanation, working exit;
   temporary failure retries in place. Resend preserves earlier valid emails.
7. Verify large text/small-screen readability and the two email buttons in Gmail
   and the Samsung email/browser combination.

Stop after PR review. No merge, release, AAB, or production repair is authorized.
