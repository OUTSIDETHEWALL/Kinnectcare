---
name: Invitation removal authority
description: Owner removal must take precedence over outstanding invitation acceptance on current and retained clients.
---

Invalidate outstanding invitations associated with the removed recipient and
family. Removal and invitation acceptance must not race to restore unauthorized
membership. Preserve ownership/dependent safeguards, normal legitimate
acceptance and read-only current-member recovery. Do not repair historical
production invitation records.

**Why:** The user explicitly required these boundaries after a removed member
could reuse an invitation left pending by another legitimate joining path.

**How to apply:** Include retained installed clients, not just the latest
onboarding UI, when evaluating removal authority. Validate both race orderings
and rollback with disposable local data; historical production cleanup requires
separate authorization.
