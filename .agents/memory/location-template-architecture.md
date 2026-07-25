---
name: locationTemplate architecture decision
description: Why locationTemplate exists, what it costs, and the agreed plan to remove it after beta.
---

## Current state

`buildSdkConfig()` in `locationEngine.ts` sets a custom `locationTemplate` that produces a flat JSON body matching the backend's PUT `/members/{id}/location` contract:

```
{"latitude":<%= latitude %>,"longitude":<%= longitude %>,"accuracy":<%= accuracy %>,...,"provider":"transistor"}
```

## The problem with this approach

`locationTemplate` replaces the SDK's entire default HTTP payload. The SDK's native payload includes `battery`, `activity`, `uuid`, `odometer`, and other fields automatically — all of which are silently discarded when a custom template is used. Adding those fields back via template requires ERB-style variable interpolation, which has a failure mode: if any variable is undefined (not null) in the template context, the rendered JSON is invalid and the SDK silently drops the upload.

This is exactly what broke PR #65: `battery.level` and `battery.is_charging` are documented template variables, but under certain conditions in headless/getCurrentPosition context in v5.2.0, the upload transport stopped entirely. The template was the only change; reverting the battery fields restored uploads.

## Agreed long-term plan

After beta stabilization (onboarding, reminders, SOS, core flows validated):

1. **Remove `locationTemplate` from `buildSdkConfig()` entirely.**
2. The SDK will send its native nested payload:
   ```json
   { "location": { "coords": { "latitude": ..., "longitude": ... }, "battery": { "level": ..., "is_charging": ... }, ... } }
   ```
3. **Update the backend** (`server.py` PUT `/members/{id}/location`) to read from the nested SDK schema instead of the flat template schema.
4. Battery sync comes for free — no template variables, no failure surface.

**Why:** The SDK's native schema is richer, versioned by Transistor, and maintained. The custom template is a hand-rolled contract that must be kept in sync with the backend and breaks silently when template variables misbehave.

## What NOT to do in the meantime

- Do not add more fields to `locationTemplate` until the transport stability during beta is confirmed over multiple days.
- Do not use `extras` + `setConfig()` as a battery workaround — timing race condition between config update and queued upload.

## Battery investigation status

`battery.level` and `battery.is_charging` ARE officially supported template variables in v5.2.0. The cause of the upload stoppage is not yet confirmed — native log (`BackgroundGeolocation.logger.getLog()`) was not obtained. Investigate after beta if the template approach is revisited, or skip entirely in favor of the native-payload migration above.
