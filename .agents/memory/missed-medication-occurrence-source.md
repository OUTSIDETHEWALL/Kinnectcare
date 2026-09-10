---
name: Missed medication occurrence source
description: Durable rule for keeping caregiver missed-medication counts and details accurate across daily resets.
---

Dashboard missed-medication counts, per-member counts, and detail rows must all be projections of the same active missed-alert occurrences. Ordinary due reminders are not misses, and duplicate manual/escalation records for one dose must collapse without collapsing distinct scheduled slots.

**Why:** Reminder status resets daily, while caregiver-visible missed-dose evidence must persist. The alert taxonomy also includes ordinary medication reminders, so filtering every medication alert creates false misses.

**How to apply:** Use explicit missed metadata or recognized missed/escalation alert shapes, retain legacy alerts only with their stored description, and key structured occurrences by reminder, local date, and scheduled time.