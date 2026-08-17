---
name: Battery subsystem architecture
description: Two-path independent battery monitoring — Transistor headless + WorkManager periodic task. Key decisions, root cause, and known limitations.
---

# Battery subsystem architecture

## Root cause of the original stale-battery bug

`typeof battCharging === 'boolean'` in the headless battery PATCH block silently rejected valid SDK values on some Android devices where `pos.battery.is_charging` returns `0`/`1` (integer) instead of `true`/`false`. This caused `headless_battery_patch_skipped { reason: 'invalid_battery_values' }` — verifiable in the ring buffer. Fix: coerce with `Boolean(battChargingRaw)` after a null check.

**Why:** Never use strict `typeof x === 'boolean'` for SDK values from Transistor BGeo on Android — always coerce.

## Two-path architecture

Both paths call the same `PATCH /members/{id}/battery` endpoint. Backend write-guard (incoming_ts > stored_ts) ensures newest wins.

**Path A — Transistor headless heartbeat** (`locationEngine.ts`):
- Fires when SDK is active (motion, heartbeat events)
- Gets JWT + member URL from `lib.getState()` (native SQLite — no shared memory needed)
- `pos.battery.level` / `pos.battery.is_charging` from the SDK position result

**Path B — WorkManager periodic task** (`src/batteryTask.ts`):
- `react-native-background-fetch` (already native-linked — WorkManager Android, BGTaskScheduler iOS)
- Fires every ~240 min regardless of movement
- `expo-battery` one-shot APIs: `getBatteryLevelAsync()` + `getBatteryStateAsync()`
- JWT from `BackgroundGeolocation.getState()` SQLite — same pattern as Path A
- 30-entry ring buffer in AsyncStorage key `@kinnship/battery_task_log_v1`
- Headless task registered at module load time (outside React tree)
- Initialized via `configureBatteryTask()` called in `_layout.tsx` after locationEngine.start()

**Why `react-native-background-fetch` instead of `expo-background-task`:** expo-background-task was not in the native build and would require a full rebuild. react-native-background-fetch is already native-linked, uses the same WorkManager/BGTaskScheduler under the hood, and works via OTA.

## Dashboard battery card

Row hides only when `battery_level === null` (never recorded). Never hides due to staleness. Always shows: status text (🟢/🔴/🔌) + percentage + "Updated X hours ago" on second line.

## Battery optimization prompt (Part 7)

One-time Alert on Android post-login. Flag stored at `BATTERY_OPT_PROMPTED_KEY = '@kinnship/battery_opt_prompted_v1'`. Opens `Linking.openSettings()`. Non-blocking, graceful if declined. OEM kill switches (Samsung, Xiaomi, Huawei) still suppress WorkManager without this exemption.

## Known limitation

Doze mode may delay the 4h task by additional hours on aggressively optimized OEMs. WorkManager guarantees eventual execution — never permanently skips. The battery optimization exemption prompt mitigates this.

## Diagnostics

Permanent "Battery System" section in `diagnostics.tsx` (replaced temp "Battery Pipeline (temp diag)"). Shows: live device level, Path A last ok/skipped/error entries from engine log, Path B WorkManager task log with color-coded dots.
