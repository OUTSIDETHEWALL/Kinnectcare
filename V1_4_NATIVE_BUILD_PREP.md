# Kinnship v1.4.0 — Native Build Preparation Notes

**Status:** Staged. **Do NOT trigger an EAS native build until Wednesday's v1.3.3 telemetry comes back.**

These are the native-only capabilities the v1.3.3 telemetry will help us
validate are actually needed.  When the go signal lands, this document is
the working list — every item maps to an `app.json` / `expo-build-properties`
change, an additional permission, or a native config plugin.

---

## 1. Background fall detection (foreground sensor service)

**Why native:** `expo-sensors` accelerometer/gyroscope listeners stop firing
when the app is backgrounded. We strongly suspect this is why Sunday's couch
throws produced zero detections — the screen had gone dark.

**What changes:**

- `app.json` → add `expo.android.permissions`:
  - `FOREGROUND_SERVICE`
  - `FOREGROUND_SERVICE_HEALTH`  (Android 14+ — required for sensor workload type)
  - `BODY_SENSORS`               (some OEMs gate accelerometer access at this level when screen is off)
  - `POST_NOTIFICATIONS`         (already present, confirm)
- `expo-build-properties` plugin config:
  ```json
  ["expo-build-properties", {
    "android": {
      "extraProguardRules": "-keep class expo.modules.sensors.** { *; }",
      "manifestPlaceholders": {
        "appAuthRedirectScheme": "kinnship"
      }
    }
  }]
  ```
- New module `src/backgroundFallTask.ts` — `TaskManager.defineTask` for a
  persistent sensor task.  Android sticky foreground notification ("Kinnship
  is watching for falls") routed through `silent_v2`-style low-importance
  channel (created in code, NOT shown to user as an alert).
- `expo-task-manager` already installed; need to verify task IDs don't
  collide with `backgroundLocation.ts`.

**Risks:**

- Battery — a continuous 20 Hz accelerometer listener costs ~3–5% battery
  per 24h on modern phones.  Acceptable for a safety app but should be
  documented in onboarding.
- Samsung One UI / Xiaomi MIUI aggressively kill foreground services that
  don't have a sticky notification.  Sticky-notification is unavoidable
  but we can make it tappable to "Pause for 30 min".

## 2. Lockscreen full-screen intent (SOS countdown)

**Why native:** Apple-Watch-style "Are you OK?" countdown needs to BREAK
THROUGH the lockscreen on Android 14+.  Without `USE_FULL_SCREEN_INTENT`
permission declared at install-time + at-runtime user approval, the
countdown only paints if the user happens to already have the phone
unlocked.

**What changes:**

- `app.json` → add:
  - `USE_FULL_SCREEN_INTENT` (Android 14+ requires user approval at first use)
- `AndroidManifest.xml` (via config plugin):
  - The fall-countdown Activity must declare `android:showWhenLocked="true"`
    `android:turnScreenOn="true"` `android:launchMode="singleTask"`.
- Frontend: add a "Grant lockscreen access" CTA inside the Fall Detection
  settings card that calls `Linking.openSettings()` to the per-app
  fullscreen-intent permission page on Android 14+.

## 3. iOS Core Motion background mode

**Why native:** Same problem as Android backgrounding — Core Motion
accelerometer listeners stop the moment the app is backgrounded unless
we register a `UIBackgroundModes` entry.

**What changes:**

- `app.json` → `expo.ios.infoPlist`:
  - `UIBackgroundModes: ["location", "fetch", "processing"]`
  - `NSMotionUsageDescription`: "Detect falls while phone is in pocket or
    on a table — alerts your family if you can't respond."
- iOS Critical Alerts entitlement requires separate Apple approval —
  filed as a TODO under v1.4.2.

## 4. Persistent location-service notification (Android 14+ compliance)

**Why native:** Android 14 requires any foreground-service that uses
location to ALSO show a persistent notification.  Current `backgroundLocation.ts`
relies on `expo-location`'s default behavior which Google Play Console
has started flagging in pre-launch reports.

**What changes:**

- `expo-location` plugin config in `app.json`:
  ```json
  ["expo-location", {
    "locationAlwaysAndWhenInUsePermission": "Allow Kinnship to share your live location with your family — even when the app is closed — for safety check-ins.",
    "locationAlwaysPermission": "Allow Kinnship to share your live location with your family — even when the app is closed — for safety check-ins.",
    "locationWhenInUsePermission": "Allow Kinnship to share your live location with your family.",
    "isAndroidBackgroundLocationEnabled": true,
    "isAndroidForegroundServiceEnabled": true
  }]
  ```
  We already have most of this — verify against current app.json before the build.

## 5. Quiet Hours (mostly OTA-able, native polish optional)

User-configurable do-not-disturb windows.  90% of the logic is OTA-shippable:

- `UserPreferences.quiet_hours = { start: "22:00", end: "07:00" }` (backend).
- Backend `send_expo_push()` checks recipient's quiet hours BEFORE sending
  any non-SOS push.  SOS and Fall-Detected always bypass.
- Frontend Settings panel with start/end time pickers.
- Local notification scheduler honors the same window for medication
  reminders.

The **native** piece is integration with Android's system DND — if the
user has the OS-level DND on, we want to inherit the schedule.  We can
read this via `NotificationManager.getCurrentInterruptionFilter()` but
the call requires `ACCESS_NOTIFICATION_POLICY` permission added at native
build time.  Acceptable to ship Quiet Hours OTA-only (app-level only) in
v1.4.0 and add OS-DND inheritance in v1.4.1.

---

## Build-trigger checklist (DO NOT EXECUTE YET)

1. ✅ Confirm with user: v1.3.3 telemetry shows the foreground detector
   IS receiving samples (proves the algorithm is wired up).  If it's not,
   we have a different bug to chase first.
2. ✅ Confirm with user: AppState log shows the app was backgrounded
   during the failed couch throws (proves background access is the actual
   fix).
3. Apply the app.json + plugin changes above in a single commit.
4. Bump `version` 1.1.9 → 1.2.0 (semantic: minor for new permissions /
   background capability).
5. Bump `runtimeVersion.versionCode` 38 → 39.
6. `eas build --platform android --profile production`.
7. Submit to Play Console internal track for OTA install on Charles/Joyce phones.
8. Field-test the build with the SAME couch-toss / pillow-drop matrix
   that produced 0 detections on Sunday.  Compare to v1.3.3 telemetry.

## Out of scope for v1.4.0

- iOS production build (queued for v1.4.2 after Apple Critical Alerts
  entitlement is approved).
- Background-running `expo-task-manager` ML inference (not needed for
  fall detection; threshold-based state machine is sufficient).
