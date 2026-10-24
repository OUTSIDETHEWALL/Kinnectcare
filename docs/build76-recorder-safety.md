# Diagnostic recorder safety correction — Build 76

## Delivered outcome: FAIL — not eligible for physical validation

The delivered AAB failed visibility preservation. Build 75 contains five native
response-emission hooks and eleven FileReader hooks; Build 76 contains zero of
either. Seven required patched-JS marker call sites are also absent.

**Severity: High. Confidence: high.** The config-plugin entrypoint still
activates deep instrumentation only for the exact diagnostic-build value `75`.
The `76` profile therefore skipped both the ASM registration and dependency JS
patches. Standalone transformation tests passed, but did not exercise the
profile-specific entrypoint. The delivered artifact gate caught this omission.
No application correction or replacement build was made after inspection.

The independent producer audit passed: 74 roots / 149 reachable app-owned
methods, constructors, class initializers and synchronous diagnostic callbacks
show no recorder-readiness, worker-lock, file-I/O or drainage wait. This does not
make the incomplete observation candidate acceptable.

- EAS build: `bcd8ab82-106a-4b1e-8ec5-2851b637ad7f`
- Version: `1.3.1` / `76`; runtime `1.3.1-diagnostic76`; channel `diagnostic76`
- Frozen source: `39ec36088f17c0237ed2465d5bc794a36347524f`
- Source tree: `ace9c461f979fadff81442655b7a83d9faa4b2a2`
- AAB: 83,496,992 bytes
- AAB SHA-256: `ec5e478234cf5c52a2e971a31e4424e804ee749c1e6d29a0458180c4d956bbd5`
- Signature verified; same signer as Builds 74 and 75.
- All 342 resolved dependency hashes, permissions, components, ABIs, packaged
  SDK configuration, backend endpoint set and 22 lifetime/HTTP class method
  fingerprints remain unchanged.

The pre-artifact statements below describe source intent and host checks,
not a passing delivered-coverage result. No distribution or installation.

## Scope and diagnosis

High severity, high confidence: the rejected Build 75 observer could first-touch
a lazy Handler and call `HandlerThread.getLooper()` on the production caller.
That API can wait for its worker to initialize. Related compact and verbose
observers had the same initialization pattern and blocking-capable queues/maps.
Exception handling and warm blocked-consumer tests do not bound that wait.

Only diagnostic admission, processing lifecycle, cached export and tests change.
No GPS, ownership, authorization, sharing, request coalescing, HTTP/dispatcher,
WorkManager, heartbeat, native-task lifetime, privacy or backend policy changes.
No deep marker was intentionally removed from source; the delivered activation
failure above nevertheless removed required compiled coverage.

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
