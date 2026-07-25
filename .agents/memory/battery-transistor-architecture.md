---
name: Battery sync — Transistor SDK architecture
description: Root cause and fix for battery level not updating in background; covers which upload path is real and how to extend it.
---

## Rule

Battery metadata (and any other per-fix telemetry) must be added to the Transistor SDK `locationTemplate` in `locationEngine.ts`, not to the `expo-task-manager` task in `backgroundLocation.ts`.

## Why

There are two background upload systems in the app:

1. **Transistor SDK native transport** (`locationEngine.ts`) — the real upload path. `autoSync: true` + `url` + `method: 'PUT'` causes the SDK to PUT each fix to the backend natively, without invoking any JS callback. This generates all background heartbeats visible in `location_ingest_log`.

2. **TaskManager JS task** (`backgroundLocation.ts`) — defined via `expo-task-manager` + `expo-location`'s `startLocationUpdatesAsync`. Zero entries in the Background Task Log confirmed this task never fires during normal background operation; the Transistor SDK handles uploads before the JS task gets a chance to run.

Battery sampling was added to System 2 (PR #62). System 1 never called it. MongoDB showed 0/656 background heartbeats containing `battery_level` despite the sampling code existing.

## Fix

The SDK natively measures `battery.level` (0.0–1.0) and `battery.is_charging` (boolean) at fix-record time — available as `locationTemplate` variables. Adding them to the template string is the SDK's intended extension point:

```typescript
locationTemplate:
  '...,"battery_level":<%= battery.level %>,"is_charging":<%= battery.is_charging %>}'
```

No JS battery API call needed. No background runtime restriction possible.

## Backend guard

`battery.level` can theoretically be `-1` (SDK sentinel for "unavailable", documented for `speed`/`heading`/etc.). Server-side guard:

```python
if data.battery_level is not None and data.battery_level >= 0:
    update["battery_level"] = min(1.0, data.battery_level)
```

The `>= 0` check makes `-1` a silent no-op instead of clamping it to `0.0` (false dead-battery reading).

## How to apply

Any future per-fix metadata that should travel with every background upload belongs in `locationTemplate`, not in a JS background callback. The foreground path (`locationRefresh.ts`) is a separate code path and correctly handles its own battery sampling — leave it unchanged.
