---
name: Expo iOS notification actions
description: Cross-platform constraints for lock-screen notification actions when the app is terminated.
---

Expo Notifications SDK 54 runs registered notification-action tasks in a background or terminated app on Android only. A lock-screen action that must work while iOS is terminated needs native `UNUserNotificationCenterDelegate` handling; keep ordinary notification responses forwarded to Expo.

**Why:** Expo's task API documents the terminated action-press behavior as Android-only. Assuming the JavaScript task was cross-platform would make an iOS safety action appear to work while silently delaying the response until a later app launch.

**How to apply:** For any iOS native action that authenticates without foregrounding, use a Keychain accessibility class available after first unlock and match Expo SecureStore's actual service/account/generic-key encoding. Re-check these details when upgrading Expo SecureStore.