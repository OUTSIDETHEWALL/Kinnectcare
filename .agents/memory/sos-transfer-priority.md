---
name: SOS priority during family transfers
description: Why long transfers must yield without bypassing SOS authorization
---

Long transfers must yield their family fences to SOS, rather than extending
the SOS deadline or persisting against an unfenced membership snapshot.

**Why:** Numeric SOS deadlines can remain unchanged while longer transfer
fence ownership still prevents emergency persistence. Priority is a safety
requirement, not merely a latency optimization.

**How to apply:** Keep priority coordination cross-worker and free of incident
content. Continue taking the family fence and rechecking identity and subject
inside SOS persistence. Exercise genuinely prolonged fence ownership, fresh
membership after interruption, and actual production model defaults. A
cancelled, already-dispatched commit is still an uncertain outcome, not proof
of rollback.
