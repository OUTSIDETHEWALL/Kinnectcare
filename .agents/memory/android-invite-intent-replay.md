---
name: Android invite Intent replay
description: Accepted Android invite URLs can be redelivered after reboot even after pending state is cleared.
---

Successful invite acceptance must record the invite token as consumed before clearing pending state. Every Android referrer, deep-link, and invite-route entry point must ignore consumed tokens.

**Why:** Android redelivered the original invite launch Intent after reboot, causing a successfully accepted token to be persisted again and rendered as an inactive invitation instead of restoring the dashboard.

**How to apply:** Treat clearing pending invite storage and suppressing consumed launch URLs as separate transitions. New invite tokens remain valid because per-invite tokens are unique.