# Diagnostic Build 71: artifact validation

Validated on 2026-10-20. **Artifact checks PASS; no installation or deployment
has been authorized or performed.** Neither underlying startup nor stationary
GPS defect is fixed. Build 70 remains the protected moving-GPS baseline.

## Exact identities

| Item | Verified value |
| --- | --- |
| Approved instrumentation base | `ed652212e66b83cfe6d25ffdf1cb6912f6d9ab70` |
| Approved instrumentation tree | `aeab0052fa358a448a5cc2569fb2357bebde4f52` |
| Build 71 source commit | `f7ee8479cb9f0fe9656bc84345ec1ecf43fa826a` |
| Build 71 source tree | `3b942df874670ebd40f30641b270d183ea05e38e` |
| Source branch | `fix/diagnostic-build71-evidence` |
| EAS build ID | `7a8ab267-7368-4513-846f-773f5d9d6f8c` |
| EAS result | `FINISHED`, Android, profile `diagnostic71`, distribution `STORE` |
| Artifact | Signed Android App Bundle, 83,462,863 bytes |
| Package | `app.kinnship.client` |
| versionCode / versionName | **71** / `1.3.1` |
| Android runtime | **`1.3.1-diagnostic71`** |
| Update channel / mapped branch | **`diagnostic71`** / **`diagnostic71`** |
| Embedded JS update ID | `1ea2c9fa-749d-4f61-b70a-a84ac2fd83fc` |
| Build completed | `2026-10-20T21:48:45.008Z` |

[EAS build record and artifact download](https://expo.dev/accounts/finalcut/projects/kinnship/builds/7a8ab267-7368-4513-846f-773f5d9d6f8c)

AAB SHA-256:
`bb3871717b39be3608db1dbb714a45f7fa5a243b9e3f3e3d530bd49337b6f2ad`

Embedded Hermes bundle SHA-256:
`c28c27640ce470320e79b71d9b4c8e97fec77933c94728dda47a881c25df442a`

The source identity above is the actual EAS build-record commit and its Git
tree, not a later documentation commit. Signing credentials and existing
EAS-hosted build secrets are external build inputs; they are not committed.
No new signing credentials were generated.

## Runtime isolation and matching JS: PASS

- The diagnostic profile extends the existing production profile, preserving
  its API origin and remote credentials, but selects a separate channel and
  an explicit Android-only runtime. Automatic version increment is disabled.
- Default application configuration still produces versionCode 70 and runtime
  policy `appVersion`; all pre-existing EAS build/submit profiles are unchanged.
  A focused configuration test verifies that only Android versionCode/runtime
  change when the diagnostic profile flag is enabled.
- Read-only EAS channel inspection confirmed that `production` still maps to
  `production`, while `diagnostic71` maps to its own distinct branch.
- Actual release resources/manifest confirm runtime `1.3.1-diagnostic71` and
  request header `{"expo-channel-name":"diagnostic71"}`. Build 70's actual
  reference binary has runtime `1.3.1`, channel `production`.
- Those runtimes are incompatible: a diagnostic-runtime OTA cannot be selected
  by Build 70, and the existing runtime-1.3.1 OTA cannot replace Build 71's JS.
  No OTA was published.
- The inspected upload archive preserved **251 reviewed JS/native/build-input
  files byte-for-byte**, excluding the two deliberately modified configuration
  files. Existing tracked client defaults and public Firebase client config were
  retained; workspace tooling, caches and server/signing credentials were excluded.
- The actual embedded Hermes bytecode was extracted and disassembled. It
  contains the matching evidence APIs, startup trace header, JS startup/wake/
  authorization/publication stages, GPS correlation keys and production API
  origin. Native hooks do not depend on a later OTA.

The first submission attempt was stopped during local compression before any
cloud build was created. Archive inspection identified the repository-root EAS
ignore scope; exclusions were corrected and checked before the one cloud build
above was submitted. No duplicate Build 71 cloud build was submitted.

## Actual release DEX and shrinking: PASS within the stated scope

Inspected **five delivered DEX files and 169 selected classes**, rather than
relying on source markers or the earlier debug class outputs. All hook checks
passed:

1. Application installs the HTTP observer before React Native loading.
2. RN registry includes both Transistor packages.
3. Expo registry includes the startup diagnostics module.
4. Expo evidence functions reach native record/read/claim implementations.
5. Bounded queue, persistent page store and loss/coverage reporting are present.
6. HTTP transport stages and the occupied-global-hook refusal path are present.
7. All **29** HTTP listener callback overrides remain.
8. Native configuration/acquisition claim evidence and rejection reasons remain.
9. GPS headless wake, queue, context, invocation and completion/error paths remain.
10. Native position request and success/error callback hooks remain.
11. Location wrapper reflection reaches the correctly named evidence bridge.
12. BackgroundFetch reflection reaches the correctly named evidence bridge.
13. WorkManager headless wake/invocation/completion/error/skip paths remain.

The completed cloud log contains `:app:bundleRelease` and `BUILD SUCCESSFUL`.
It contains no application `minifyReleaseWithR8` or resource-shrinking task,
and the AAB contains no obfuscation mapping metadata. The existing release
configuration leaves those optimizations disabled; it was not changed to
force this result.

**Conclusion:** the hooks survive the actual release build. This is **not** a
claim that they were tested under enabled R8, nor that Android has executed
them on a phone. Any future change enabling shrinking needs another delivered
binary inspection.

## Signing and upgrade compatibility

The actual finished Build 70 AAB was downloaded again and matched its previously
recorded SHA-256:
`836c16ff8833e607f540e2230f14cbc2a9f09de4c7ae5fa1fe3d17c382c9d6dc`.
Both bundle signatures were verified locally.

Build 70 and Build 71 have the **same upload-signing certificate**, SHA-256:

`53:7D:D1:05:5B:C1:02:27:CC:D2:95:CF:86:13:49:90:13:96:8F:94:35:5E:E9:F4:D5:66:7D:2E:45:71:C8:75`

The build used the existing remote Android credential configuration with
`--freeze-credentials`; no credential update was permitted.

Static prerequisites for the existing **Google Play AAB upgrade route PASS**:

- Same application package, with versionCode increasing from 70 to 71.
- Same upload signer.
- Same minimum SDK **24** and target SDK **36**.
- Same four ABI families: arm64-v8a, armeabi-v7a, x86, x86_64.
- Same declared permissions and application component/export declarations.
- The existing Transistor native license is present.

`jarsigner` reports the expected self-signed/untrusted-CA-chain and absent
timestamp notices; bundle signatures verified. Android upload certificates are
not browser/TLS CA certificates. The unchanged signer expires in 2053.

**Important limit:** an AAB's upload certificate is not proof of the certificate
on a Play-installed APK. This stage did not independently inspect Play's
app-signing configuration, obtain Play-generated APKs, or perform a phone
upgrade/data-preservation test. Thus upload-signing continuity and static
upgrade eligibility are confirmed; **installed Play signing lineage and an
actual successful upgrade are not claimed verified**. Do not sideload a
differently signed derived APK as a substitute. No installation clearance is
implied by this report.

## No changes beyond the reviewed instrumentation

Relative to the approved candidate, application changes are limited to
conditional Android build identification and the diagnostic EAS profile.
Other changes are archive exclusions and a focused configuration test.
No JS tracking, GPS/native authority, consent, scheduling, transport, retry,
timeout, dispatcher or connection-pool implementation changed.

The reviewed **60-minute stationary** threshold and moving behavior are
unchanged. No new SDK listener, OS scheduling primitive or wake lock was added.
The original instrumentation safety/retention findings remain documented in
`docs/native-evidence-compile-review.md`.

Delivered AGP dependency provenance was decoded from both AABs. **Every recorded
Maven dependency version and artifact hash matches Build 70**, including:

| Delivered dependency | Version |
| --- | --- |
| Native `tslocationmanager` | **4.2.2** |
| Native `tsbackgroundfetch` | **4.1.1** |
| React Native Android | **0.81.5** |
| OkHttp | **4.12.0** |

This checks resolved vendor artifacts, not just floating version selectors.
The wrapper source packages remain geolocation 5.2.0 / fetch 4.4.2.

Confidence is high in artifact identity, inspected hook retention, unchanged
reviewed inputs and static compatibility. Static inspection cannot establish
zero observer overhead or prove real moving/background behavior.

## Matching Railway candidate: prepared, NOT deployed

- Commit: **`ed652212e66b83cfe6d25ffdf1cb6912f6d9ab70`**
- Tree: **`aeab0052fa358a448a5cc2569fb2357bebde4f52`**
- Active deployment source: the `backend/` tree.
- That backend tree is unchanged between the approved candidate and Build 71's
  source commit. No additional backend change was necessary.
- Existing instrumentation correlates the same opaque request ID on the four
  reviewed GET endpoints. It captures stage timing on the request path and
  sends metadata to a **96-record nonblocking queue/daemon writer**.
- Diagnostic admission is limited to **32 marked requests/minute/process**;
  it never rejects, retries or delays application requests for this budget.
  Queue overflow, writer failures and budget skips remain coverage limitations.
- **Seven focused tests passed**, including blocked-logger noninterference and
  preservation of response/exception/stream behavior.

No backend server was launched against production data, and Railway was not
deployed or reconfigured. The candidate is prepared locally, not pushed/merged.

## Remaining evidence-contamination and acceptance limits

- Observer thread creation, enqueueing, metadata/reflection/allocation work and
  background disk writes have nonzero, physically unmeasured cost.
- Queue overflow, admission sampling, failed writes, suspension and process
  death can lose evidence; the one-second debounce is not a durability deadline.
- A declined HTTP installation still permits JS/backend correlation but not
  native HTTP spans. Current-process installation status does not certify
  historical per-request coverage.
- Application-interceptor admission time is not exact dispatcher queue time.
  Response body completion to JS settlement remains a mixed residual; the
  precise RN emission-to-XHR boundary is still not implemented.
- No physical startup, overnight stationary, moving/background, battery-impact
  or real upgrade test was run. Those remain separately authorized collection
  and acceptance work, not proven by successful compilation/DEX inspection.
- Installed Play signing lineage remains outside this AAB-only validation.

## Evidence and authorization boundary

Ignored local evidence is in `.cache/kinnship-eas-build71/`: both AABs,
source archive comparison manifest, EAS records, signature/manifest/dependency
reports, actual DEX hook bodies, Hermes disassembly, cloud task coverage,
backend test log and `verification.json`. Large artifacts are excluded from
Git and Replit deployment.

**Performed:** one diagnostic cloud build, artifact download, local static
validation, and preparation of the matching backend observer.

**Not performed:** any phone operation/install, Play upload/submission, OTA
publication, Railway deployment, production configuration/data change, Git
push or merge. Google Play production remains on HOLD. Deployment/installation
must wait for separate owner approval after reviewing these results and limits.
