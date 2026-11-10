# Email-link onboarding — review and release boundaries

## Baseline and diagnosis

The verified completed Android baseline is Build 78, EAS build
`ed95444c-364a-4914-9d60-a2f1326c79f6`, source
`37c5610c668252adca3636926d1fe80c96cbec0c`, runtime
`1.3.1-diagnostic78`. The implementation branch retains that baseline.
The subsequent local baseline commit contains only documentation/asset metadata.

**High severity, high confidence:** the previous production investigation found
that a deleted account was sent through login. Unknown-account login returns
generic HTTP 200 before generating, storing or submitting an OTP email.
Successful HTTP responses were therefore not evidence of delivery. Family
membership removal and account deletion are separate operations. Uninstalling
does not delete an account. Who invoked the deletion, and which navigation step
selected login, were not established.

**High severity, high confidence (source evidence):** authentication purpose and
invitation context were separate client state. The old session acceptance path
also treated an arbitrary existing member role as sufficient evidence of the
intended family. The replacement never infers the target family from a role or
an email-address match.

The previous Android configuration had no verified HTTPS intent filters.
Google Play Install Referrer was already linked and bounded against startup
hangs; it is retained rather than adding a new attribution service.
An ordinary deep link is not deferred-install attribution.

## Implemented flow

- Sign-in and independent account creation use email links, not code entry.
- Signed-out invitation acceptance sends a fresh link to the original invited
  mailbox. The server, not client input, chooses that recipient.
- Invite email tokens now have 256 random bits. Authentication tokens have
  256 random bits, are stored hashed, expire after 15 minutes, and are consumed
  once inside a MongoDB transaction.
- Authentication links require the random proof stored on the requesting phone.
  A forwarded invitation is context, not identity proof. A forwarded sign-in link
  cannot authenticate another installation. This deliberately adds a mailbox
  confirmation tap for signed-out invitees rather than allowing account takeover.
- Tokens are carried in URL fragments, not server request paths or queries.
  Landing-page GETs and email scanners do not redeem anything.
- The root listener captures warm callbacks before their route mounts; relying
  only on the leaf screen's initial URL loses already-running-app events.
- Unknown/deleted accounts receive a real email. Only after email proof does
  independent account creation ask for a name and explicit new-family intent.
  Deleted history is not restored or name-matched to a new account.
- New invited accounts, their family assignment, invitation consumption, and
  consent-disabled self-member creation commit together or roll back together.
- Existing accounts keep their identity, session behavior and entitlements.
  New account insertion also uses the same intrinsic per-email database key
  in both the retained OTP and email-link paths, preventing cross-protocol
  duplicate account creation. Public account IDs remain fresh random IDs.
  Changing family requires an authenticated confirmation of the intended and
  previous family. Owners of populated families cannot silently abandon them.
  Another person's linked records are not transferred merely because the
  accepting caregiver owns those records.
- The authoritative invite is revalidated during acceptance, including recipient,
  expiry, revocation, inviter authority and target family.
- Existing accounts deleted/recreated after a sign-in link was issued cannot use
  that old link to access the replacement identity.
- The original prominent Android disclosure and permission coordinator remain.
  Setup now additionally requires an explicit location-sharing choice; granting
  OS permission alone does not enable sharing. New linked rows start sharing off.
- Old saved code-screen navigation goes to email-link recovery. Optional PIN
  recovery also uses links. Old server OTP endpoints remain for Build 78
  compatibility; no OTA is being published.
- App Links declare only the known backend host and invitation/authentication
  paths. The backend exposes Digital Asset Links using the **Play app-signing**
  SHA-256 fingerprint; missing configuration returns 503, not a fabricated
  verification assertion. The upload-key fingerprint is not a substitute.
- Play's existing Install Referrer carries only invitation context. If it is
  unavailable, reopening the original invitation email securely resumes the
  flow without typing codes. Authentication tokens are not install referrers.

## Automated evidence

- Backend: **163 passed** across email-link endpoint/security/rollback,
  membership, family authorization, medication occurrence reliability, SOS,
  subscription webhook reconciliation, check-in privacy and family diagnostics
  privacy suites.
- Frontend: **212 passed**, 12 suites, including real callback-screen cold and
  warm handling, device proof, startup restoration, referrer/consumed-invite
  handling, real root/permission recovery, explicit consent, SOS and medication
  notification routing.
- Android JavaScript/Hermes export completed successfully.
- Python compile checks passed.
- Focused lint had no errors; existing permission/invitation warnings remain.
- Full TypeScript checking still reports the pre-existing test-only mock
  signature error in `src/__tests__/schedulingTracing.test.ts:68`.
  No new application type errors were reported. This is not a clean full
  typecheck and must not be reported as one.

## Native build compatibility correction

The first Build 79 attempt failed: the pinned GitHub Hermes archive now unpacks
under `meta-hermes-…`, while React Native's existing extraction predicate only
recognized `facebook-hermes-…`. Direct inspection of the downloaded pinned
archive confirmed the new root name. The Gradle failure was a missing top-level
`CMakeLists.txt`, not an onboarding JavaScript failure.

The diagnostic source-build plugin now recognizes both observed prefixes. It
does not change the Hermes pin, compiler, native APIs or release process.
Idempotency, exact limited replacement and fail-closed anchor tests cover this
compatibility correction. Build 78 remains untouched.

## Boundaries and remaining acceptance work

No production database, running backend configuration, backend deployment,
OTA, Play submission, phone installation or signing credentials were changed.

The endpoint tests use an isolated transaction fake. They test atomic-operation
ordering, rollback, replay, concurrent simulated redemption and security
predicates; **they do not establish actual Atlas transaction-conflict behavior**.
There is no non-transactional fallback: a database without transaction support
fails instead of partially creating an account.

No real verification email was sent by this development session. Provider
acceptance is reported explicitly by the request endpoint, but receipt in a
physical mailbox, email-client fragment preservation and tap behavior still need
authorized end-to-end testing.

The new Android build uses the existing production EAS profile/channel and
package `app.kinnship.client`, with version code **79** and separate runtime
`1.3.1-diagnostic79`. It does not publish or replace a Build 78 update.
Build preparation is not proof of Google Play installation, verified domain
association, data-preserving upgrade or signed-in family-dashboard behavior.

**Fresh onboarding in Build 79 cannot work against the unchanged production
backend**, which does not yet expose the new endpoints. Do not present the
bundle as end-to-end ready until separately approved backend activation,
real Play signing-fingerprint configuration and device testing are complete.
No staging backend or alternate release workflow was introduced.

Required physical acceptance after approval:

1. Confirm Atlas transactions on an isolated approved test dataset, including
   concurrent acceptance, revocation, interrupted responses and retry recovery.
2. Confirm the public Play app-signing fingerprint, HTTPS asset-links response
   without redirects, and `adb shell pm get-app-links app.kinnship.client`
   showing the backend domain as verified.
3. Test the Play-installed bundle, not a sideload, for fresh install with referrer
   capture and separately with referrer unavailable/reopening the invitation.
4. Test invitation and sign-in taps from real email clients with the app
   terminated and already running, including request on another installation.
5. Test independent registration, existing session/entitlements, deleted account
   recreation, forwarded/wrong-recipient/expired/revoked/multiple invitations,
   explicit family transfer, permission denials and explicit sharing off/on.
6. Confirm the working intended-family dashboard and real-device SOS, check-ins,
   medication notifications/escalation, background GPS and startup behavior.

An extra mailbox-confirmation tap and same-requesting-phone links are deliberate
security constraints, not a promise of unrestricted one-tap bearer login.
