# Diagnostic recorder safety correction — Build 76

## Scope and diagnosis

High severity, high confidence: the rejected Build 75 observer could first-touch
a lazy Handler and call `HandlerThread.getLooper()` on the production caller.
That API can wait for its worker to initialize. Related compact and verbose
observers had the same initialization pattern and blocking-capable queues/maps.
Exception handling and warm blocked-consumer tests do not bound that wait.

Only diagnostic admission, processing lifecycle, cached export and tests change.
No GPS, ownership, authorization, sharing, request coalescing, HTTP/dispatcher,
WorkManager, heartbeat, native-task lifetime, privacy or backend policy changes.
No deep marker is removed.

## Producer path

`record -> validate bounded metadata -> offer fixed ring -> schedule bounded
task descriptor -> unpark an existing consumer -> return`.

The ring reserves slots with at most eight CAS attempts. Diagnostic associations
use fixed atomic tables and bounded probes; ambiguous/lost mutations invalidate
their stripe rather than guess attribution. Neither structure has a consumer
lock. Admission never starts a thread, calls a looper, touches storage, processes
retention, serializes snapshots, waits on a future or joins a consumer.
First-use correlation identifiers do not require SecureRandom initialization.

Application bootstrap independently schedules initialization before starting
each consumer. Initial restore has priority over admitted drain descriptors.
Only consumers restore files, parse JSON, apply existing preferential retention,
serialize snapshots or persist. Snapshot reads return immutable cached strings,
not futures on a writer. Shutdown does not join; an unfinished old consumer
prevents overlapping recreation, never production admission.

## Verification before artifact creation

- TypeScript: `npx tsc --noEmit` passed.
- Full Jest run: 1,054 passed, two failed. One is the unchanged legacy repository
  audit fixture failure already present before this correction; the other was
  a source assertion naming the removed blocking queue. That assertion now
  requires the replacement bounded queue. Affected suites rerun: 40/40 passed.
- Production Kotlin observers compile against actual RN 0.81.5, Android and
  OkHttp APIs; the generated Java bridge compiles.
- Real OkHttp: all 120 production delegates complete, all 120 diagnostic
  histories correlate, zero loss, queued peak at least 100. Dispatcher, pool,
  timeout, retry policy, request identity, cancel tag, headers and existing
  callback delegates remain unchanged.
- Cancellation, numeric-ID collision rejection, native wake/lifetime correlation,
  process recreation, bounded privacy-filtered retention and storage-write
  failure passed.
- Existing deep tests retain native-only boundaries, correlated flight/follower/
  request evidence and pathological roots after late resumption/foreground flood.
- Cold first touch, delayed initialization/filesystem access, blocked writer,
  saturation, concurrent cold admission, failure/recreation, concurrent shutdown,
  unpublished ring reservation and all three real recorder facades passed.
- Stress: 160,000 attempts; worst observed producer duration 20,058,705 ns
  (20.059 ms), 157,952 drops, queue high-water 2,048, worker failures 0.
  Across these separate host scenarios the largest first-touch sample was
  63.562 ms. These are host observations, not phone latency guarantees.
- Actual RN class ASM transformation: three classes, 16 passive observer calls.
- Actual compiled native lifetime/liveness tests and generated bridges passed.

JVM platform/clock/context substitutes do not establish Android scheduling or
physical acceptance. Standard VM allocation, class loading, GC and OS scheduling
are not a hard real-time guarantee. The safety claim is specifically no wait
for diagnostic infrastructure readiness, locks, persistence or drainage.

## Artifact gate and operational boundary

Freeze and verify the source commit/tree and uploaded archive. Build only the
new diagnostic76 profile (versionCode 76); preserve the rejected Build 75.
Inspect the delivered AAB's producer call graph, deep hook call sites, lifetime
method fingerprints, SDK configuration, dependencies, permissions, components,
ABIs, signer and backend endpoint set. Fail the candidate if producer readiness
waits cannot be excluded.

No merge, Railway deployment, OTA publication, Play upload or phone installation
is authorized. After delivered artifact inspection, stop and report.

GPS remains **REPRODUCED — exact async failure mechanism not yet proven**.
Circle remains **live request fan-out demonstrated — complete severe-launch
mechanism not yet proven**. Neither underlying defect is corrected here.
