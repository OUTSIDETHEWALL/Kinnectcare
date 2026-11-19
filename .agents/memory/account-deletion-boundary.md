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

Unknown interrupted provider calls must remain fail-closed until there is
evidence that the original worker can no longer submit. Neither elapsed time,
an expired scheduler lease nor a disconnected request proves that. Completion
of a provider call permits cleanup, not a claim that its notification cannot
arrive later. Preserve the hashed mailbox lifetime fence across deletion so a
captured operation cannot mistake a replacement account for its original one.

**Why:** The owner approved only minimum deletion-sensitive coordination,
including interrupted attempts; a general notification rewrite and automatic
uncertain-send replay are not authorized.

**How to apply:** Keep providers outside database transactions, preserve SOS's
distinct user-subject and member-subject forms, and document fail-closed
interruption recovery as an operational limitation rather than silently
releasing a blocker.

Reopening account deletion after the launch cutover requires verified retirement
of old senders and the owner's explicit approval for the production enablement.
Merging the temporary server gate is not permission to open it.

**Why:** The owner approved only a narrow server-enforced gate and required
deletion to remain blocked until worker handoff is verified, with production
configuration and deployment separately approved.

**How to apply:** Keep deletion closed during the transition. Do not infer
handoff completion from elapsed time, client behavior or a healthy new container;
restore deletion only after the handoff evidence and approval are present.
