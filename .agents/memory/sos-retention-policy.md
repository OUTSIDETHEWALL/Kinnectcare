---
name: SOS retention policy
description: Owner-approved expiration distinction between resolved and active SOS incidents.
---

Resolved SOS records expire automatically after 30 days. Active or unresolved SOS
records must NEVER be automatically deleted by this expiration mechanism.

**Why:** The owner explicitly confirmed this policy during pre-launch remediation.

**How to apply:** Preserve the distinction in expiry queries, indexes, reopening,
account-deletion review and privacy disclosures. Never introduce a blanket alerts
TTL. Production database migrations require separate approval.
