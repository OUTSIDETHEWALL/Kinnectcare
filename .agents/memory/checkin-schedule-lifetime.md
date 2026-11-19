---
name: Check-in schedule lifetime
description: Coordinate schedule activation, edits and notification delivery without retroactive or revived warnings.
---

Check-in schedule changes and notification reservations must share a family
transaction fence and a revision/effective-time lifetime across every supported
writer. A deadline before activation cannot be treated as a missed occurrence.

**Why:** Independent review demonstrated that previous-day recovery can invent
yesterday's missed check-in when a schedule is newly enabled, and an alternate
settings route can otherwise revive obsolete queued work after disable/re-enable.

**How to apply:** Whenever adding a settings writer, test fresh future-deadline
activation, disable/re-enable and a barrier-controlled race with delivery.
Preserve legitimate midnight recovery and distinguish safely retryable rejection
from ambiguous external acceptance; unknown sends are not delivery evidence.
