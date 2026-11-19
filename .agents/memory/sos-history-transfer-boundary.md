---
name: SOS history transfer boundary
description: Approved history-retention constraints and the concurrency boundary for family transitions
---

## Current product retention decision

Resolved SOS history automatically becomes eligible for expiration 30 days
after resolution; deletion is asynchronous, not an exact-time promise.
Permanent SOS retention is not required. Keep the existing production TTL
unchanged unless the user separately authorizes a change.

**Why:** The user explicitly chose 30-day retention instead of permanent history.

**How to apply:** Transfer-time preservation below means preserving records
within their retention period, not indefinite retention. The earlier TTL-removal
proposal is superseded. Active/reopened incidents must not expire. Resolution
starts the period, acknowledgment does not, and retries must not extend it.
Historical resolutions without a trustworthy date need reviewed evidence,
not an invented timestamp or an unapproved backfill.

**Why:** An unknown historical event time cannot safely establish the original
30-day deadline. Local TTL success cannot establish legacy production state.

**How to apply:** Report undated-history and serving-database verification
separately from source correctness; obtain approval before historical repair.

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

**Why:** Historical connection/database provenance was ambiguous, and a secret
labelled read-only proved write-capable. Neither its label nor default database
establishes serving identity or least privilege.

**How to apply:** Get a trusted, non-secret cluster identifier and database name
for the serving service and compare them before labeling index results live.
Keep owner-confirmed mapping distinct from independently retrieved configuration.
Check privileges without exposing credentials; restrict verification commands
to metadata and read-only pipelines, and prefer a genuinely read-only login.
