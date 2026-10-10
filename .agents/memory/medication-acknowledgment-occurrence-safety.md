---
name: Medication acknowledgment occurrence safety
description: Durable correctness rules for medication notification actions, occurrence identity, retries, and T+15 race handling.
---

Medication acknowledgment is identified by reminder, member, scheduled slot, and local date. Foreground, background, terminated, and retry paths must share one handler and must not consume or dismiss an action before backend confirmation.

Completed escalation is historical evidence, not a permanent ban on recording
the dose taken afterward. The user approved late exact-occurrence completion
for the recipient and the existing authorized family-owner self-due path.
Keep in-flight escalation exclusive, preserve sent history, and do not permit
completion to bypass a terminal manual miss or its ownership before log persistence.

**Why:** Physical testing established that a successfully delivered escalation
otherwise permanently rejected legitimate later completion; allowing that
completion must not broaden caregiver permissions or erase the prior warning.

**How to apply:** Distinguish provider-accepted completed scheduler escalation
from an in-flight send and explicit missed-dose arbitration. Attempted-device
counts and attempt markers are not completion evidence.

Ambiguous sends must not be retried or represented as successfully sent. The
user chose explicit unknown outcomes that block Taken until success is proven.
Recover pre-send crashes and already-saved success evidence, not uncertainty.

**Why:** A process can disappear after the provider accepts a push but before
the response is saved. Retrying may duplicate caregiver notifications; inferring
success may permit Taken while an original send is still running.

**How to apply:** Fence completion writes by ownership, preserve the occurrence
claim through unknown outcomes, and do not equate provider acceptance with
physical-phone receipt.

Remote medication and routine pushes must have one presentation owner: the OS-delivered notification. Do not dismiss and locally re-present the same remote push. Provider collapse IDs and snooze IDs must include the exact occurrence, not only the reminder.

**Why:** A silent Android action can be accepted while the live React listener is unavailable, and reminder-only timestamps cannot safely distinguish multiple scheduled doses. At T+15, acknowledgment and caregiver escalation also need one durable winner across crashes and concurrent workers. Android can show both the original remote notification and a JS-created replacement, while reminder-only collapse IDs suppress legitimate later doses.

**How to apply:** Persist pending device actions independently, keep backend writes idempotent by exact occurrence, require uniqueness indexes before processing, and coordinate acknowledgment, manual misses, and escalation through a durable occurrence claim. Manual-miss retries must repair incomplete post-claim writes rather than treating an in-progress claim as completion. Escalation delivery must distinguish reserved, attempted, accepted completion, and unknown states; stale takeover cannot temporarily release the claim.