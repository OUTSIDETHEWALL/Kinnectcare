---
name: Medication acknowledgment occurrence safety
description: Durable correctness rules for medication notification actions, occurrence identity, retries, and T+15 race handling.
---

Medication acknowledgment is identified by reminder, member, scheduled slot, and local date. Foreground, background, terminated, and retry paths must share one handler and must not consume or dismiss an action before backend confirmation.

**Why:** A silent Android action can be accepted while the live React listener is unavailable, and reminder-only timestamps cannot safely distinguish multiple scheduled doses. At T+15, acknowledgment and caregiver escalation also need one durable winner across crashes and concurrent workers.

**How to apply:** Persist pending device actions independently, keep backend writes idempotent by exact occurrence, require uniqueness indexes before processing, and coordinate acknowledgment with escalation through a durable occurrence claim. Escalation delivery must distinguish reserved, attempted, and sent states; stale takeover cannot temporarily release the claim, and attempted delivery remains terminal even if finalization crashes.