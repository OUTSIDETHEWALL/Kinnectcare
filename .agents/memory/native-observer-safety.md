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

## Bytecode cleanup and constructor coverage

Exercise observer insertion against actual dependency constructors, original
exception handlers and exception type annotations, not only synthetic ordinary
methods. Diagnostic cleanup must run before the original application catch,
then rethrow the original exception with its original handler metadata intact.

**Why:** Source-string and invocation-count checks did not expose constructor
stack-model and exception-table ordering hazards during scheduling-observer
verification. A transform can compile yet alter which catch receives a failure.

**How to apply:** Verify transformed dependency bytecode and execute return,
throw, nested-monitor and catch-annotation fixtures before native-build approval.

## Compiler-generated cold paths count as observer code

Inspect Android NDK disassembly for newly added C++ thread-local state; source
without an explicit allocation or mutex is not proof of a nonblocking producer.
Emulated TLS can call allocation, pthread-once and mutex infrastructure on first
use. Warming the Application thread does not warm a JS/vendor thread.

**Why:** Host JNI contracts passed while the actual Android compiler introduced
an allocating/locking TLS helper into the scheduling producer. Source-only bans
on malloc or mutex would have incorrectly certified that cold path.

**How to apply:** Check every shipped ABI and first-use producer call graph.
Treat unresolved cold TLS initialization as a pre-build safety failure, not a
device-only acceptance question or something an AAB build success can waive.

Keep Android compiler code-generation settings unchanged in cold-path tests.
In particular, do not disable AArch64 outlined atomics merely to make a
freestanding test link.

**Why:** The freestanding gate initially lacked compiler-rt atomic helpers.
Changing codegen would test different producer instructions from the app.

**How to apply:** Link the actual NDK helper assembly; inspect its initialization
dependencies and exercise both LL/SC and LSE paths. Explicitly distinguish CPU,
clock and OS adapters from Android Bionic/JVM and physical-device evidence.

Expo Application mods must not depend on another plugin having already inserted
an anchor. Exercise the real prebuild as well as string-transform fixtures.

**Why:** Mod composition order differed from isolated fixture order and caused
the real Application generation to fail before compilation.

**How to apply:** Use stable template anchors, test both modifier orders, and
verify clean diagnostic and non-diagnostic generated projects separately.

## Whole dependency compilation has stricter contracts than fixtures

Match the dependency's compiler mode in standalone contracts and still compile
the actual dependency. Do not disable strict API checking to accommodate an
observer.

**Why:** Ordinary Kotlin fixtures passed while RN's explicit-API mode rejected
the added diagnostic declarations' implicit visibility.

**How to apply:** Keep explicit-API validation on and use real Gradle compile
inputs/objects/classes as the integration evidence, separate from fixture passes.

Synchronize verification-clone generation templates and module sources, not
only the patched dependency copy.

**Why:** Reapplying the patch to an old clone copied its old module header back
over the corrected dependency input. A current patching tool alone was not enough.

**How to apply:** Compare generator/module/input hashes before compilation and
require actual object/library evidence afterward; do not trust stale clone caches.

An app's successful ASM task is not proof of dependency-class instrumentation.

**Why:** AGP transformed only the app's own classes there; the RN dependency's
monitor transform did not execute until its dependency consumer was requested.

**How to apply:** Exercise the real dependency ASM/D8 path and inspect its actual
intermediate output. Keep this distinct from delivered APK/AAB or phone evidence.

Invocation guards must preserve the operand-stack prefix, not only receiver and
arguments, before introducing exception handlers. Analyze original instructions
outside the rewriting visitor and recompute frames at the class level.

**Why:** Simple return/exception fixtures passed, but a real SDK call embedded in
a constructor expression left values below the invocation; a swallowed observer
exception discarded them and D8 rejected unequal stack heights. Per-method frame
recomputation also missed remapped locals in otherwise unchanged methods.

**How to apply:** Include constructor/uninitialized-object and wide stack prefixes,
original exceptional return paths and throwing observers in guard fixtures; reject
D8 invalid-stack-map warnings rather than accepting a warning-only build.

Source substitution must cover legacy as well as current RN coordinates.

**Why:** A direct react-android resolution report selected source, but SDKs using
the legacy react-native coordinate still introduced the Maven copy downstream;
only the real dependency/D8 merge exposed the duplicate.

**How to apply:** Cover both coordinates and verify the complete consumer, not
only a dependency-insight result for the current coordinate.

Pin standalone Java fixture bytecode to Java 17 when Gradle uses Java 17.

**Why:** This host's javac defaulted to Java 21 while Kotlin respected JAVA_HOME=17;
compilation passed but fixture execution failed with UnsupportedClassVersionError.

**How to apply:** Use javac --release 17 for simulation shims as well as the bridge;
do not change app/toolchain versions to resolve a host-fixture mismatch.
