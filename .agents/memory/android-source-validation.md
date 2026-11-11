---
name: Android source validation constraints
description: Expo prebuilt publications can bypass native patches; full SDK validation needs workspace-backed cache storage.
---

## Native patches must be compiled from source

Explicitly opt patched Expo modules out of published precompiled Android AARs using Expo's autolinking buildFromSource configuration.

**Why:** Expo can successfully build an app using the original published library while completely bypassing a locally patched Kotlin file. Prebuild success and source-string tests do not prove that patch is included.

**How to apply:** Check the real Gradle graph and compiled class methods for every native source patch. A precompiled-package entry in autolinking output is not evidence that modified source compiled.

## Full Android SDK builds need workspace-backed storage

Use an ignored workspace-backed cache for the SDK, Gradle cache and disposable checkout rather than keeping the full toolchain in /tmp.

**Why:** Temporary storage returned disk-quota errors despite df reporting substantial free space. The same exhausted storage also coincided with a JVM SIGBUS in performance-data sampling.

**How to apply:** Treat quota and host-JVM failures as validation-environment failures, not candidate compilation errors. Preserve logs, bound build concurrency, and do not report a native PASS until the complete task actually finishes.

## Audit the delivered vendor binary, not only the dependency cache

When attributing Android SDK lifecycle behavior, inspect the existing delivered
AAB/DEX if Maven dependencies use floating versions. A workspace-cached AAR
alone is not proof of what the installed binary contains.

**Why:** The native location SDK uses a floating patch-version selector.
Source review can establish the requested behavior but not the exact cloud
build's implementation. Disassembly of the existing artifact establishes both
the SDK version and the real notification launch/service paths without a build.

**How to apply:** Recover the existing finished build record, inspect its
artifact read-only outside Git, and record its checksum in the review evidence.
Do not rebuild, pin dependencies, change PendingIntent flags or infer a device
service failure merely to make a lifecycle hypothesis fit.

## EAS archive scope is the repository root

In this monorepo, put EAS upload exclusions at the repository root. EAS CLI
does not inherit the host's global Git excludes, and frontend/.easignore does
not protect workspace-root caches or tool configuration.

**Why:** Local validation caches and tooling can otherwise enter the upload
even though Git status is clean. An archive inspection may retain empty
directories; inspect contained files, not directory existence alone.

**How to apply:** Inspect the upload archive before submission. Exclude local
tooling, evidence and server/signing credentials while retaining native module
sources, public Firebase client configuration and tracked client-only defaults.

## Delivered dependency provenance

Use the AAB's AGP dependencies protobuf to compare resolved Maven coordinates
and artifact hashes with the baseline, not only requested version selectors.

**Why:** A floating SDK selector can resolve differently between builds without
any source diff. The delivered dependency provenance distinguishes that risk
from observer-only source changes.

**How to apply:** Compare location/fetch SDK and HTTP/RN artifacts alongside
actual DEX hook inspection; source equality alone is insufficient.

## Hermes disassembly identifiers

Hermes abbreviates long string operands in instruction listings. Validate full
names in the bytecode string table separately from abbreviated instruction
references, and parse both Function and NCFunction closure boundaries.

**Why:** A full-name search can falsely report a missing packaged hook, while
ignoring closure boundaries can falsely combine unrelated call sites.

**How to apply:** Inspect the delivered bundle, require both names and real
call sites, and distinguish verifier corrections from application repairs.

## Packaged Expo runtime identity

The embedded Android asset manifest may contain only asset metadata, without
runtimeVersion. Verify the native runtime through the manifest's referenced
Android string resource, and verify the channel through the updates request
headers.

**Why:** Assuming a runtimeVersion field in the embedded asset manifest can
make the verifier fail even when the delivered native runtime is correct.

**How to apply:** Resolve the packaged resource rather than inferring runtime
identity from a missing JSON field or from the EAS profile alone.

## EAS archive inspection can retain empty excluded directories

When auditing exclusions in an inspected source archive, test for forbidden
files and material, not just directory existence.

**Why:** The EAS archive inspection copier retained empty directory skeletons
for excluded workspace tooling and generated-output paths. A directory-only
check falsely reported their inclusion even though none of their files shipped.

**How to apply:** Inspect contents recursively, verify critical source hashes,
and fail any upload gate with a nonzero exit that actually stops submission.

## Verify profile activation, not just a transform in isolation

Every new diagnostic profile must activate the complete config-plugin chain,
including dependency-JS patches and Gradle ASM registration.

**Why:** A legacy exact-profile check skipped both transformations for a newer
profile, even while standalone real-RN-class transformation tests passed.
Only the delivered AAB exposed the missing native and Hermes call sites.

**How to apply:** Test the real profile-specific plugin entrypoint and inspect
generated native configuration before submission; retain actual delivered-Dex
and Hermes coverage gates. A passing transformer test cannot replace either.

## Packaged ELF instruction decoding and symbol coverage

Include weak function symbols as well as ordinary text symbols. Match nested
constructor closures in raw mangled form when LLVM cannot demangle them.
Bind packaged debug metadata to the shipped ELF by build ID, normalize ARM
Thumb symbol addresses, and explicitly select Thumb decoding for Thumb code
in stripped ARM libraries that lack local mapping symbols.

**Why:** Otherwise present runtime-executor hooks can look absent, and ARM
instruction bytes can decode as unrelated instructions. A clean forbidden-call
scan over incorrectly decoded instructions is not meaningful safety evidence.

**How to apply:** Inspect the actual packaged ELF at the bound symbol ranges;
validate decoding with recognizable instructions and real diagnostic call
targets before accepting presence or producer-safety results.

## Hermes property-call witnesses

Follow full string operands in both property loads and string loads when
looking for executable diagnostic witnesses. Require actual call instructions
in the same function, not merely a string-table match.

**Why:** Calls through global diagnostic properties compile as GetById rather
than LoadConstString. A string-load-only scanner misses genuine timer hooks.

**How to apply:** Preserve bytecode-reader storage while parsing functions,
and validate the scanner against known packaged positive controls.
