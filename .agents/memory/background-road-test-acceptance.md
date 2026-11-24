---
name: Background road-test acceptance
description: Physical acceptance requires caregiver-side advancing capture evidence before reopening the tracked phone, plus stationary and lifecycle checks.
---

Background GPS movement in server records is not sufficient physical acceptance.
The caregiver must see coordinates change and capture timestamps advance while
the tracked phone remains normally backgrounded, before it is reopened. Include
approximately 7–10 minutes parked, then prove foreground reopening cannot erase
or regress the verified tuple. Test process recreation separately; repeat native
export operations and use startup milestones to measure delays.

A short road test is only Stage A. Stage B requires multiple hours normally
backgrounded, independent device-contact and battery freshness, stationary/moving
transitions, and ordinary lifecycle recovery without reopening the app to keep
it alive. The planned full travel day remains the ultimate acceptance test.

**Why:** The user explicitly requires preserving this acceptance standard even
when production evidence proves that meaningful background movement occurred.
The user explicitly expanded acceptance after an hours-long communication loss;
a brief successful drive cannot close that failure family.

**How to apply:** After separate release and phone-operation authorization.
Do not substitute compilation, HTTP contact, one GPS fix, warm-process success,
or reopening the tracked phone for the caregiver-side background observation.

## Protected moving-tracking baseline

Keep the accepted unattended-moving flow as the baseline during launch cleanup.
Do not broadly change motion configuration, acquisition thresholds or native
ownership lifecycle to repair startup or diagnostic presentation. Such a change
requires a confirmed blocker, a specific justification and regression evidence.

**Why:** The user explicitly requires preserving the successful physical moving
test while addressing the remaining launch friction.

**How to apply:** Treat startup, notification opening and health presentation
as separate problems unless evidence establishes a shared tracking defect.

## Accepted initial stationary and road-test results

On 2026-11-24, the owner reported another successful overnight stationary test
followed by a successful real-world road test, and was satisfied with the initial
results. Preserve the existing GPS tracking and recovery behavior while making
caregiver freshness presentation less alarming.

**Why:** The owner explicitly accepted these initial results and requested a
display-only adjustment, not another tracking or battery-policy change.

**How to apply:** Keep native tracking, motion detection, watchdog probes,
acquisition guards, heartbeat intervals and battery optimization unchanged.
Initial satisfaction does not establish exhaustive physical acceptance or
authorize a public release.

## Launch hold and separate investigations

Google Play production remains on HOLD pending resolution/acceptance of the
startup-delay and unattended-stationary-location reliability issues.
Investigate them separately. Preserve the approximately 60-minute stationary
policy and the successful moving/background baseline; do not tune either to
hide a multi-hour stationary gap.

**Why:** The user explicitly set this release boundary on 2026-10-20 after
reporting a roughly ten-hour stationary gap despite current device/battery
contact, with another same-release phone remaining healthy.

**How to apply:** Investigation authorization is not release authorization.
No merge, deployment, OTA, new binary, Play upload, production configuration/data
change or physical phone operation is included. A foreground-associated
recovery is not proof of its cause or autonomous stationary acceptance.
