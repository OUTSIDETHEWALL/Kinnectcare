# Kinnship — Post-Beta Backlog

> **Purpose:** Every bug, polish item, or "nice-to-have" that surfaces during
> Build #55 device testing (or later) but does NOT meet the Build #56 beta-blocker
> definition lands here. Build #56 is a strict feature freeze — see
> `/app/memory/BUILD_POLICY.md` for the definition of a beta blocker.

_Started: Build #55 device-testing punch list (July 2026). Owner: Charles._

---

## How to file an item

Each entry should include:

```
### [P?] Short title
- **Reported:** YYYY-MM-DD by Charles / user / agent
- **Where:** Screen path or file (e.g. `/(tabs)/me`, `settings gear`, dashboard card)
- **Repro:** 1-2 line reproduction steps
- **Impact:** Why it matters (UX friction, low-frequency bug, cosmetic, perf, etc.)
- **Why deferred:** How this fails the beta-blocker test
- **Fix cost estimate:** small / medium / large
- **Suggested target build:** #57 / #58 / v1.1 / v1.2 / TBD
```

**Priorities used here** (informational only — none of these gate the beta):
- **P2** — Polish, UX friction, low-frequency bugs that don't block core flows
- **P3** — Cosmetic, wording, animation smoothness
- **P4** — Nice-to-haves, feature requests filed while device-testing

---

## Open items

### [P4] Redundant `db.users.update_one` in PUT /me/preferences
- **Reported:** 2026-07-04 by testing_agent (Build #56 review)
- **Where:** `/app/backend/server.py:~1694`
- **Repro:** Reading `update_my_preferences`, a second identical `db.users.update_one({"id": ...}, {"$set": set_doc})` call happens after the location-sharing propagation block runs.
- **Impact:** None visible — Mongo idempotent single-doc `$set`, both writes carry identical `set_doc`. Cheap, harmless, but noisy.
- **Why deferred:** Not a beta blocker; doesn't affect UX, privacy, notifications, or any core workflow. Pure code hygiene.
- **Fix cost estimate:** small (remove one line + confirm test still green)
- **Suggested target build:** #57 or v1.1 clean-up sprint

### [P4] Wrong import path in test_build56_privacy_propagation.py
- **Reported:** 2026-07-05 by testing_agent (Build #57 regression run)
- **Where:** `/app/backend/tests/test_build56_privacy_propagation.py:295`
- **Repro:** File uses `from backend.expo_push import ...` but pytest is configured to load tests with `/app` on the path, so the module resolves to `expo_push` directly. Test suite reports 12/13 pass; the failing case is import-only, no production code exercised.
- **Impact:** None on production. Only cosmetic — makes the regression report noisier than it needs to be.
- **Why deferred:** Not a beta blocker; the code the test *would* cover is separately validated in `expo_push.py` unit paths.
- **Fix cost estimate:** small (change `backend.expo_push` → `expo_push`)
- **Suggested target build:** #58 or first post-beta test-hygiene sweep

---

## Closed / merged items

_(none yet)_
