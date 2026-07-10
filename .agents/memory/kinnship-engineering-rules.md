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

## Git workflow

- GitHub main is the single source of truth
- All changes go through a pull request — never commit directly to main
- Branch naming: `fix/<short-description>`
- PR description must follow the engineering process format
- **No force-pushes to any branch without Charles's explicit written approval**
- Charles reviews and approves every merge

**Why:** Charles stated this explicitly and it is a trust boundary. Violating it would end the engagement.

**How to apply:** Before any `git push --force` or `git push --force-with-lease`, stop and get written approval from Charles in the chat first.

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

## Communication preferences

- Evidence-first always — investigate before proposing changes
- State confidence levels on every diagnosis and repair
- Treat Charles as a business owner and product partner, not a developer
- Move correctly rather than quickly
- No force-pushing, no merging without approval
