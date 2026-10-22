---
name: Mobile deployment workflow
description: Kinnship's authoritative release path after merged pull requests.
---

Kinnship is a mobile app, not a Replit Web Publish deployment. After every approved PR merges, first classify the merged change as backend, mobile JavaScript/React Native, both, or non-deployable (tests, documentation, diagnostics planning, or project memory). Deploy only the affected surface: backend changes go to Railway; mobile JavaScript/React Native changes go through the existing Expo EAS production OTA workflow; when both changed, deploy Railway first, verify health, then publish the OTA. Non-deployable changes receive no deployment. Android and iOS native builds use EAS Build only when native changes require them.

**Why:** The production system is Railway for FastAPI backend services and Expo EAS Update for React Native/Expo JavaScript. Replit Web Publish targets a website and is the wrong release mechanism for this app.

**How to apply:** After a merge, inspect the merged diff before taking any release action. Interpret “publish,” “deploy,” “ship,” “release,” and “go live” as the established Kinnship workflow, never Replit Web Publish. Use Replit Web Publish only when the user explicitly says: “Publish the website to Replit.” For a backend-only release, deploy Railway and verify health. For a mobile-only release, publish the OTA. For both, complete and verify Railway before publishing the OTA. For tests, documentation, diagnostics planning, or project memory only, do nothing operationally. For an OTA, use the repository's established publish script, verify the production API URL and runtime version, clear Metro cache as required, and report the OTA group ID, platform update IDs, runtime version, and commit SHA.

## Device evidence chronology

Respect platform-specific release authorization even when the production channel
serves multiple platforms. Pin the reviewed source commit/tree and runtime before
publishing; inability to verify GitHub main must stop delivery, not become a warning.

**Why:** An Android-only delivery review found that the routine publishing path
could otherwise update iOS too and rely on stale remote-tracking state.

**How to apply:** Verify the effective platform and live channel/branch mapping
before publication. Do not treat runtime compatibility as authority to release
to an additional platform.

An earlier diagnostic export does not establish which OTA is active during a later physical test. Confirm the software diagnostics screen's installed update and runtime at the time of the test before attributing results to a release.

**Why:** A physical test confirmed the expected OTA was active after an earlier export had been captured; treating the older export as current would have misclassified a validated notification-routing correction as absent.

## Separately authorized PR-native validation

A controlled native validation build is not a release. When the user authorizes
building an unmerged PR and forbids merge/Play submission, do not run the
main/store-only wrapper or merge just to satisfy its guards. Use the verified PR
commit in an isolated checkout and document any build-only APK profile override;
keep production identity/configuration and the existing signing credentials.
Do not silently increment or assume the resulting versionCode.
An APK reusing the already-installed Build 68 number is compile evidence only,
not unambiguous physical-validation identification. A uniquely numbered physical
test binary requires the user's separate authorization.

**Why:** The user separately authorized a new Android binary for controlled
physical validation while explicitly forbidding all production/release actions.
The user explicitly distinguished successful compilation from a uniquely
identifiable physical-test build.

**How to apply:** Verify local/remote/PR equality first, normalize the lockfile,
freeze existing credentials, record the exact uploaded source commit and temporary
profile differences, and distinguish artifact creation from installation/release.

Cloud builds survive a Replit workspace restart even when local `/tmp` state and
the waiting CLI disappear. Recover the existing build by its EAS identifier;
query its status before considering resubmission.

**Why:** A workspace restart removed the isolated checkout and CLI watcher after
upload, but the same remote build continued with the correct source commit.

**How to apply:** Keep the build identifier in the handoff and resume observation,
not submission. EAS log responses may be Brotli-compressed; use an HTTP client
that honors Content-Encoding before interpreting their contents.

**How to apply:** Separate export capture time, OTA activation time, and test time. Prefer direct active-update evidence for the tested launch; do not extrapolate it backward to an older log.

## Protected diagnostic baseline and coordinated approval

Build 70 remains the protected known-good moving-GPS baseline. Building a
diagnostic artifact does not authorize installing it, deploying its backend
correlation observer, publishing an OTA or changing production configuration.
Client/server evidence collection requires separate coordinated approval after
the artifact review.

**Why:** The owner requires inspection before authorizing the Railway
instrumentation and diagnostic phone update together.

**How to apply:** Preserve the baseline during preparation. Report bundle
upload-signing continuity separately from the Play-installed app signing
lineage and an actual data-preserving upgrade; an AAB signature alone does not
prove those device-level properties.