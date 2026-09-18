---
name: Caregiver battery and device status
description: Durable product rules for battery incidents, device communication states, and Needs Attention.
---

Battery Low at 20% and Battery Critical at 15% are stages of one active incident per member. Critical updates the existing incident; only genuine recovery at 25% ends the discharge cycle. Notification acknowledgment does not resolve the condition.

**Why:** Separate tier rows and acknowledgment-based filtering can make one discharge appear as multiple problems or hide a still-active condition.

**How to apply:** Any battery alert or Needs Attention change must preserve one unresolved incident per member, escalation in place, stale/parallel telemetry guards, and recovery-only removal.

Dashboard device communication states use movement-aware timing tolerance: moving 10/25 minutes, stationary 60/240 minutes, and unknown movement 10/60 minutes for delayed/not-responding boundaries. For moving devices, exactly 10 minutes remains healthy and exactly 25 minutes is not responding.

**Why:** Five nights of beta use showed ordinary cellular, network, and Android scheduling gaps can reach 5–10 minutes during healthy moving-device operation. The 10/25 balance avoids false concern without waiting an hour to identify a moving-device outage.

**How to apply:** Use current device-presence/location timestamps for classification. Do not introduce a new poller or narrow these thresholds independently of the shared tracking model.