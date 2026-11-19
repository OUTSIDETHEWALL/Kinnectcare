---
name: Account deletion revocation boundary
description: Why cleanup, retained credentials and captured outbound work need separate lifetime proofs.
---

Do not equate deleting stored account/work rows with canceling every operation
that already captured identity, credentials or delivery tokens. A retained
credential must remain bound to its original random account identity, not a
later account using the same email. Audit actual invitation and transport
writers, not only callers already using the shared structural helper.

**Why:** Independent adversarial inspection found that otherwise atomic cleanup
could coexist with replacement-identity OTP redemption, a late unfenced
invitation insert and sends using tokens cached before cleanup.

**How to apply:** Before certifying deletion, test the exact pause points across
credential consumption, owner checks, token capture, reservations and provider
submission. Distinguish work already in progress from provider acceptance;
MongoDB cannot recall an external send. A parent snapshot read alone does not
serialize a late private-evidence insert with parent deletion: require a real
conflicting mutation in the same transaction. Keep ordinary telemetry outside
the global family structural fence and preserve GPS/consent publication rules.
