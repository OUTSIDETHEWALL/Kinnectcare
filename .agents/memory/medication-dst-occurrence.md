---
name: Medication DST occurrence identity
description: Keep scheduler and legacy acknowledgment aligned during the repeated DST hour.
---

One scheduled medication slot/date represents one occurrence, anchored to the
first fold. Scheduler and nearest-prior legacy acknowledgment must compare
actual UTC instants, not local wall-clock ordering, when resolving that identity.

**Why:** Independent review demonstrated a successful second-fold acknowledgment
could otherwise select yesterday while the scheduler escalated today's dose.
Exact identity-bearing actions must remain aligned with legacy actions.

**How to apply:** When changing medication time resolution, cover an acknowledgment
at second-fold 01:02 following first-fold 01:50 and assert the subsequent
escalation is suppressed. Preserve the established bounded escalation window
and ambiguous-send no-resend policy.
