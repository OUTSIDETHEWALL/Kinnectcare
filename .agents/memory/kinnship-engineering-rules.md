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

## Asynchronous location publication

The user requires authorization generation to be captured before asynchronous
GPS acquisition and revalidated after completion, before any persistence,
upload, or other publication. A post-callback JavaScript check must never be
presented as undoing native persistence/upload performed before that callback.

**Why:** The user explicitly identified this as a privacy blocker, not merely
a missing diagnostic check.

**How to apply:** Review all acquisition paths, including independent Android
WorkManager/headless paths. Prefer discarding an obsolete one-shot result to
retaining it for later replay; prove unchanged-valid acquisition still works.

## Tracker lifetime and truthful health

UNKNOWN authorization is neither permission to start tracking for an unverified
owner nor evidence to stop an already-authorized shared tracker. Operation
cancellation is not owner revocation. SDK enabled state, device contact, one-shot
GPS delivery and sustained tracking are separate claims.

**Why:** The product owner requires these distinctions after physical movement
failed to recover a closed-app tracker while device communication continued.
The original stop initiator remains unresolved; do not turn that uncertainty
into an attribution claim.

**How to apply:** Destructive tracking shutdown requires confirmed revocation
or replacement. Discard stale operations without stopping a valid owner. Never
infer location freshness from battery/contact or sustained recovery from one fix.

Native lifecycle quarantine covers the whole mutation, including post-callback
authorization checks and confirmed-revocation cleanup. All outstanding destructive
shutdown groups must settle before rebinding a shared SDK.

**Why:** Native promise completion alone does not mean late-callback cleanup has
finished; rebinding earlier permits an old stop or purge to affect the new owner.

**How to apply:** Keep mutation and shutdown barriers independent of GPS timeouts;
model tests are not proof of native cross-runtime or process-death behavior.

Async withdrawal evidence belongs to the captured owner/generation. Compare and
revoke atomically in native code, reserving shutdown in the same critical section.
Do not queue a conditional revoked-intent write in AsyncStorage after this mutation.

**Why:** Another runtime can replace authority between a JS check and mutation,
or before a delayed storage write arrives; either can destroy the valid replacement.

**How to apply:** Revalidate after reads, then use expected-authority revocation.
Persist the conditional decision and sticky consent natively; test negative SDK,
generation, owner, health-state and intent-write side effects, not only return values.

Backend coordinate publication must atomically require both current affirmative
consent and the consent lifetime captured by the request. OFF then ON must not
revive a request admitted before withdrawal.

**Why:** Request-start consent can become stale during asynchronous processing.
A boolean-only final guard also permits old requests after explicit re-enable.

**How to apply:** Bind consent and coordinate ordering to one database mutation;
withdrawal clears the visible tuple and changes its consent lifetime atomically.
Test stored coordinates and capture time, not only the HTTP response.

Location-sharing OFF applies to check-in and "I'm OK" member-location
publication too. Those actions must still perform their non-location job.
Do not invent a separate privacy exception, or silently change SOS semantics.

**Why:** The user explicitly requires "LOCATION SHARING OFF MEANS LOCATION
SHARING OFF" regardless of which feature possesses the location.

**How to apply:** Keep receipt/history and delayed check-in confirmation messages
location-free unless a separately authorized design can enforce consent at their
own storage/delivery boundary. A guarded member write does not authorize another
collection insert or a later notification; initial consent alone is insufficient.

## Location-history and diagnostic privacy contract

Ordinary sharing OFF denies other family accounts precise history, pipeline and
nested diagnostic location as well as the live map tuple.
Linked self-diagnostics may retain own diagnostic history while OFF;
Caregiver/creator/group ownership or requesting a refresh is not ownership of
another person's GPS. A requester may retain safe refresh status without precise
location; status authority and location authority are separate.
Retention is separate from disclosure: do not delete history merely to hide it.
Internal precise storage alone is not a privacy release blocker; establish a
realistic disclosure or authority path, rather than treating every GPS copy as public.

**Why:** The user explicitly authorized preserving safely distinguished self
diagnostics while closing family history/metadata disclosure, without redesigning
retention or blocking release for harmless internal diagnostic storage.

**How to apply:** Never grant new family-publication authority to old diagnostic
work or unverified legacy history. Bind family access to the original consent
lifetime and current linked identity; do not refresh timestamps or backfill old
records into a newer consent lifetime.

## Self-member creation consent

New helper-created self-member rows deliberately start sharing OFF. A current
explicit enable is allowed to be necessary even when the user preference mirror
already says ON. Do not automatically "repair" this mismatch from that mirror.

**Why:** The user authorized fail-closed creation rather than stale consent
resurrection. Withdrawal updates existing members before the user mirror; a new
row inserted in that gap cannot safely obtain ON from even another user read.

**How to apply:** Preserve ordinary membership creation, but establish new sharing
authority through the existing explicit preference/generation operation. Any
future automatic initialization needs a separately justified concurrency-safe
mechanism, not caller snapshots or a second preference read.

## Release-blocker review threshold

Stop release review for confirmed Critical/High privacy, safety, security,
authority-loss, core-reliability, or likely native compile/operation defects.
Ordinary technical debt and low-impact theoretical imperfections are non-blocking.

**Why:** The user requires a safe releasable product, not theoretically perfect
software, and separate authorization for each newly confirmed release blocker.

**How to apply:** Explain a credible failure and violated release invariant before
blocking validation. Never repair a newly found independent blocker automatically.
