---
name: Notification explainability rule
description: Every Kinnship notification must be fully explainable through five required questions.
---

# Notification explainability rule

**Rule:** Every notification in the Kinnship system must be explainable. Before shipping or leaving any notification-related code in place, the following five questions must all be answerable immediately:

1. Why was it sent?
2. Who should receive it?
3. Why is it visible (or invisible)?
4. Why did it arrive at that moment?
5. Why did it appear exactly once?

If any of those questions cannot be answered, the notification requires further investigation before the code ships.

**Why:** Unexpected notifications erode trust in a family safety application. Production notifications once lacked a traceable cause, making the absence of explainability itself the diagnostic gap.

**How to apply:** Apply this at PR review time for any change touching `expo_push.py`, `family_group.py`, `med_scheduler.py`, `server.py` (push endpoints), or `frontend/src/push.ts`. If a new notification type is introduced, document all five answers in the PR body before requesting a merge.
