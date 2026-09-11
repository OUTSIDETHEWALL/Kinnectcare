---
name: Stripe entitlement webhook reconciliation
description: Durable compatibility and retry rules for Kinnship subscription entitlement webhooks.
---

Subscription-created and subscription-updated webhooks must retrieve Stripe's current subscription before persisting entitlement. Webhook delivery order is not authoritative: a delayed `incomplete` payload must never overwrite a subscription that Stripe currently reports as active.

The pinned Stripe Python SDK exposes `to_dict()` and `_to_dict_recursive()` on retrieved Stripe objects, not `to_dict_recursive()`. Tests for this path must include a real SDK-constructed subscription object rather than only plain dictionaries.

MongoDB entitlement writes must verify that exactly one user matched. Missing signing configuration, conversion failures, Stripe retrieval failures, and unmatched writes must return a non-2xx response so Stripe retries delivery.

**Why:** A successful active production subscription remained Free after an older `incomplete` webhook state was stored. Initial tests using only dictionaries concealed an SDK conversion incompatibility, and unchecked MongoDB results could acknowledge a webhook without granting entitlement.

**How to apply:** For every Stripe entitlement webhook change, test out-of-order active/incomplete events, real Stripe object conversion, successful active-plan persistence, unmatched writes, and retryable non-2xx failures.