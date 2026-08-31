---
name: Resume navigation test boundary
description: How to test route behavior after an operating-system background/resume transition.
---

When validating a screen action after the app returns to the foreground, mount the app-level lifecycle coordinator (or the exact coordinator that registers the operating-system lifecycle listeners) alongside the destination route.

**Why:** A detail screen can remain mounted while the app-level resume handlers fetch data or navigate. Dispatching a lifecycle event against an isolated screen that registered no listener exercises nothing and can produce a false regression guard.

**How to apply:** Assert that the coordinator installed lifecycle listeners, drive its background-to-active transition, then verify the intended route remains visible and the user action navigates exactly once.