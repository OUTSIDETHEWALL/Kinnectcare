---
name: Email-link onboarding security
description: Product scope and security tradeoffs for replacing onboarding code entry
---

Onboarding should require no OTP entry or manually typed invitation codes, and
must remain simple for older adults and caregivers. Build 78 is a protected
baseline; preparing a new Android test build does not authorize production
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
