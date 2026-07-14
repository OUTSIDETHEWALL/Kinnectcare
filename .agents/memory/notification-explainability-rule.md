---
name: Notification explainability rule
description: Charles's permanent rule — every Kinnship notification must be fully explainable; five questions that must always be answerable.
---

# Notification explainability rule

**Rule:** Every notification in the Kinnship system must be explainable. Before shipping or leaving any notification-related code in place, the following five questions must all be answerable immediately:

1. Why was it sent?
2. Who should receive it?
3. Why is it visible (or invisible)?
4. Why did it arrive at that moment?
5. Why did it appear exactly once?

If any of those questions cannot be answered, the notification requires further investigation before the code ships.

**Why:** Charles stated this explicitly as a permanent standing rule during the Ghost Notification Sprint. It is especially important for a family safety application where unexpected notifications erode trust. The rule was established after confirming that ghost notifications existed in production without a traceable cause — the absence of explainability was itself the diagnostic gap.

**How to apply:** Apply this at PR review time for any change touching `expo_push.py`, `family_group.py`, `med_scheduler.py`, `server.py` (push endpoints), or `frontend/src/push.ts`. If a new notification type is introduced, document all five answers in the PR body before requesting a merge.
