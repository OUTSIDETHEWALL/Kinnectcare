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
