---
name: Native observer safety
description: Prevent tracing from creating startup, lock-contention or battery symptoms that resemble the bug being investigated.
---

Instrumentation must keep restore, JSON/ring processing, logging handlers and
disk writes off request/authority/consent paths. A bounded ring is not sufficient
if every event rewrites the full store. Preserve all existing transport listener
callbacks and never silently overwrite another global custom-client hook.

**Why:** An observer can produce the startup stalls, authority-lock contention
or battery cost it is meant to diagnose, even when application policy remains
unchanged.

**How to apply:** Inspect compiled registration/call paths, exercise actual
compiled observers against a blocked consumer and IO failure, and report queue,
retention and durability uncertainty. A debounce is not a hard persistence
deadline; a JVM test double is not Android or release-shrinker acceptance.
