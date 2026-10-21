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

Treat source transforms and delivered native classes as separate evidence.
React Native's Android implementation may come from a precompiled dependency;
editing its installed Kotlin source does not establish that the app contains
the edit. Use hooks in compiled app/vendor sources or verify the actual artifact.

**Why:** A locally plausible diagnostic hook can otherwise be absent from the
binary while its source tests pass, leading to false conclusions from missing data.

**How to apply:** Compile against the actual dependency classes where possible,
then inspect the separately approved release artifact before claiming device
coverage. Prebuild-time JavaScript dependency hooks also need explicit coverage
review before an OTA-only collection is considered.
