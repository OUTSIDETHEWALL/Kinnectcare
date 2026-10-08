# Android permission/startup validation — Build 68, runtime 1.3.0

## What JavaScript controls

The onboarding coordinator acknowledges the prominent Kinnship disclosure before
the explicit Android background-location request. The legacy explicit-user-action
background request also awaits that disclosure. Automatic Android dashboard,
push-registration and tracking callers inspect permissions instead of prompting.

The application-owned Transistor `ready()` and startup `setConfig()` paths build
the same explicit Kinnship `backgroundPermissionRationale`. Android startup does
not call the SDK's `requestPermission()`: it uses current OS grants and configures
`WhenInUse` when background access is absent. Recovery goes through that same
configuration path. JS-controlled headless recovery applies the same rationale
before its no-argument start. Token-only configuration changes do not request permission.

## What the OTA cannot prove

Build 68 contains the vendor's compiled default rationale. JavaScript configuration
does not replace that binary resource or control a native boot/headless service
before JavaScript runs. Persisted SDK configuration can also predate the correction.
Do not claim that this OTA makes the vendor default impossible in those paths.

## Required physical-device scenario

After a separately approved release, use an actual Build 68 Android phone and:

1. Record its binary build, runtime and active OTA/update identity before the test.
2. Start from a previously configured installation with native tracking enabled
   and persisted SDK state. Remove **Allow all the time** in Android Settings,
   leaving **While using the app**. Kill the app process without relaunching its
   foreground UI, then reboot or trigger a genuine cold native/headless recovery.
   Use ordinary process death, not Android Force stop, which suppresses background
   execution and therefore is not a cold-recovery acceptance test.
3. Observe the phone before opening Kinnship or allowing foreground JS startup
   to apply `ready()`/`setConfig()`. Record any rationale, system prompt or service
   notification, especially `[CHANGEME]`, `FEATURE X` or `FEATURE Y`. A background
   Activity may be suppressed by Android; no visible dialog alone is not proof.
4. Capture native logs and app Diagnostics after foreground launch. Compare any
   pre-JS event with `pre_ready_state`, `ready_ok`/`setConfig_ok` and the active
   update identity. A warm app-process heartbeat does not prove cold execution.
5. Separately uninstall/reinstall Build 68, testing both Android-restored app data
   and a clean install. Rejoin the family and verify disclosure → foreground →
   background → notifications ordering, denial/Continue Anyway, and Settings return.
6. Verify the resulting shield/service notification, native heartbeat and actual
   background uploads on the phone. Mocked tests cannot establish these results.

These are future acceptance steps, not authorization to release, build, submit,
merge, uninstall or change a live device during this correction.
