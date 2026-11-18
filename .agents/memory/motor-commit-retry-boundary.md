---
name: Motor commit retry boundary
description: Installed driver auto-commit behavior can contradict documented uncertain-commit retries
---

Do not assume the installed Motor `with_transaction` helper actually retries an
uncertain commit merely because its documentation says so. Verify transient
callback failures and uncertain commit failures separately on an owned replica.

**Why:** A real commit failpoint escaped from the transaction context's automatic
commit, before the helper's documented commit-retry loop. Ordinary successful
transactions and transient insert retries did not expose the behavior.

**How to apply:** Keep external delivery outside all transaction callbacks.
An uncertain commit must retry the commit, not repeat the domain action.
Explicit commits inside callbacks are a documented driver escape hatch, but
must remain deadline-bounded and tested against the installed version. An
application timeout is not proof that an already-dispatched command did not
commit; never claim durable cross-request notification idempotency from an
internal retry test.

Budget the entire guarded family transaction for accumulated round trips,
not a single fast local database call. Keep the transfer budget separate from
the shorter SOS persistence budget.

**Why:** A one-second outer deadline failed otherwise valid multi-collection
transfers on all real join routes under modest per-command latency. Fast local
success and an isolated commit-retry test did not exercise that total cost.

**How to apply:** Exercise the real routes and Motor against an owned replica
with per-command latency and delayed/uncertain commit acknowledgment. Keep the
deadline finite, below the client request timeout, and preserve cancellation,
authorization, atomicity, and post-commit-only delivery.
