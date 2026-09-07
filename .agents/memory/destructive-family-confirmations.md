---
name: Destructive family action confirmations
description: Safety and clarity requirements for Leave Family, Remove Member, Delete Family, and similar membership mutations.
---

Destructive family membership actions must be separated from member browsing and placed under the actor’s role or membership context. Use an in-app confirmation that names who is affected, explains the resulting family membership and visibility, and requires an explicit destructive button before any API call.

**Why:** A real-device Leave Family action completed without a visible native confirmation, and its placement near member rows made the authenticated user’s self-leave action feel like removal of the viewed member.

**How to apply:** Keep mutation APIs unreachable from the entry tap. Cancel, Android back, and modal dismissal must never mutate; repeated confirmation taps must be synchronously deduplicated. Apply the same consequence-first pattern to Leave Family, Remove Member, Delete Family, and equivalent actions.