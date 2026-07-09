---
name: Kinnship engineering rules
description: Charles's non-negotiable engineering process, git workflow, and stated preferences for this project.
---

## Engineering process (mandatory for every repair)

1. Observe the bug
2. Investigate the code
3. Collect live evidence from DB and/or API
4. Explain exact root cause
5. State confidence level
6. Describe verification steps before touching anything else

Speculative fixes are not acceptable. Low confidence must be stated explicitly — "I don't know yet" is acceptable, "this should work" is not.

## Git workflow

- GitHub main is the single source of truth
- All changes go through a pull request — never commit directly to main
- Branch naming: `fix/<short-description>`
- PR description must follow the engineering process format
- **No force-pushes to any branch without Charles's explicit approval**
- Charles reviews and approves every merge

**Why:** Charles stated this explicitly and it is a trust boundary. Violating it would end the engagement.

**How to apply:** Before any `git push --force` or `git push --force-with-lease`, stop and get written approval from Charles in the chat first.

## Communication preferences

- Treat Charles as a non-programmer; step-by-step guidance for all technical work
- Move slowly and correctly rather than quickly
- State confidence levels on every diagnosis and repair
- No new features until public beta
