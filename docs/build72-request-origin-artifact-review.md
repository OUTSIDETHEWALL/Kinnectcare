# Build 72 — request-origin diagnostic artifact review

Validated 2026-10-21. **Production-style Android AAB build and static artifact
checks PASS.** Evidence collection only: no Circle of Doom fix was implemented.
Build 70 remains the protected moving/background GPS baseline.

## 1. Artifact and source identity

| Item | Verified value |
| --- | --- |
| Approved attribution commit | `3f062ba2b04061235769261505c9037840f4a0ca` |
| Approved attribution tree | `778e2a5a907769c51b163ab7ace6af72dfe18b76` |
| Uploaded build source commit | `d9d4afeb1509472130de897de88dd293271bf656` |
| Uploaded build source tree | `723b9d00ba652158f916ad951b2341c3a7bfbd06` |
| Source branch | `fix/request-origin-attribution` |
| EAS build ID | `83ecb2b5-695a-483f-b7f5-757b8a825983` |
| Result/profile | `FINISHED` / `diagnostic72` |
| Completed UTC | `2026-10-21T22:35:38.312Z` |
| Artifact | Signed Android App Bundle, **83,476,541 bytes** |
| Android package | `app.kinnship.client` |
| versionCode / versionName | **72** / **1.3.1** |
| Android runtime | **`1.3.1-diagnostic72`** |
| Update channel / branch | **`diagnostic72`** / **`diagnostic72`** |
| Embedded JS update ID | `bc0ab957-5dcf-4ce1-946c-e3590d0164bf` |

[EAS build record and AAB download](https://expo.dev/accounts/finalcut/projects/kinnship/builds/83ecb2b5-695a-483f-b7f5-757b8a825983)

AAB SHA-256:

```text
de7189b468f8bf4f3c17d181fc7416f3e204857d8287222b475ed851ab7bc08b
```

Embedded Hermes bundle SHA-256:

```text
30c2a4098aed54b6507a6ab65570c877e50f7ef09abea2855ba913ddfc6adbc4
```

The uploaded source differs from the approved attribution revision only in
`frontend/app.config.js`, `frontend/eas.json`, and a build-configuration test.
No instrumentation compilation or packaging repair was necessary. This review
document and later documentation-only commits are not the uploaded source.

## 2. Build preparation and isolation

- Added a `diagnostic72` profile extending the existing production AAB profile.
  It uses the existing production build environment, no development client,
  no automatic version increment, and existing remote signing credentials.
- Conditional Android metadata selects versionCode 72 and runtime
  `1.3.1-diagnostic72`. Default production/Build 70 stays at versionCode 70,
  runtime policy `appVersion` (1.3.1). Diagnostic 71 stays at versionCode 71,
  runtime `1.3.1-diagnostic71`. iOS settings are unchanged.
- Created only the dedicated diagnostic72 channel/branch. Its branch has no
  published update groups. The production channel still maps to production;
  its mapping matches the prior recorded mapping. Diagnostic71 still maps to
  diagnostic71. The AAB manifest embeds diagnostic72 in its update request
  headers, and its resources embed the diagnostic72 runtime.
- Builds 70/71 updates cannot satisfy Build 72's distinct runtime. Existing
  update-check behavior remains ON_LOAD with zero fallback wait.
- The root EAS archive was inspected before submission: local tools/caches,
  generated artifacts and signing credentials were excluded. Present archived
  application files matched the approved source byte-for-byte except the
  explicitly reviewed build metadata. The lockfile was already normalized.
- Submission used Android only, profile diagnostic72, `--freeze-credentials`,
  noninteractive mode and no automatic submission. The main/store-only wrapper
  was not used because this is an explicitly authorized unmerged diagnostic
  build, not permission to merge or submit to Play.

EAS calls the profile's artifact distribution `STORE`. That is the AAB build
type, **not evidence of a Google Play upload or rollout**. No such action ran.

## 3. Packaged JavaScript hooks

Extracted `base/assets/index.android.bundle` from the delivered AAB and
disassembled the actual Hermes bytecode. Verified instruction-level call sites,
not merely source text:

- RN `sendRequest` reads/calls `__kinnshipBindRequestOrigin` before its existing
  native dispatch; the local callback reaches `originBind`.
- SDK wrapper captures `_transistorHeadlessTaskId` and `kcEvidenceWakeId`
  before deletion/dispatch and installs its existing promise handlers.
- The SDK `kcSettled` closure reaches `__kinnshipTaskSettled`; the installed
  callback records `js_settled` through `originRecord`.
- Existing Full Diagnostics `readEvidenceTrace` calls `readRequestOrigins`
  and exports `requestOrigins`.
- Initial/second ownership, cache miss, migration, device-contact, WorkManager,
  engine-startup and shared-foreground-member labels are retained.
- Optional native version/read/write/bind methods and unavailable-extension
  reporting are retained. The existing production API origin is embedded.

The first inspection assertion incorrectly expected full long identifiers in
Hermes instruction listings; Hermes abbreviates them. The verifier was corrected
to independently require full bytecode string-table names and their abbreviated
instruction-level call sites, splitting both ordinary and closure functions.
This was an inspection-tool correction, not a bundle/source repair or rebuild.

## 4. Delivered native hooks

Decoded all delivered DEX files and inspected methods and references:

- Early `MainApplication` HTTP observer installation before RN startup.
- Expo module registration and `originVersion`, `originBind`, `originRecord`,
  `originRead` entry points, including actual RequestOrigins method calls.
- Numeric RN request-tag binding, native call association, call start,
  interceptor entry, ended/failed/canceled observation, cleanup, and dispatcher
  census.
- Compact queue membership codes, missing/truncated accounting, bounded
  asynchronous storage, loss/failure counters and monotonic timestamps.
- Compiled SDK `HeadlessTaskManager` invocation/removal and finish/missing-finish
  call sites, plus the generated `KinnshipOriginBridge` reflection targets.
- Native SDK ID, React task ID, wake ID and timeout fields.
- Existing GPS, WorkManager, authority evidence hooks and all 29 delegated
  OkHttp listener callbacks remain present.

The inspector was also run against Build 71 as a negative control. It correctly
rejected that binary for lacking `originVersion`.

Native removal remains distinct from proven timeout-callback invocation.
`deadlineReachedAtRemoval` indicates elapsed deadline at removal; it does not
prove the RN timeout callback fired or cancel surviving JS work.

## 5. Complete production-style build evidence

The cloud Gradle log records **BUILD SUCCESSFUL**, `:app:bundleRelease`,
`:startup-diagnostics:compileReleaseKotlin`, and release Java compilation of
both Transistor RN wrappers. Thus the transformed complete SDK manager was
compiled in the actual Android/Expo build, not only the earlier local harness.

The unchanged production configuration did **not** run app R8 minification or
resource shrinking; there is no obfuscation mapping in this artifact. Hook
retention is verified in this delivered release DEX. Acceptance under a future
R8-enabled configuration is not claimed.

Preparation validation: TypeScript passed; **9 tests across 3 focused suites
passed**, covering build identity/isolation, request origins and native source
contracts. The approved revision's earlier 379-test/local-native-harness result
was not rerun or substituted for the complete build.

## 6. Signing, upgrade prerequisites and dependencies

Bundle signature verified. Builds 70, 71 and 72 have the same upload-certificate
SHA-256:

```text
53:7D:D1:05:5B:C1:02:27:CC:D2:95:CF:86:13:49:90:13:96:8F:94:35:5E:E9:F4:D5:66:7D:2E:45:71:C8:75
```

Static upgrade prerequisites match the existing Play AAB route: unchanged
package, increasing versionCode, upload signer, min SDK **24**, target SDK
**36**, permissions, component/export declarations, native SDK license presence
and ABI coverage (**arm64-v8a, armeabi-v7a, x86, x86_64**).

Decoded the delivered AGP dependency provenance protobuf. **No recorded Maven
version or artifact hash changed from Build 71**, including:

| Dependency | Version |
| --- | --- |
| tslocationmanager | 4.2.2 |
| tsbackgroundfetch | 4.1.1 |
| React Native Android | 0.81.5 |
| OkHttp | 4.12.0 |

An AAB upload certificate does not establish the Play-installed APK signing
lineage or prove a successful, data-preserving upgrade. Neither Play signing
configuration nor an actual phone upgrade was tested.

## 7. Protected behavior and limits

The approved instrumentation, plugins, native module and backend sources are
unchanged from the approved revision. No new coalescing, cache, authorization,
consent, generation, cancellation, native timeout, scheduling, GPS acquisition
or publication policy, HTTP policy, dispatcher/pool configuration or stationary
threshold change was introduced. Moving/background GPS remains protected.

These results establish build completion, packaged hook retention and static
compatibility. They do not establish Android runtime activation, zero observer
overhead, native reflection success on a phone, a reproduced startup backlog,
background/moving behavior, battery impact or actual request attribution.
Loss/eviction, queue limits, asynchronous buffering and process death remain
evidence-coverage limits of the approved observer.

## 8. Actions not performed

No Circle of Doom correction, merge, source push, PR, Play submission/rollout,
OTA publication, Railway/backend deployment, production data modification,
installation, or phone operation. Existing production update/channel mappings
were not changed.

The AAB is ready for owner review. Installation, physical evidence collection
and any distribution/release remain separate decisions.
