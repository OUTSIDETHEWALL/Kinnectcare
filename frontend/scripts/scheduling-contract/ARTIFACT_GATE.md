# Build 78 future artifact gate

This file is a procedure, not authorization to build or install. Do not run an
EAS build, change versionCode/runtime/channel, upload or install in this assignment.

## Before a separately authorized native build

The repeatable non-release entry point is:

```sh
cd frontend
npm run verify:diagnostic78 -- <current-generated-frontend> <ndk-27.1> <generated-evidence-output>
```

Use an isolated diagnostic78 Expo-generated project with current plugins AND
module sources, not just a patched dependency copied over an older clone.
The gate refuses mismatched generator/header copies, missing source substitution,
missing actual compile databases/objects, stale objects, absent linked libraries,
absent AGP monitor instrumentation and missing compiled JS witnesses. It runs
the four-ABI cold checks/negative controls, strict Kotlin contracts, JNI/file
integration and activation checks. Its Gradle tasks compile/link libraries,
transform classes, compile intermediate DEX and compile JS/assets; they do NOT
package an APK/AAB. `mergeDexRelease` is needed to exercise dependency ASM;
`transformReleaseClassesWithAsm` alone only covers the app's own classes.
Missing tools or an unexecuted ABI are failures, never skips.

On this Nix verification host, existing ICU 76.1 has split development and runtime
outputs. Set standard `CMAKE_INCLUDE_PATH=<icu-dev>/include` and
`CMAKE_LIBRARY_PATH=<icu-runtime>/lib` for the command. The host Hermes CMake
configuration requires ICU >=52 `uc`, `i18n`, `data`; its installed
`doc/BuildingAndRunning.md` documents ICU as a Linux build prerequisite.
Android-target Hermes explicitly excludes this host ICU discovery. Never bypass
it, disable a Hermes component, or copy host libraries into the Android target.
No RN/Hermes/Expo/AGP/Gradle/NDK upgrade or Hermes source patch is required.
Use the existing Java 17 / SDK / Gradle cache via the usual environment variables.

Do not assume that an EAS image contains ICU development headers. Expo's current
[Expo Go pre-install hook](https://github.com/expo/expo/blob/main/apps/eas-expo-go/scripts/eas-build-pre-install.sh)
explicitly installs `icu-devtools libicu-dev` for Android source builds; Expo also
documents that supported approach in
[eas-cli issue 1538](https://github.com/expo/eas-cli/issues/1538).
The published SDK image inventory alone does not prove those packages exist.
This local verification does not claim that a remote build was executed.

RN 0.81.5 enables Kotlin `explicitApi()`. Diagnostic declarations must retain
explicit visibility/types. The standalone Kotlin contracts now use
`-Xexplicit-api=strict`; passing a default-mode fixture is insufficient.

Invocation guards must also preserve the whole operand-stack prefix before any
swallowing exception handler. This includes a pending constructor's uninitialized
object references and wide primitive values. The JVM fixture covers those cases,
original exceptions and a throwing observer. Analyze original instructions
outside the rewriting adapter and recompute frames for instrumented classes;
per-method recomputation left remapped locals with invalid frames in real D8.
The gate rejects `Invalid stack map table` even if D8 only warns.
Standalone Java shims explicitly target Java 17 too: this host's `javac` on PATH
can differ from the Java selected by Kotlin through `JAVA_HOME`.

1. Run `node scripts/verify-scheduling-prebuild.js`, `bash
   scripts/verify-scheduling-tracing.sh`, `bash scripts/verify-request-origins.sh`
   and the relevant Jest suites. Preserve all results, including failures.
   Also run `node scripts/verify-scheduling-activation.js`,
   `bash scripts/verify-scheduling-integration.sh`, and
   `bash scripts/verify-scheduling-ndk.sh <ndk-27.1-path> <generated-output>`.
   Also run `bash scripts/verify-scheduling-cold.sh`. The NDK cold gate requires
   QEMU user-mode runners and executes fresh freestanding NDK binaries for ALL
   four ABIs, rejecting unsafe controls. Require 4/4 PASS; compiler/disassembly
   success alone is insufficient. These adapters are not Bionic/phone proof.
2. In the generated Android project, verify settings dependency substitution of
   both `com.facebook.react:react-android` and legacy
   `com.facebook.react:react-native` to the included RN 0.81.5 source project.
   Confirm the resolved Gradle dependency graph uses that project, not Maven's
   uninstrumented AAR. Hermes must remain the pinned dependency.
3. Verify exact-once Build 77 and Build 78 JS transforms, JavaTimerManager and
   RN instance transforms, `SchedulingProbe.kt`, the two native headers, C++
   timer/executor/task/microtask call sites, and AGP monitor-visitor registration.
   The source preflight alone does not prove Gradle resolution or compilation.
4. Keep source/lockfile/dependency/toolchain/ABI manifests and full native debug
   symbols for comparison against the eventual delivered library.
   The RN source build also schedules a host hermesc build. In a local Nix
   toolchain its CMake configuration requires discoverable ICU. Verify those
   real compile prerequisites, not merely the successful dependency report.
5. Expected native targets: `SchedulingCore.h` is compiled into RN's bridgeless
   timer/runtime and runtime-scheduler objects; `SchedulingJni.h` is compiled
   through `JJSTimerExecutor.cpp` in the Android runtime JNI object. Android's
   merged deliverable is `libreactnative.so` for each shipped ABI. This is not
   the unmodified Maven RN AAR and not a separate newly linked application SDK.

## Inspect the AAB and generated APKs after build authorization

1. Record SHA-256 of the immutable AAB and the Play/bundletool-generated APKs.
   Check manifest versionCode, runtimeVersion/channel and actually delivered ABI
   against the separately approved build identity. Inspect every shipped ABI.
2. Extract with `unzip -l <artifact>` first, then extract selected `base/dex/`,
   `base/lib/<abi>/libreactnative.so`, JS/Hermes bundle and Expo configuration.
   APK locations differ: `classes*.dex`, `lib/<abi>/` and `assets/`.
3. Use `readelf --dyn-syms --wide libreactnative.so` (or NDK `llvm-nm -D`) to
   require all `Java_com_facebook_react_runtime_SchedulingProbe_*` producer/
   lifecycle symbols and all `Java_expo_modules_startupdiagnostics_
   SchedulingBridge_*` symbols. Name presence proves linkage only, not call sites.
4. Match the ELF build ID (`readelf -n`) and `.text` against the same build's
   unstripped library/native debug symbols. Use NDK `llvm-nm --demangle` and
   `llvm-objdump --demangle --disassemble` on that matched native binary to locate:
   * TimerManager::createTimer selected association before platform registration.
   * TimerManager::callTimer submission probe before runtimeExecutor_.
   * Its existing lambda entry/lookup probe before callback invocation.
   * ReactInstance's underlying runtime executor and runtime initialization.
   * RuntimeScheduler_Modern task and microtask guards.
   * JNI fixed-field admission and worker-only drain implementations.
   LTO may inline observer methods; retain symbol/source mapping and inspect the
   actual call-site instructions. A header, marker string, exported JNI function,
   host simulation or source `.cpp` file is NOT proof of these compiled probes.
5. Use Android `dexdump`/`apkanalyzer` or JADX to inspect actual DEX call sites:
   JavaTimerManager registration entry/admission/deletion; gate/frame branches;
   dispatch after the timer monitor; SchedulingProbe lifecycle activation;
   headless invocation `hold`/`release` on success AND exceptional paths; Activity
   lifecycle registration; app bridge exports and independent bootstrap.
   Trace all SDK/background-fetch/RN task callers. Check cleanup-handler priority
   and annotation indexes, not just the number of added calls.
6. Disassemble the actual Hermes bundle (matching Hermes tooling) or inspect the
   uncompiled bundle as appropriate. Verify old XHR/fetch/FileReader/JSON stages
   remain, old `fetch_callback_scheduled` precedes real registration, new begin/
   return bracket the original timer, callback entry is inside that original
   callback, and the abort timer is still exactly 8,000 ms.
7. Verify existing request-origin/native HTTP/lifetime/shared-flight probes and
   exports. Inspect `SchedulingTrace`, bounded retention and persistent worker
   path after R8. The new producer call chain must not reach synchronous startup
   checkpoint persistence, disk/JSON, class/reflection setup, worker startup,
   readiness waits, JNI thread attachment or newly posted JS/frame work.
   Inspect first-use `holdNative`, registration and executor observer call
   graphs, including compiler-generated TLS accesses. Reject added producer-state
   `__emutls_get_address` allocation/locking; warming is not a correction.
   Verify static context storage, hardware identity reads, bounded ownership
   claims/release, no blocking fallback, explicit contextClosed/contextLoss/
   contextExhaustions on saturation and no accidental unheld admission.
   Verify Application class prewarming and disabled capture on non-diagnostic
   configurations. Inspect first execution, not only a warm benchmark.
8. Diff protected operational sources/configuration and hash unchanged native
   dependencies. RN itself necessarily differs; compare its instrumentation-only
   source/build diff and mapped instructions, not an impossible identical hash.
   Protect GPS/Transistorsoft, permissions/consent, ownership/flight decisions,
   HTTP concurrency/order/timeouts, heartbeat/WorkManager/native lifetime/backend.
   Compare the signing certificate SHA-256 against the prior approved release,
   and compare manifest permissions/components, packaged ABI/library inventory,
   dependency versions and existing native task/service declarations.
   Verify the separately approved Build78 selector/profile explicitly. This
   assignment does not add an EAS profile or change release identity.
9. Reject missing/ambiguous coverage. Do not install, upload or collect evidence
   automatically. Physical validation requires separate authorization.

## Minimal later physical acceptance

On one explicitly approved phone: ordinary foreground open, natural background/
locked use for 30–60 minutes, ordinary reopen and one export after any natural
incident. No synthetic pulse, forced Doze, stress burst or keeper-alive.
Require actual JS/native runtime binding, timer/callback IDs, lifecycle causal
scope, dual clocks, loss counters, source-stage coverage and pinned incident
references. Empty intervals mean no observed progress, never proven suspension.
No-reproduction validates instrumentation only. A localized executor gap without
its release mechanism does not authorize a corrective patch.
