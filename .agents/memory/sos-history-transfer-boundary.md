---
name: SOS history transfer boundary
description: Approved history-retention constraints and the concurrency boundary for family transitions
---

Qualifying resolved self-SOS history must stay unchanged in its existing family
when its subject joins or is removed from a family. Both verified account-ID and
self-member-ID subjects are legitimate. Historical ownership is not authority
over another person's care records, nor permission for destination or former
family members to read retained history.

**Why:** The user explicitly approved preserving historical SOS and audit context
without weakening identity, dependent, active-obligation or privacy protections.

**How to apply:** Keep retention, movement and disclosure separate. Do not
normalize or retag stored incidents as an onboarding repair. Use synthetic local
data for mutation tests, never a live affected account.

Mongo snapshot transactions do not predicate-lock new obligations. A no-op
update of an already-resolved incident does not establish a write fence.

**Why:** Real loopback-replica experiments allowed both concurrent SOS reopening
and a new dependent insert to coexist with a successful transfer. Serial mocks
and ordinary transaction rollback tests missed both cases.

**How to apply:** Require cooperative writer serialization or a proven
database-enforced invariant before claiming concurrent transfer safety. Changing
SOS/care writers needs explicit scope approval; do not silently broaden a
history-only correction or weaken the failing concurrency regressions.
