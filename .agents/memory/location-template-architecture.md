---
name: locationTemplate architecture decision
description: Why locationTemplate existed, what replaced it, and the current production state.
---

## Current state (as of OTA 019f9b71)

`locationTemplate` has been removed from `buildSdkConfig()`. The SDK now sends its
native payload. The backend accepts both shapes simultaneously for backward
compatibility during the OTA rollout window.

## What the native SDK payload looks like

```json
{
  "coords":  { "latitude": 47.6, "longitude": -122.3, "accuracy": 12, "speed": 0, "heading": 0 },
  "battery": { "level": 0.85, "is_charging": false },
  "is_moving": false,
  "timestamp": "2026-07-25T14:00:00.000Z",
  "event": "motionchange",
  "uuid": "..."
}
```

## How the backend normalises both shapes

`LocationUpdate._normalize_payload()` in `server.py` promotes nested values to the
top-level fields the rest of the handler reads:

- **Coordinates:** `coords.latitude` / `coords.longitude` → `latitude` / `longitude`
  (unchanged)
- **Battery:** `battery.level` → `battery_level`, `battery.is_charging` → `is_charging`
  (added alongside locationTemplate removal)

Top-level values always win over nested ones, so a client that sends both (transition
period) is never overwritten by the nested values.

## Why locationTemplate was introduced originally

Two reasons, neither battery-related:
1. **Hardcoded `"provider":"transistor"` literal** — no SDK template variable exists
   for a static string. The only way to inject it was to own the entire JSON shape.
2. **Flat payload shape** — the backend was written expecting flat top-level fields;
   the SDK's native shape nests everything under `coords`, `battery`, etc.

## Why it was removed

`locationTemplate` replaces the SDK's entire HTTP payload. Any template variable that
is undefined (not null) in the SDK's render context produces invalid JSON and causes
the upload to be silently dropped. Adding battery fields to the template exposed this
failure mode and stopped all background uploads. The native payload has no render step
and no failure surface of this kind.

`provider` was the only non-battery field injected by the template and is
**diagnostic-only** — written to `location_ingest_log` and `location_history` but
never used for business logic, notifications, or write guards. Its absence from native
uploads is acceptable; those rows will show `null` for `provider`.

## What NOT to do

Do not re-introduce `locationTemplate` or add custom serialization of any kind. If a
new field is needed from the SDK payload, extend `_normalize_payload()` to promote it
from the nested structure — the same pattern used for coords and battery.
