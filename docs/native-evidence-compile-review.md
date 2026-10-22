# Native evidence candidate: compile-only review

Validated locally on 2026-10-20, on `fix/bounded-native-evidence-tracing`.
Starting candidate: `1abbc5bc67f06b4da5f355810b4a61fe48c68a84`.
The final reviewed commit and tree are recorded in the delivery response.
Both underlying defects remain unresolved. Google Play production stays on HOLD.

## 1. Native compilation: PASS

An isolated copy of the current frontend was prebuilt with `--platform android
--no-install`. Only debug compile tasks were requested:

```
:startup-diagnostics:compileDebugKotlin
:react-native-background-geolocation:compileDebugJavaWithJavac
:react-native-background-fetch:compileDebugJavaWithJavac
:app:compileDebugKotlin
:app:compileDebugJavaWithJavac
```

The original candidate failed: its Expo module did not declare access to
React Native's NetworkingModule/OkHttp APIs. A compile-only dependency on the
app's existing `com.facebook.react:react-android` fixed that instrumentation
defect. No transport/runtime version was added or replaced. The resolved
debug runtime uses RN 0.81.5 and OkHttp 4.12.0. Expo is 54.0.35; the local
location/fetch wrappers are 5.2.0 / 4.4.2.

The final compile/dependency inspection completed successfully:
**460 tasks, 9 executed, 451 up-to-date**, following the prior full debug
compile of **459 tasks, 268 executed**. These are compilation outputs, not a
release APK/AAB. No assemble, bundle, signing, EAS build, upload or install ran.

## 2. Compiled hook paths: PASS for every implemented candidate hook

`tests/inspect_native_evidence.py` disassembled **147 class files in 11 groups**,
asserted hook references, and compared reviewed source bytes to the isolated
sources actually compiled.

| Group | Compiled confirmation |
| --- | --- |
| Application | `NativeHttpEvidence.install` executes before `loadReactNative`; existing startup recorder boundaries remain |
| RN package registry | Location and BackgroundFetch packages are in the app's compiled package list |
| Expo registry | Compiled package list includes StartupDiagnosticsModule |
| Expo module functions | Evidence version/record/read and evidence-aware claim route reach the compiled recorder/authority code |
| HTTP | Global-builder registration, dispatcher entry, DNS/connect/TLS, request/response headers/body, call completion/failure, optional actual edge ID |
| Existing HTTP callbacks | All 29 EventListener callbacks overridden; cache/proxy callbacks forward to the original listener |
| Native authority | Separate configuration/acquisition claim stages and all rejection reasons compiled under the original guards |
| Location headless | Wake ID, queued/context requested/context ready/task invocation/completion/error calls compiled |
| Native position | Original getCurrentPosition entry and existing success/error callbacks invoke the observer |
| Reflective bridge | Actual class/method lookup and invocation compiled; recorder and RN reflected-field keep rules supplied |
| WorkManager headless | Wake ID, queued/context requested/invoke/resumed-skip/completion/error calls compiled |

This proves debug class paths and registration references, **not actual Android
callback execution or retention after release shrinking**. The SDK's internal
timer is not newly patched: existing native SDK logs supply that boundary.
The precise RN response-emission → XHR-entry split remains identified but not
implemented, as in the original candidate. Body completion → JS settlement
must still be described as a mixed residual, not pure bridge time.

## 3. Evidence-contamination review and instrumentation-only corrections

Corrected:

1. **Critical-path observer IO/locking:** the old recorder restored and parsed
   preferences during Application startup/first use, copied rings on producers,
   and serialized whole rings while holding a lock also reached from claims.
   Producers now only enqueue bounded metadata; parsing, restoration, sampling
   and IO run on one background-priority thread. Authority guards and writes
   themselves are unchanged.
2. **Battery/write amplification:** whole-store SharedPreferences commits were
   replaced with private atomic pages. Only dirty 32-row pages/current hourly
   counters are rewritten.
3. **Lost delegate callbacks:** proxy/cache listener callbacks were missing.
   They now forward. The observer refuses to replace an existing global
   NetworkingModule custom builder, reports that refusal, and installs once.
4. **Silent loss/bad retention:** explicit queue/IO coverage counters, numeric
   hour sorting, bounded per-hour key overflow, bounded dirty sets, bounded
   restore reads, re-sanitization, and negative-clock/orphan atomic-file cleanup.
5. **Backend handler latency contamination:** synchronous log handlers could
   stall the ASGI path. The observer now enqueues timestamped metadata to a
   bounded writer; queue overflow, writer failures and rate-budget skips are
   visible in later log records. Responses/exceptions are not replaced.

Preserved by diff review and tests: original request/response objects, existing
listener/resource identities, dispatcher/connection pool/DNS/cache/proxy/TLS/
cookie settings, timeouts/retries/redirects, GPS options, owner/consent fences,
claim outcomes, acquisition lease/backoff, 10-minute moving and **60-minute
stationary** thresholds, existing battery operations, and SDK scheduling.
No new request, SDK listener, OS alarm/job, foreground service or wake lock was
added. The observer's handler debounce is not an OS wake-up mechanism.

Remaining risks—not claimed eliminated:

- Thread creation, metadata enqueueing, listener calls, reflection, allocations,
  background CPU and atomic writes have nonzero overhead. Their physical
  startup/battery impact has not been measured.
- An extra pass-through application interceptor runs for RN networking calls;
  it emits only for marked allowlisted GETs. Queue/admission timing can include
  earlier application interceptors; it is not an exact queue-only metric.
- Trace headers and opaque GPS option extras are observational metadata. They
  are not new authorization inputs or SDK configuration.
- Missing logs can mean observer loss, storage failure, rejected installation,
  admission limits, suspension or incomplete coverage—not a proven absence of
  application work. Backend ingestion time is not the captured stage time.
- **Declined HTTP installation is partial coverage:** native capability version
  1 still permits JS IDs/headers and GPS tracing when the HTTP global-hook guard
  declines. JS/backend correlation can therefore exist without native HTTP
  spans. Require `httpObserverStatus=installed` and actual per-ID boundaries;
  a current-process status alone does not certify historical requests.
- A future cloud build with floating vendor dependencies must be inspected
  again. This compile cannot certify a future installed or shrunken binary.

## 4. Overnight retention: bounded/safe as best-effort diagnostics

Limits: 512 HTTP rows; 2,048 sampled GPS rows; 48 wall-hour buckets with 256 keys
plus overflow each; 1,024 pending events; at most 16 HTTP pages, 64 GPS pages,
48 hourly files and one loss file. Atomic-file temporary/backup variants are
bounded per owned filename. Each persisted page is limited to 128 KiB;
restoration refuses oversized pages.

The JVM harness executes **actual compiled observer classes** with small Android
test doubles, and real OkHttp 4.12.0. It passed:

- Transport policy/resource identity, request/response pass-through, all
  listener overrides, cache/proxy forwarding, repeated-install safety and
  refusal to overwrite an existing custom builder.
- A 200-hour replay, including a final **eight-hour stationary acquisition
  gap**, followed by **20,000 HTTP events** with the consumer deliberately
  blocked. The queue admitted 1,024 and reported **18,976 drops**; the GPS
  hourly evidence was unchanged.
- Ring/key/file bounds, per-hour overflow, write failure visibility/recovery,
  fresh-JVM restoration, oversized-page handling, privacy sanitization,
  negative wall-clock hours and unfinished atomic-page cleanup.

Replay retained **129 files / 670,504 bytes**; its compressed replay writes were
1,394,169 bytes. These are test-run measurements, not a physical daily battery
or IO estimate. The clock/orphan case finished with 51 files.

The original “final second may be lost” statement was too strong. A one-second
debounce is not a deadline: backlog, suspension, slow disk or death can lose
more queued/unflushed evidence. Export reports pending/dropped/IO states, or an
explicit busy/unavailable snapshot after 750 ms. Clock jumps affect retained
hour keys. This store is bounded, non-authoritative diagnostics—not a guaranteed
complete forensic record or proof that a missing callback never ran.

## 5. Verification and reproducibility

- Eight focused JS suites / 189 tests and TypeScript passed.
- Seven backend tests passed, including stream/error/cancellation identity,
  blocked-logger noninterference, queue overflow and admission-budget behavior.
- Five JVM modes passed: transport, occupied-hook, replay, reload, clock/orphan.
- Eleven compiled-path groups / 147 classes passed inspection.
- Independent diff review found no blocking instrumentation defect; its
  partial-HTTP-coverage finding is explicitly documented above.
- No signed-in UI, Android device, installed DEX or release shrinker acceptance.

Local ignored evidence is under `.cache/kinnship-android-validation/`:
`evidence-debug-compile-reviewed.log`, `evidence-jvm-harness-reviewed.log`,
`evidence-compiled-inspection.log`, `evidence-compiled-hooks.json`,
per-group bytecode reports and `evidence-compiled-hooks.zip`.

Debug compiled-class archive SHA-256:
`4c6012e88fbe5b72833ef2271e722839e5f027bf3d0c4bad5c4a20bfc9eee52a`.
The manifest hashes individual compiled classes and their source inputs.
Build output is intentionally not committed.

## 6. Required next, not authorized or performed

1. Owner reviews this instrumentation-only candidate.
2. Separately authorize an internal diagnostic **Build 71** containing the
   native hooks **and matching JS**. Deliberately select a runtime/update-channel
   boundary so the existing runtime1.3.1 OTA cannot replace its diagnostic JS.
   No build number, runtime or channel was changed in this validation.
3. Inspect that produced binary's actual DEX and resolved vendor versions
   before treating these hooks as installed. Release shrinking remains a
   separate validation step; this debug compile does not substitute for it.
4. Separately authorize Railway deployment of the opt-in backend observer for
   backend correlation. Native traces alone do not supply handler timing.
5. No OTA is needed if Build 71 bundles the matching diagnostic JS. A later
   matching-runtime OTA is optional only if separately authorized; an OTA
   cannot add these hooks to Build 70.
6. Separately authorize installation/collection on affected and healthy-control
   phones: natural slow startup, unattended stationary interval, and protected
   moving/background capture comparison.

No merge/push, Railway deployment, OTA, production build/configuration/data
change or phone operation was performed. Neither underlying issue was fixed.
