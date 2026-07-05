# Build #59 — Scope (Pending Overnight QA of Build #58)

Status: **NOT STARTED** — awaiting completion of Build #58 overnight QA.
Rule: **Blocker-only build.** No new features. If more issues surface overnight, add them here before implementation begins.

---

## 🔴 Beta Blockers (must fix before Closed Beta)

### 1. Location Sharing ownership bug
- **Symptom:** When caregiver (Charles) toggles Location Sharing OFF on his own account, Joyce's `location_sharing_enabled` flips OFF too.
- **Expected:** Each member's `location_sharing_enabled` preference is strictly independent, keyed to that member's own user account.
- **Suspected areas:**
  - `PUT /api/me/preferences` — confirm it writes only to the authenticated user's `members` row (`user_id` match), not to the whole family group.
  - `PATCH /api/auth/me` — same audit.
  - Frontend `memberStore` — verify toggle handler passes the current authenticated user's id, not the currently-viewed member's id.
  - Startup migration for `location_sharing_enabled` — confirm it doesn't rebroadcast one member's value onto siblings.
- **Test after fix:** Backend + Frontend. Two-account test: toggle Charles OFF → Joyce must remain ON, and vice versa.
- **🔎 Smoking-gun clue from live backend log:**
  ```
  INFO:server:[privacy] location_sharing=False propagated to 1 member doc(s) for user=<uuid>
  ```
  The "propagated to N member docs" phrasing suggests the write updates every `members` row where `user_id == <toggler>`. If Charles created Joyce's member row (or vice versa), both docs may share a `user_id`, causing cross-contamination. First step tomorrow: grep for that log line's emitter and audit the Mongo query filter — it should key on the row's OWN identity (member `id` or authenticated user's specific member row), not a broad `user_id` match that can span multiple people.

### 2. Blank notification (recurring)
- **Symptom:** Occasional silent/blank push with no title, body, or icon.
- **Goal:** Identify which push payload is emitting missing `title`/`body`/`icon` fields.
- **Investigation checklist:**
  - Instrument `/app/backend/expo_push.py` to log any outgoing payload missing `title` OR `body` (WARN-level) before send.
  - Cross-reference with `location_ingest_log` + refresh pipeline calls.
  - Confirm the "normal-priority refresh push" short-circuit from Build #58 is actually firing for users with sharing OFF.
  - Suspect callers: refresh pipeline, SOS ack, medication self-alert, membership invite.
- **Test after fix:** Backend. Force-trigger each push type; assert every outbound payload has non-empty title & body.

---

## 🟡 Polish Items (ship with #59)

### 3. Kinnship shield avatar replaces generic "K" avatar
- **Symptom:** Kinnship shield renders briefly then falls back to the generic "K" letter avatar. Likely image cache / asset load race.
- **Fix direction:**
  - Preload the shield asset via `Asset.loadAsync()` at app bootstrap.
  - Ensure fallback logic waits for the shield's `onError` (not `onLoadStart`) before showing the letter avatar.
  - Verify the shield is bundled as a static require, not a remote URL.
- **Where:** Avatar component used in Dashboard cards, Member Detail, notifications icon.

### 4. Bottom nav icons
- **Symptom:** Bottom tab bar still uses generic emoji/placeholder icons.
- **Fix:** Replace each tab's `tabBarIcon` with the proper Kinnship icon set (already in `/app/frontend/assets/…` — confirm exact filenames before wiring).
- **Where:** `/app/frontend/app/(tabs)/_layout.tsx`.

---

## Overnight QA Watchlist (add findings here tomorrow)

- [ ] _(reserved)_
- [ ] _(reserved)_
- [ ] _(reserved)_

---

## Build & Release Checklist for #59

- [ ] All blockers above verified fixed via targeted backend/frontend tests
- [ ] `testing_agent` full-regression pass
- [ ] EAS build: `.aab`, `production` profile only (per BUILD_POLICY.md)
- [ ] Save to GitHub → verify lands on `main` (NOT a `conflict_*` branch)
- [ ] Confirm Railway auto-deploy picked up the new `main` commit
- [ ] Stripe webhook endpoint verified in Dashboard → `POST /api/billing/webhook`
- [ ] Google Play Internal Testing upload
