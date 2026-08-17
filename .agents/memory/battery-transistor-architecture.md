---
name: Battery–Transistor SDK architecture
description: How battery data reaches the backend, all three upload paths, and why the write-guard uses server_now not GPS capture time.
---

## Three battery upload paths

### Path A — JS-alive heartbeat (every 60 s, stationary)
`pushBatteryUpdate('heartbeat')` → reads expo-battery → PATCH /members/{id}/battery.
Requires the main JS runtime to be alive. Dies when Android kills the runtime.

### Path B — JS-alive state/level listeners
`pushBatteryUpdate('charging-state'|'level-change')` → PATCH /battery.
expo-battery `BatteryState.CHARGING` and ~1% level change events. JS-alive only.

### Path C — Headless heartbeat (CRITICAL — runs when JS runtime is dead)
`HeadlessTask` → `lib.getCurrentPosition({persist:true})` succeeds → reads
`pos.battery.level` and `pos.battery.is_charging` from the SDK's native position
result → PATCH /battery using JWT from `lib.getState().authorization.accessToken`.
6-second `Promise.race` timeout. Logs `headless_battery_patch_ok` / `_error` / `_skipped`
to the ring buffer. New PTS key: `headless_battery` / `kc_pts_hl_bat`.

The SDK's native location upload ALSO includes `battery` nested object, extracted by
`LocationUpdate._normalize_payload()` in `server.py`. This is a secondary path for battery
data that arrives via PUT /location — not sufficient on its own (see write-guard note below).

## Battery write-guard — server.py PUT /location

`_batt_incoming_ts = incoming_captured_at or server_now` — **unchanged from original**.

A speculative change to `server_now` was proposed (theory: GPS clock lag causes write-guard
false rejections) but reverted at Charles's request — no concrete log evidence of actual
rejections in production. If Railway logs ever show `battery_updated_at` NOT advancing on
PUT /location payloads that carry valid battery data, that is the evidence needed to revisit
using `server_now` here. Until then, leave the guard logic alone.

## Dashboard staleness threshold

`frontend/app/(tabs)/dashboard.tsx` battery row: `ageMs > 4 * 60 * 60 * 1000` (4 hours).
Was 15 minutes — too aggressive for a caregiving app where stationary periods last hours.
The `_hasBatteryIssue` Needs Attention check retains its own 15-minute window (intentional —
that check fires only on freshly confirmed low battery).

## What NOT to do

Do not add `locationTemplate` to the SDK config. It was removed because any undefined
template variable produces invalid JSON and silently drops the entire upload. PR #65
triggered this and stopped all background uploads. See `location-template-architecture.md`.

## Root cause of the 19-hour battery disappearance bug

1. Android killed the JS runtime → Paths A and B stopped
2. Headless task fired every 60 s but sent no battery PATCH (Path C didn't exist yet)
3. The native SDK location upload's battery data was being silently rejected by the
   write-guard (GPS clock lag vs wall-clock PATCH timestamp)
4. `battery_updated_at` stopped advancing → dashboard hid battery after 15-minute threshold

All three layers were fixed simultaneously in PR #92.
