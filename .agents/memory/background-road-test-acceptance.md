---
name: Background road-test acceptance
description: Physical acceptance requires caregiver-side advancing capture evidence before reopening the tracked phone, plus stationary and lifecycle checks.
---

Background GPS movement in server records is not sufficient physical acceptance.
The caregiver must see coordinates change and capture timestamps advance while
the tracked phone remains normally backgrounded, before it is reopened. Include
approximately seven minutes parked, then prove foreground reopening cannot erase
or regress the verified tuple. Test process recreation separately; repeat native
export operations and use startup milestones to measure delays.

**Why:** The user explicitly requires preserving this acceptance standard even
when production evidence proves that meaningful background movement occurred.

**How to apply:** After separate release and phone-operation authorization.
Do not substitute compilation, HTTP contact, one GPS fix, warm-process success,
or reopening the tracked phone for the caregiver-side background observation.
