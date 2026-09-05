---
name: Verify bundle identity first
description: Required diagnostic gate when a physical device appears unchanged after a production OTA.
---

When physical-device behavior contradicts a supposedly active OTA, stop root-cause changes until the running JavaScript bundle is identified from live `expo-updates` values. A static version label is insufficient; use `isEmbeddedLaunch`, `updateId`, `channel`, and `runtimeVersion`.

**Why:** An embedded or previously cached bundle can keep rendering familiar UI when the expected OTA was never applied, was rejected, failed during launch, or rolled back. Debugging that stale UI produces untrustworthy conclusions.

**How to apply:** Put an unmistakable, non-interactive marker on the affected screen that reports the live bundle identity. Confirm its values on the physical device before changing touch, navigation, onboarding, or other suspected logic.