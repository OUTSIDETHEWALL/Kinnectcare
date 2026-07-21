---
name: Native module OTA rule
description: Top-level imports of packages with native code in OTA-only updates crash the JS bundle at module-eval time, taking down every screen that imports the file.
---

## Rule

Never introduce a top-level `import` of a package that has a native module in an OTA-only update. The native module must already be registered in the running binary.

**Why:**
Top-level imports in React Native (Metro) are evaluated synchronously when the module is first `require()`d — before any screen code runs, and outside any try/catch. If the native bridge has no matching module registered, the import throws, the module fails to initialize, and every file that imports it transitively also fails. The JS runtime has no renderable component → blank dark screen on every launch.

This crash is particularly dangerous because Expo's automatic OTA rollback does not trigger: the failure happens at module-evaluation time, before the framework's crash-detection heuristic can observe a "fully booted, then crashed" lifecycle. The broken bundle is written to disk and loaded on every subsequent launch → crash loop that only reinstalling or a fix OTA can break.

**Real incident:**
`expo-battery` was added to `locationRefresh.ts` as an OTA-only update (runtime 1.2.0 binary did not include it). `reloadAsync()` loaded the new bundle → instant crash → blank dark screen on both Charles's and Joyce's phones. Persistent after force-close. Required a hotfix OTA + reinstall for already-stuck devices.

**How to apply:**
- Before adding any new `expo-*` or third-party package with native code, check whether it is already in the native binary (i.e. was it in `package.json` at the time of the last `eas build`?).
- If not: defer the import to a new native build. Stub out the feature or gate it behind a runtime check.
- Safe pattern for OTA-only optional capability:
  ```ts
  // Only safe if expo-foo was already in the binary.
  // If adding via OTA, defer to next native build.
  let Foo: typeof import('expo-foo') | null = null;
  // populated lazily after confirming native build version
  ```
- `try/catch` around the *call site* is NOT sufficient — the import itself (top-level) is what crashes.
