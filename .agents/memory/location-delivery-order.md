---
name: Location delivery order
description: Release ordering and acceptance boundary for freshness-priority location delivery.
---

Treat location-history retention as a prerequisite for enabling freshness-first
client delivery. Reverse release order on rollback: stop newest-first clients
before reverting the backend history support.

**Why:** The owner requires current coordinates to bypass historical backlogs
without sacrificing original historical records or weakening location consent.
Changing client ordering alone against a backend that retains only promoted
fixes loses history.

**How to apply:** Verify backend history support before authorizing a client
rollout. Keep capture ordering, consent lifetimes, and battery policy intact.
Acceptance of this delivery correction does not close the separate unresolved
cold-background movement-detection delay.
