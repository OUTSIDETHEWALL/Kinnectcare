# Build 77 — complete diagnostics with nonblocking producers

## Delivered result: both gates PASS

The actual finished AAB is eligible to recommend for **separately authorized
physical validation**. This is not installation/distribution authority or
physical confirmation of either underlying defect.

- **Diagnostic completeness: PASS**
- **Nonblocking recorder safety: PASS**
- Native response hooks: **5 / 5**
- Native FileReader hooks: **11 / 11**
- Required JS marker types with real call sites: **95 / 95**
- Full Diagnostics `deepAsyncEvidence` property-writing function and packaged
  native reader verified in Hermes.
- Producer audit: **74 roots / 149 reachable app-owned methods**, zero forbidden
  producer edges. All **48 recorder classes** have unchanged implementation
  fingerprints from the actual Build 76 artifact.

### Immutable native artifact identity

- EAS build: `28f98fc5-8c3f-4d9e-894f-9e49ce2e7c2a`
- Package: `app.kinnship.client`
- VersionName/versionCode: `1.3.1` / `77`
- Runtime/channel: `1.3.1-diagnostic77` / `diagnostic77`
- Native source commit: `3c547451cdc223456fee88e939753da2d40b19a3`
- Native source tree: `326c2b968ec5b7b2cc0172818ae832ff051accfc`
- AAB size: **83,497,620 bytes**
- AAB SHA-256: `a1d7b9be2480a2d911470b4df5ddaa0c1efe38d7c83ac3c53ae24d72b60e6d78`
- AAB signature verified by jarsigner; upload signer certificate SHA-256:
  `53:7D:D1:05:5B:C1:02:27:CC:D2:95:CF:86:13:49:90:13:96:8F:94:35:5E:E9:F4:D5:66:7D:2E:45:71:C8:75`

### Delivered baseline comparison

All **342 resolved Maven coordinate/digest records**, **45 permission
declarations**, **55 components** and all four ABIs (`arm64-v8a`, `armeabi-v7a`,
`x86`, `x86_64`) match Builds 74/75. The upload signer, packaged SDK
configuration, backend endpoint set, 22 native lifetime/HTTP class method
fingerprints and Build 75 pathological-retention implementations match their
baselines. Builds 75 and 76 were hash-verified and remain rejected/immutable.
The 16 critical archive files matched the frozen source before submission.
There are no business-JavaScript/backend changes from Build 76, and the native
module source is byte-identical to its validated safety source.

Native recorder verification emitted **22 passing checks**, zero failures;
lifetime verification emitted **12 passing checks**, zero failures (including
separate process runs). These host/JVM observations are not phone acceptance.
The full JavaScript baseline failure described below remains unresolved.

No application source changed after the native source freeze. Only this outcome
documentation follows it. Work stopped after delivered inspection/report:
no merge, deployment, OTA, Play upload, phone installation or Build 78.

## Authorization and scope

Restore Build 75's delivered deep instrumentation while keeping Build 76's
nonblocking recorder architecture. No GPS, ownership, authorization, sharing,
HTTP/dispatcher, native-task lifetime, WorkManager, heartbeat, privacy or backend
behavior is changed. No merge, release, OTA, Play upload or installation.

## Exact activation rule

Both app identity and the real config-plugin entrypoint call
`plugins/diagnosticBuild.js`.

Deep instrumentation is enabled if and only if `KINNSHIP_DIAGNOSTIC_BUILD` is a
canonical decimal integer string, with no leading zero, from 71 through
2,100,000,000 inclusive. That explicitly selected diagnostic version is used for
Android versionCode and `1.3.1-diagnostic<versionCode>` runtime identity.

Unset or invalid input retains normal production identity and does not register
the deep transformer or dependency-JS patches. There is no per-version allowlist
and no special comparison to 75. Versions 77, 78, 79 and later valid diagnostic
versions use the same activation path. Normal production remains unchanged.

The new `diagnostic77` EAS profile inherits production, selects its production
environment and existing AAB signing configuration, disables automatic version
increment, and uses distinct `diagnostic77` channel and versionCode 77. Historical
profiles and already-built artifacts are not changed.

## Pre-submission evidence

- Real plugin entrypoint tests exercise diagnostic and normal/invalid selections,
  including future versions, with the actual Expo config-plugin registration.
- Full TypeScript check passed.
- Full Jest: **1,073 passed, one failed**, 95 suites. The unchanged legacy
  repository audit still rejects existing fixture strings. No unrelated fix.
  The activation suite passed after correcting a test-only transformer-name typo.
- A real isolated `expo prebuild --platform android --no-install` succeeded.
  Its generated Gradle contains the exact transformer and ALL-class registration.
  Its isolated dependency files contain real callback calls: XHR 3/3,
  FileReader-JS 3/3, fetch source 12/12 and fetch UMD 12/12.
- The transformer extracted from that generated Gradle transformed actual RN
  0.81.5 release classes: **5/5 native response hooks, 11/11 native FileReader
  hooks**, 3 classes and 16 total calls. This is a local transform, not delivered
  DEX proof.
- The isolated production Hermes bundle and immutable Build 75 bundle both
  contain **95/95 required JS marker call sites**. This includes full dependency
  request/receipt/fetch/body/JSON stages, shared-flight create/join/settlement,
  authorization/recovery and WorkManager correlation.
- Generated Application independently starts RecorderBootstrap. All six recorder
  infrastructure sources are byte-identical to the validated Build 76 source.
  Preferential pathological retention and Full Diagnostics `deepAsyncEvidence`
  export remain present.
- Actual compiled observer/OkHttp tests passed: 120 delegates and all 120 complete
  correlated histories, zero observer loss, dispatcher queue peak at least 100.
- Cold, delayed initialization/storage, blocked writer, saturation, concurrent
  cold, failure/recreation, shutdown, unpublished reservation and all-three-facade
  fail-open tests passed. Existing correlation, privacy and retention tests passed.
- Stress: 160,000 attempts; worst producer sample **21,858,914 ns**; **157,952**
  dropped; queue high-water **2,048**; worker failures **0**. Separate concurrent
  cold maximum **47,162,703 ns**. Host/JVM observations, not phone latency or
  Android scheduling acceptance.
- Compiled native lifetime/liveness and generated-bridge tests passed.

## Delivered gate and stop

Inspect the actual finished AAB, not only these source and host results. Require
both complete coverage and nonblocking safety, verify signing/dependencies,
permissions/components/ABIs, SDK configuration, endpoints and baseline lifetime/
HTTP implementations, and report exact hook and JS marker counts.

Reject and stop if either coverage or safety fails. Do not create Build 78.
After Build 77 inspection, stop and report; physical distribution is separate.

Build 74 remains the current physical-phone baseline. Builds 75 and 76 remain
rejected and immutable. GPS is **REPRODUCED — exact async failure mechanism not
yet proven**. Circle has **live request fan-out demonstrated — complete severe
launch mechanism not yet proven**.
