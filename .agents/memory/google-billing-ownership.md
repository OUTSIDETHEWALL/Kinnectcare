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

Purchase availability, reconciliation, and emergency denial of Google-derived
access are separate controls. Disabling new purchases must preserve legitimate
verified paid access and existing Stripe checkout during the transition.

**Why:** The owner explicitly authorized this separation to avoid removing paid
access or preventing Android subscriptions during staged activation.

**How to apply:** Require an explicit two-sided rollout for Google checkout and
never fall back to Stripe after a Google purchase starts. Provider management
must remain truthful for legacy clients; a UI-only restriction is insufficient.
Use bounded, non-interactive recovery after authentication, never as a prerequisite
for core startup or emergency/tracking functionality.

Initial Google purchase activation is tester-only: require both an approved
Kinnship account and approved current family, while everyone else retains Stripe
checkout. Do not treat a sandbox environment selection alone as rollout scoping.

**Why:** The owner explicitly requires a genuine Play license test without
disrupting existing Stripe customers or exposing checkout to other accounts.

**How to apply:** Keep approval on the backend's advertised checkout and purchase
identity response. Do not use purchase allowlists to revoke existing verified
production access, and obtain a separate review before any public expansion.
