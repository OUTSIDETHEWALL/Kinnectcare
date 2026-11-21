---
name: Google billing ownership
description: Owner-approved billing architecture and boundaries for RevenueCat adoption.
---

Use RevenueCat for Google Play subscriptions without migrating existing Stripe
customers. Kinnship's backend remains authoritative for Family Plan access.
Google purchases stay with the original Kinnship purchaser; restoration must not
silently move billing ownership to a different Kinnship account.

**Why:** The owner approved RevenueCat to simplify development and ongoing
subscription maintenance while explicitly requiring preservation of existing
customers and secure original-purchaser ownership.

**How to apply:** Maintain independent provider grants and combine access through
the existing family rules. Send no sensitive family, SOS, medication or location
data to RevenueCat. Code/tests/PR approval does not authorize live billing
settings or credential activation, merges, deployment, OTA, or production Android
builds. Obtain separate approval for those actions.

The connected RevenueCat account alone is not evidence of a configured Google
app, original-owner restoration policy, valid store credentials, Android native
compatibility, or accepted test purchase. Treat these as separate evidence gates.

**Why:** A newly connected project can contain only a Test Store, while live
Google verification and restored ownership still depend on external setup.

**How to apply:** Verify settings independently before activation; never mark
Play acceptance passed from Test Store, mocked SDK, or backend-only tests.
