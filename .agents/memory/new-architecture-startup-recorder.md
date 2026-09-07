---
name: New-architecture startup recorder
description: Compatibility and privacy rules for durable startup checkpoints in Expo SDK 54 Android builds.
---

For Expo SDK 54 builds with the React Native New Architecture enabled, durable synchronous JS-to-native startup checkpoints must use an autolinked Expo local module with synchronous `Function` definitions. Do not use a legacy `NativeModules` module with blocking `@ReactMethod` calls.

**Why:** Legacy blocking bridge methods may be unavailable through New Architecture interoperability and can fail closed, silently removing the JS checkpoints the diagnostic build exists to capture. Expo Modules API synchronous functions run through the supported JSI-aware module layer.

**How to apply:** Keep native writes synchronous with `SharedPreferences.commit()`, contain every recorder failure so startup is never gated, use an explicit metadata-key allowlist with no strings, and strip native metadata from support exports. Verify clean CNG prebuild and Expo autolinking before any diagnostic binary is published.