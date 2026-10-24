---
name: Native observer safety
description: Prevent tracing from creating startup, lock-contention or battery symptoms that resemble the bug being investigated.
---

Instrumentation must keep restore, JSON/ring processing, logging handlers and
disk writes off request/authority/consent paths. A bounded ring is not sufficient
if every event rewrites the full store. Preserve all existing transport listener
callbacks and never silently overwrite another global custom-client hook.

**Why:** An observer can produce the startup stalls, authority-lock contention
or battery cost it is meant to diagnose, even when application policy remains
unchanged.

**How to apply:** Inspect compiled registration/call paths, exercise actual
compiled observers against a blocked consumer and IO failure, and report queue,
retention and durability uncertainty. A debounce is not a hard persistence
deadline; a JVM test double is not Android or release-shrinker acceptance.

Treat source transforms and delivered native classes as separate evidence.
React Native's Android implementation may come from a precompiled dependency;
editing its installed Kotlin source does not establish that the app contains
the edit. Use hooks in compiled app/vendor sources or verify the actual artifact.

**Why:** A locally plausible diagnostic hook can otherwise be absent from the
binary while its source tests pass, leading to false conclusions from missing data.

**How to apply:** Compile against the actual dependency classes where possible,
then inspect the separately approved release artifact before claiming device
coverage. Prebuild-time JavaScript dependency hooks also need explicit coverage
review before an OTA-only collection is considered.

Preferential failure retention must continue after a stalled operation finally
resumes. Do not unpin the first pathological SDK/WorkManager operation merely
because foreground return makes its Promise settle.

**Why:** Foreground recovery and export traffic can otherwise evict the very
background evidence needed to distinguish the missing async boundary.

**How to apply:** Stress retention both while an operation remains pending and
after late settlement followed by a foreground event flood; retain its correlated
requests, flight, and at least one follower.

## Cold worker initialization is part of the producer path

A worker-backed recorder is not automatically nonblocking: first access to a
lazy Handler can call HandlerThread.getLooper(), which can wait for worker
initialization. Include lazy initialization in the safety review, not just
steady-state queue admission.

**Why:** Blocked-writer JVM tests can pass while the delivered producer path
still contains a cold-start wait. Catching exceptions does not bound a wait.

**How to apply:** Inspect the delivered initialization call chain and require
separate cold-start evidence before certifying a recorder as nonblocking.

Admission must not start or initialize its consumer. Use bounded nonblocking
attempts; unavailable, contended, full or closed infrastructure must produce
counted diagnostic loss rather than application backpressure. Initialization
and storage processing belong to an independent lifecycle operation. Review
other recorders on the same call chain, not just the newest observer.

**Why:** The product owner rejected a native diagnostic candidate whose warm
blocked-writer tests passed but whose first event could wait on a lazy looper.
Diagnostic correctness never authorizes delaying production execution.

**How to apply:** Test actual cold first use, held initialization/storage,
unpublished queue reservations, saturation, concurrent admission and shutdown/
recreation. Inspect delivered DEX as well as source. Keep rejected artifacts
immutable and use a new native identity for corrected candidates. Host latency
measurements are not Android scheduling or physical defect acceptance.

Avoid globally invalidating diagnostic associations just because a read
contended. Lost mutations need conservative attribution invalidation, but
unrelated healthy requests should retain their correlation.

**Why:** A nonblocking try-lock prototype preserved every real HTTP callback
yet discarded most correlated histories under an ordinary request burst.
Nonblocking admission alone is not evidence that observation remains useful.

**How to apply:** Check complete correlated histories and explicit losses
alongside application callbacks. Use bounded atomic associations or similarly
scoped invalidation; distinguish ordinary burst coverage from artificial overload.
