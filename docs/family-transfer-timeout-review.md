# Family transfer transaction deadline — approval required

## Diagnosis

**Severity: High.** The production family-transfer endpoints return 503 rather
than completing a valid family join. No membership change or SOS loss is claimed.

The serving Railway revision was independently verified read-only as
`541746166c68dcd91d32154609012d9935156c9c` (the merge of the family-transfer
security correction). Production join requests at 2026-11-17 23:57:57.085 UTC
and 23:58:00.459 UTC returned 503 after 1,252 ms and 1,271 ms. Runtime logs
contained access lines, not transaction stages or exception/commit detail.

The concrete code defect is a **one-second deadline for the entire multi-step
transaction**, not a one-second per-query timeout:

- Per-recipient invitations from retained clients use
  `accept_legacy_invitation` -> `family_write_fence.transaction`.
- Explicit email-link confirmation uses that same transaction wrapper.
- Family-wide codes use `join_family_code` -> `family_write_fence.run` with an
  explicit one-second override.
- Leaving uses the same guarded departure/movement work with another explicit
  one-second override.

That single budget includes session acquisition, fresh identity/inviter checks,
ordered source/destination fences, SOS attribution, dependent-care checks,
record movement, accepted-invitation publication, and commit/retries. A healthy
transaction can exceed it through accumulated ordinary database round trips.

**Confidence:** high in this reproducible deadline defect and correction.
Production telemetry does not identify the exact slow Mongo command, distinguish
callback from commit delay, or prove the internal rollback outcome of an earlier
timeout. The reproduction below is controlled local evidence, not a measured
production database latency profile.

## Reproduction and smallest correction

An owned loopback MongoDB replica runs the real FastAPI join/leave routers and
Motor transaction/commit implementation. A command listener adds only 35 ms to
each transactional round trip in Motor's worker thread. No event-loop blocking,
production data, or mocked transaction implementation is involved.

Before the correction, all four routes return their existing timeout 503 at
about 1.04 seconds; the deadline fires after roughly 28 database commands and
before a commit. With the correction, the same valid work finishes:

| Route | Transaction commands including commit | Initial observed local elapsed |
| --- | ---: | ---: |
| Retained per-recipient invitation | 45 | 1.637 s |
| Email-link confirmation | 45 | 1.633 s |
| Family-wide code | 41 | 1.490 s |
| Leave | 36 | 1.315 s |

The correction explicitly passes one **10-second finite transfer budget** at
these four transfer entry points, without changing either shared default.
This leaves headroom for complete guarded work and transient/commit retries
while remaining well below the existing mobile client's 45-second request
timeout. It is an application-code correction, not an environment/configuration
change. The default two-second short-write/SOS persistence deadline and the
one-second shared transaction default for alert reads, ordinary email-link
verification, and member-removal callers stay unchanged.

## Preserved guarantees and risk

- No authorization, ownership, recipient-email, invitation-status, identity,
  dependent-care, active-SOS, source-family, or expected-destination check is
  removed or bypassed.
- The sorted family fence and all-or-nothing transaction are unchanged.
- Resolved self-SOS stays byte-for-byte in its original family; ordinary
  admissible self-care records move through the existing selectors.
- Commit uncertainty still retries only commit, not the domain callback.
  Visible delivery remains outside the transaction, after known commit.
- A genuine deadline expiration still returns 503; external cancellation still
  cancels. Neither is relabeled success. An already-dispatched commit may have
  an uncertain result, so callers must still check authoritative status.
- The longer transfer window can retain structural write contention longer.
  Existing SOS deadlines and contention tests remain in place; ten seconds is
  not a guaranteed latency or SOS-delivery SLA.

## Verification and approval boundary

Regression tests cover all four actual transfer routes under accumulated wire
latency, rejected unsafe departures, a commit command delayed 1.2 seconds by
the local failpoint (not evidence of an acknowledgment-only delay),
uncertain-commit retry without domain replay, idempotent re-acceptance, immutable
SOS history, rollback before commit, cancellation, and unchanged SOS deadline.

The two previously accepted raw-Mongo concurrency probes are not application
writer guarantees and are not weakened to pass this change.

The independent review identified that changing the shared transaction default
would unintentionally lengthen SOS alert reads and ordinary sign-in. The
correction was narrowed to explicit transfer-only overrides, with a regression
asserting both short defaults remain unchanged. The review also requested the
precise delayed-commit wording above. No second independent review is claimed.

This correction is independent of the unmerged SOS-reopening retention PR.
No production request was used to reproduce a write, and no production
membership, invitation, record, index, TTL, variable, deployment, or OTA was
changed. Do not merge or release without product-owner approval.
