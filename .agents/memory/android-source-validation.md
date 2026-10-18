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
