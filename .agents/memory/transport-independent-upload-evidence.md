---
name: Transport-independent upload evidence
description: Durable rule for keeping Diagnostics upload success consistent across native, foreground, and detached location transports.
---

Every server-accepted location upload must update the same Diagnostics success evidence exactly once, regardless of whether it used native Transistor HTTP, a foreground API request, or a detached background task. Response-body parsing must not gate the success timestamp.

**Why:** Direct foreground location requests updated backend freshness and the Family card while bypassing native HTTP callbacks, leaving Diagnostics falsely stale. Separate JavaScript runtimes also make a single overwriteable timestamp vulnerable to out-of-order completion.

**How to apply:** Route every new successful location transport through the shared recorder. Preserve success evidence with cross-runtime-safe monotonic markers, and make all Diagnostics readers select the newest authoritative value.