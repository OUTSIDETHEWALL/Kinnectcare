---
name: Email-link onboarding security
description: Product scope and security tradeoffs for replacing onboarding code entry
---

Onboarding should require no OTP entry or manually typed invitation codes, and
must remain simple for older adults and caregivers. The owner reported Build 81
passed its GPS road test; invitation fixes must stay separate from changes to
GPS tracking, Transistorsoft SDK configuration, SOS, and medications.
Preparing a new Android test build does not authorize production
backend deployment or OTA publication.

**Why:** The owner explicitly requested the replacement while retaining identity
verification, family-location privacy and separate release approval.

**How to apply:** Keep invitation context separate from identity proof. A
forwarded invitation must not authenticate its holder as the recipient or
silently move an existing account between families. Prefer a fresh mailbox
confirmation tap to a claim of unrestricted one-tap acceptance. Explain this
tradeoff and distinguish compiled artifacts from end-to-end Play acceptance.

Android domain verification needs the Google Play **app-signing** certificate,
not merely the EAS/upload certificate. Installation attribution is optional
context, never authentication authority.

**Why:** Treating either an upload signature or a remembered email address as
proof can produce convincing but invalid onboarding/security claims.

**How to apply:** Preserve secure reopen-email recovery when deferred attribution
is unavailable. Never report verified App Links or Play-install success from
source declarations or unit tests alone.

An invited installation is not necessarily a new account. Resume a saved,
unconsumed invitation after first-install permission screens and sign-in
recovery, instead of treating a successful login as completed family joining.
New invited profiles must never be offered independent family creation.

**Why:** A returning account on a fresh onboarding path can still require
explicit family-transfer confirmation after authentication. Permission-screen
completion must not bypass that outstanding invitation.

**How to apply:** Preserve authenticated transfer confirmation and transactional
membership/role creation before invitation acceptance. Keep unrelated protected
actions out of invitation redirects; validate the real root and permission-screen
handoff, not only the token helpers. Never silently repair a live account.
