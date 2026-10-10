---
name: Cold-headless validation boundary
description: Evidence required to distinguish healthy warm background execution from successful cold-process bootstrap.
---

Do not treat sustained warm-process background reporting, native heartbeat firings, or web/unit-test success as proof that Android cold headless bootstrap works.

**Why:** Diagnostic exports showed native application-process recreation followed by continuing heartbeat scheduling without fresh-position requests or uploads. Foreground initialization restored reporting, which then remained healthy for hours without another native process recreation.

**How to apply:** Validate a new native process while the activity remains absent: headless registration and invocation, battery acceptance, and fresh GPS acquisition plus server acceptance must all occur without mounting the UI. Distinguish missing JavaScript task registration from failure to create the React context; an entry-order correction cannot fix the latter. Do not substitute Android force-stop for ordinary process death, because force-stop deliberately prevents background execution.

An authenticated member with valid required location permissions and intended
background tracking must not remain permanently disabled after ordinary Android
activity/process recreation or reboot until the user opens the app. Preserve
intentional sign-out, permission and ownership shutdown boundaries.

**Why:** The user explicitly made this product invariant a Google Play release blocker.

**How to apply:** Treat software regression coverage and physical cold-process/
reboot acceptance as separate requirements; do not waive either based on a warm
foreground recovery or successful battery telemetry.