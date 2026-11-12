---
name: Background recovery boundaries
description: Android service-start eligibility and timer-independent background networking acceptance rules.
---

Background ownership proof, battery publication and explicit GPS publication must
not rely on fetch response completion or deadlines scheduled on paused React
Native timer frames. Use native XHR completion and native request timeouts;
preserve all owner/consent/generation checks at the existing boundaries.

**Why:** Physical diagnostics correlated a received HTTP response and admitted
completion timer with execution only after foreground resume hours later.
Controlled actual-library tests also distinguished fetch's zero-delay completion
timer from direct XHR completion. A JS timeout is not a background deadline.

**How to apply:** Test real transport completion and timeout with JS timers
undelivered. Guard/lifecycle fixtures with mocked transport do not prove this.

Native recovery must start from an Android-permitted event, not an arbitrary
heartbeat/job that cannot legally start a foreground service. Native motion
subscriptions need a current durable owner, existing grants, generation-matched
SDK binding, replay rejection and the same mutation/revocation quarantine as JS.
Service-start acceptance and SDK enabled state are not accepted GPS delivery.

**Why:** Native logs showed foreground-service denial for both location requests
and activity recognition while other device contact continued.

**How to apply:** Keep boot/package replacement and independent activity-transition
recovery separate from JS transport repair. Require a new binary for new native
receivers, then verify both overnight motion recovery and stationary telemetry
without opening the app. Neither simulated success nor foreground recovery is
physical acceptance.
