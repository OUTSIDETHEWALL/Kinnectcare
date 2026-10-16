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
