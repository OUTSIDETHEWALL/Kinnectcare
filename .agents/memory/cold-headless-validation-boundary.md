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

An upgrade introducing durable tracking intent must account for legitimately
authorized legacy installations that lack the new record. Absence alone is
neither consent nor revocation; ambiguous state must fail closed, but sufficient
historical and current authorization evidence must allow independent recovery.

**Why:** The user required safe legacy recovery after physical diagnostics proved
that battery wakes survived a disabled tracker and only foregrounding repaired GPS.

**How to apply:** Include a legacy, already-disabled, UI-absent acceptance case.
Do not quietly substitute one foreground startup under the new update for that
case, or treat battery contact as evidence of fresh GPS.