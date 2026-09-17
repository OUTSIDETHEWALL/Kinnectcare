---
name: Caregiver battery and device status
description: Durable product rules for battery incidents, device communication states, and Needs Attention.
---

Battery Low at 20% and Battery Critical at 15% are stages of one active incident per member. Critical updates the existing incident; only genuine recovery at 25% ends the discharge cycle. Notification acknowledgment does not resolve the condition.

**Why:** Separate tier rows and acknowledgment-based filtering can make one discharge appear as multiple problems or hide a still-active condition.

**How to apply:** Any battery alert or Needs Attention change must preserve one unresolved incident per member, escalation in place, stale/parallel telemetry guards, and recovery-only removal.

Dashboard device communication states reuse the established movement-aware timing tolerance: moving 2/5 minutes, stationary 60/240 minutes, and unknown movement 10/60 minutes for delayed/not-responding boundaries.

**Why:** These thresholds already reflect the proven upload and heartbeat cadence and avoid false alarms for normally sleeping Android devices.

**How to apply:** Use current device-presence/location timestamps for classification. Do not introduce a new poller or narrow these thresholds independently of the shared tracking model.