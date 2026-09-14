---
name: Medication acknowledgment occurrence safety
description: Durable correctness rules for medication notification actions, occurrence identity, retries, and T+15 race handling.
---

Medication acknowledgment is identified by reminder, member, scheduled slot, and local date. Foreground, background, terminated, and retry paths must share one handler and must not consume or dismiss an action before backend confirmation.

Remote medication and routine pushes must have one presentation owner: the OS-delivered notification. Do not dismiss and locally re-present the same remote push. Provider collapse IDs and snooze IDs must include the exact occurrence, not only the reminder.

**Why:** A silent Android action can be accepted while the live React listener is unavailable, and reminder-only timestamps cannot safely distinguish multiple scheduled doses. At T+15, acknowledgment and caregiver escalation also need one durable winner across crashes and concurrent workers. Android can show both the original remote notification and a JS-created replacement, while reminder-only collapse IDs suppress legitimate later doses.

**How to apply:** Persist pending device actions independently, keep backend writes idempotent by exact occurrence, require uniqueness indexes before processing, and coordinate acknowledgment, manual misses, and escalation through a durable occurrence claim. Manual-miss retries must repair incomplete post-claim writes rather than treating an in-progress claim as completion. Escalation delivery must distinguish reserved, attempted, and sent states; stale takeover cannot temporarily release the claim, and attempted delivery remains terminal even if finalization crashes.