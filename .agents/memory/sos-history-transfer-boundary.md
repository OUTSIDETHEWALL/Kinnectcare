---
name: SOS history transfer boundary
description: Approved history-retention constraints and the concurrency boundary for family transitions
---

## Current product retention decision

Resolved SOS history is retained for 30 days and then automatically expires.
Permanent SOS retention is not required. Keep the existing production MongoDB
TTL index unchanged unless the user separately authorizes a change.

**Why:** The user explicitly chose 30-day retention instead of permanent history.

**How to apply:** Transfer-time preservation below means preserving records
within their retention period, not indefinite retention. The earlier proposal
to remove the alerts TTL is superseded. Active and reopened SOS must have no
date-valued resolved_at: the existing filter checks only that resolved_at exists,
not resolved status. Resolving again starts a new 30-day period; retries of an
already-resolved incident must not extend its retention timestamp.

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

The user approved a cooperative, transaction-scoped family-write protocol across
application transfer, dependent, SOS and relevant care writers. The original
direct-Mongo concurrency reproductions are explicitly accepted limitations and
must remain separate from tests of the real application boundary.

**Why:** The user chose application-writer coordination rather than claiming a
database-enforced invariant against arbitrary MongoDB writes.

**How to apply:** Name uncovered maintenance/background paths explicitly; do not
enroll ordinary GPS, battery sample persistence or polling in structural fences.
Measure SOS persistence overhead, keep external emergency delivery outside retry
callbacks, preserve fresh post-acquisition authority, and require separate merge
and release approval.

When preserving SOS history, inspect automatic expiration and unrelated
startup repairs as well as family endpoints. Removing TTL creation from code
does not disable a TTL index already installed in a database.

**Why:** An existing Mongo index can delete history without any application
writer running, even after the startup migration that installed it is retired.

**How to apply:** Verify existing index metadata rather than inferring it from
source or a fresh test database. Under the current product decision, do not
retire the existing index merely because it expires resolved SOS.

Railway's read-only project connector can identify the live service by its
domain and source branch, but its OAuth variable listing returns names only.
A TTL result from the workspace read-only Mongo connection is not production
evidence until its cluster and database match the serving service.

**Why:** The read-only URI default and the historical migration guide named
different databases; only the former had the SOS-matching TTL index.

**How to apply:** Get a trusted, non-secret cluster identifier and database name
for the serving service and compare them before labeling index results live.
