---
name: Kinnship engineering rules
description: Non-negotiable evidence, review, git workflow, and severity rules for this project.
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
9. Nothing merges to main without the product owner's approval

Speculative fixes are not acceptable. Low confidence must be stated explicitly.
"I don't know yet" is acceptable. "This should work" is not.

## Git workflow

- GitHub `main` is the production record and the authoritative changelog for the entire project
- **Every change — code, documentation, engineering notes, memory updates, dependency changes — arrives through a Pull Request.** No exceptions.
- Direct commits to `main` are never permitted for any reason, by any actor
- Branch naming: `fix/<short-description>`, `docs/<short-description>`, `chore/<short-description>`
- PR description must follow the engineering process format
- **No force-pushes to any branch without the product owner's explicit written approval**
- The product owner reviews and approves every merge
- The history of `main` should tell the story of Kinnship's evolution — every PR title and description is part of that record

**Why:** The PR log is the authoritative record of what changed, why, and when. Direct commits destroy that record and make the history untrustworthy.

**How to apply:**
- Before any work: create a branch. Before any push to `main`: stop — open a PR instead.
- Before any `git push --force` or `git push --force-with-lease`: stop and get written approval from the product owner first.
- Memory and documentation updates follow the same rule as code — branch, PR, approval, merge.

## Bug severity classification (required on every diagnosis)

Every bug must be classified before a fix is proposed:

- **Critical** — Safety, security, data integrity, or anything that could cause a family to lose trust (e.g. SOS doesn't fire, GPS silently stops, member disappears from dashboard, data loss)
- **High** — Core functionality broken but not safety-related (e.g. check-in doesn't record, notifications not delivered)
- **Medium** — Incorrect behavior that has a workaround
- **Low** — Cosmetic or polish (e.g. age=0 placeholder, capitalization inconsistency)

Priority order: Critical → High → Medium → Low. Polish backlog is addressed after stability is confirmed.

**Why:** Objective classification prevents cosmetic work from displacing safety, security, data-integrity, and core-functionality repairs.

## Communication preferences

- Evidence-first always — investigate before proposing changes
- State confidence levels on every diagnosis and repair
- Communicate for a business owner and product partner, not only for developers
- Move correctly rather than quickly
- No force-pushing, no merging without approval
