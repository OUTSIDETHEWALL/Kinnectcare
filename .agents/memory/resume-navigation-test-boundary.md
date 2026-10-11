---
name: Resume navigation test boundary
description: Test startup and resume at the application boundary, not only the destination screen or location engine.
---

When validating a screen action after the app returns to the foreground, mount the app-level lifecycle coordinator (or the exact coordinator that registers the operating-system lifecycle listeners) alongside the destination route.

**Why:** A detail screen can remain mounted while the app-level resume handlers fetch data or navigate. Dispatching a lifecycle event against an isolated screen that registered no listener exercises nothing and can produce a false regression guard.

**How to apply:** Assert that the coordinator installed lifecycle listeners, drive its background-to-active transition, then verify the intended route remains visible and the user action navigates exactly once.

Location startup and repair tests must also include the real navigation-root
permission gates, not merely call the engine directly.

**Why:** Independent review found that notification inspection could strand
tracking before the repaired engine was ever reached, despite passing engine tests.

**How to apply:** Mount the real application root with real authorization code.
Exercise denied, rejected, and lost optional queries, plus session, ownership,
location-permission and durable-revocation boundaries before asserting native startup.

Also exercise a newly mounted navigation root inside an already-live Android JS process. A new screen tree does not imply fresh module state.

**Why:** Real Android beta evidence showed a medication tap dispatched with a previous root's readiness while the new root was still restoring authentication. The acknowledgment route was selected early, then normal startup navigation replaced it with Family.

**How to apply:** Preserve process-level state during remount tests, delay session restoration and navigator commitment independently, and assert the exact pending occurrence survives until the current root is ready. A requested route replacement is not proof that the navigator has committed it.