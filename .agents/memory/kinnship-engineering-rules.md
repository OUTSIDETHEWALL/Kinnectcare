---
name: Kinnship engineering rules
description: Charles's non-negotiable engineering process, git workflow, stated preferences, and product stage for this project.
---

## Product stage (as of July 2026)

Feature development is largely complete for beta. The focus has shifted entirely to:
- Eliminating production bugs
- Improving reliability
- Polishing UI/UX
- Removing rough edges that reduce user confidence

**No new major features until public beta opens.**

## Sprint history

### Sprint 1 — complete (July 10, 2026)
**Fix:** GPS Failure Path 2 — engine stopping permanently when member row temporarily absent at boot.
**Root cause:** `setUser(u)` in `verifyOtp` (AuthContext line 284) fires the engine boot effect before the `/family-group/join` POST at line 333 creates the member row. `fetchAll()` returns empty; engine stops; idempotency guard prevents recovery for the session.
**Repair:** Subscriber-based wait in `frontend/app/_layout.tsx`. When `fetchAll()` finds no row, subscribe to `memberStore.subscribeMember()` and await up to 90 s. `cancelWait` handle in IIFE scope gives the cleanup function deterministic immediate teardown. Merged to main via PR #3.
**OTA eligible:** TypeScript only, no native changes.
**Next:** Install OTA on both test devices, run overnight test, review diagnostics. Then move to next highest-confidence GPS failure path (Path 9 — Leonidas stop-without-restart, or Path 12 — silent start failure / unconditional boot flag).

## Engineering process (mandatory for every fix)

For every issue, in order:

1. Gather evidence first — read production data where appropriate
2. Read the relevant code paths
3. Identify the exact root cause
4. Explain the bug in plain English
5. Explain why confidence is high
6. Explain exactly what code will change and why
7. Create a dedicated Git branch (`fix/<short-description>`)
8. Open a Pull Request with: engineering summary, confidence level, risk assessment, verification plan
9. Nothing merges to main without Charles's approval

Speculative fixes are not acceptable. Low confidence must be stated explicitly.
"I don't know yet" is acceptable. "This should work" is not.

## Git workflow — transition note

**Commit `3d4b18e` ("Update yarn dependencies", July 10 2026) is the final direct commit to `main`.**
It landed during the migration to the protected-branch workflow: a `gitPush` call resolved to the branch's tracking upstream (`origin/main`) instead of creating a new remote branch. The content is correct — the `yarn.lock` update was required to publish the Sprint 1 OTA. The commit is left in place. Do not revert, rebase, or force-push it. Engineering decision by Charles, July 10 2026.

---

## Git workflow

- GitHub `main` is the production record and the authoritative changelog for the entire project
- **Every change — code, documentation, engineering notes, memory updates, dependency changes — arrives through a Pull Request.** No exceptions.
- Direct commits to `main` are never permitted for any reason, by any actor
- Branch naming: `fix/<short-description>`, `docs/<short-description>`, `chore/<short-description>`
- PR description must follow the engineering process format
- **No force-pushes to any branch without Charles's explicit written approval**
- Charles reviews and approves every merge
- The history of `main` should tell the story of Kinnship's evolution — every PR title and description is part of that record

**Why:** Charles stated this explicitly on July 10, 2026. The PR log is the authoritative record of what changed, why, and when. Direct commits destroy that record and make the history untrustworthy.

**How to apply:**
- Before any work: create a branch. Before any push to `main`: stop — open a PR instead.
- Before any `git push --force` or `git push --force-with-lease`: stop and get written approval from Charles in the chat first.
- Memory and documentation updates follow the same rule as code — branch, PR, approval, merge.

## Known polish backlog (not yet assigned to tasks)

These were identified during the July 9, 2026 design review and are awaiting task creation:
- age=0 placeholder showing as "Joyce, 0" on family dashboard and member cards
- Redundant triple status indicators per member card (avatar dot + emoji dot + badge)
- SOS button placement interrupts the member list — needs a fixed anchor position
- Manual "Refresh" pill buttons — replace with pull-to-refresh
- "Diagnostics — Developer tools" exposed in user-facing settings — hide or rename
- "DANGER ZONE" label in Me screen — too developer-facing for a consumer app
- "Role: Member" showing for the account owner on the Me screen
- Detail page title says "Member" instead of the person's name
- Alerts cleared card: "SOS Emergency — Joyce / Joyce" name repeated twice
- "All clear!" green checkmark icon is visually inconsistent with design system
- "Check In" vs "Check in" capitalization inconsistency between list and detail

## Bug severity classification (required on every diagnosis)

Every bug must be classified before a fix is proposed:

- **Critical** — Safety, security, data integrity, or anything that could cause a family to lose trust (e.g. SOS doesn't fire, GPS silently stops, member disappears from dashboard, data loss)
- **High** — Core functionality broken but not safety-related (e.g. check-in doesn't record, notifications not delivered)
- **Medium** — Incorrect behavior that has a workaround
- **Low** — Cosmetic or polish (e.g. age=0 placeholder, capitalization inconsistency)

Priority order: Critical → High → Medium → Low. Polish backlog is addressed after stability is confirmed.

**Why:** Charles stated this explicitly on July 10, 2026. Objective classification prevents emotional prioritization.

## Communication preferences

- Evidence-first always — investigate before proposing changes
- State confidence levels on every diagnosis and repair
- Treat Charles as a business owner and product partner, not a developer
- Move correctly rather than quickly
- No force-pushing, no merging without approval
