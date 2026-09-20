---
name: Android recovery push invariant
description: Reliability and visibility requirements for stale-device recovery pushes on Android.
---

Stale-device recovery pushes must use high FCM priority and remain strictly data-only: no title, body, sound, or top-level Android channel field.

**Why:** Normal-priority data messages may be deferred indefinitely while an Android device is in Doze or App Standby, defeating the recovery path precisely when native reporting has stopped. High priority does not create a ghost notification when the outbound message contains no notification fields.

**How to apply:** Any change to location-refresh or equivalent recovery messaging must verify both properties together: high-priority wake eligibility and an outbound payload with no Android-renderable notification block. Do not trade recovery reliability for notification cosmetics.