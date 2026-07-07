# Build #59 — Scope (Closed Beta Readiness Release)

Status: **BACKEND REGRESSION 100% PASS (19/19 tests).** All 13 priority items implemented.
Awaiting user device QA + Save-to-GitHub.

---

## ✅ Implemented in this build

### Backend (unblocks device testing)
- **P3 · Location Sharing per-account isolation** — `PUT /me/preferences` now matches on `user_id` ONLY (previously `$or` with `owner_id`, which was wiping rows the caregiver had created for OTHER people). Verified end-to-end: Charles-toggling-OFF no longer flips Joyce.
- **P3 · One-time heal migration** — `_heal_cross_user_sharing_leaks` at startup restores any rows already incorrectly turned off by the previous buggy sweep.
- **P4 · Stricter blank-push validator** — `expo_push._would_render_blank`: any visible push must have BOTH title AND body ≥3 chars; placeholder titles ("Update", "K", etc.) are rejected.
- **P2 · OTP delivery status tracking** — `_deliver_otp_and_record` writes delivery status back to Mongo; new `GET /auth/otp-status?email=X` polling endpoint so client can show a real error banner if Resend fails instead of silent inbox.
- **P5 · Stripe live-refresh fallback** — if stored `current_period_end` is missing/stale, `build_status_payload` fetches fresh from `stripe.Subscription.retrieve()` → renewal date always correct even if webhook is broken.

### Backend + Frontend (invitation UX rewrite)
- **P1 · New invitation flow (`add-member.tsx`)** — one-screen form: Name / Email / Relationship (with suggestion chips) / Family or Senior. Single "Send Invitation" CTA. Success modal with delivered/backup-code branching.
- **P1 · Invitation email redesign** — Kinnship-green branded HTML template, single unmissable "✓ Accept Invitation" button that opens `kinnship://invite/{token}`, secondary "Install from Google Play" button (configurable via `KINNSHIP_PLAY_STORE_URL` env var), manual code demoted to backup-only footer.
- **P1 · Deep-link route `app/invite/[token].tsx`** — one-tap accept for logged-in users (calls `/family-group/join`), automatic hand-off to signup for logged-out users (pre-fills invite_token + email).
- **P5 · Extended `FamilyInviteCreate` model** — accepts optional `relationship` + `role` fields carried through to acceptance so joiner never re-types.

### Frontend polish
- **P6 · Medication chip hidden when 0/0** — MemberCard skips the medication row entirely when `medication_total === 0`.
- **P7 · Immediate refresh after member delete** — new `memberStore.remove()` evicts locally so dashboard re-renders instantly on next paint (no ~60s wait).
- **P8 · Auto-refresh dashboard after invite acceptance** — invites fetched alongside members on every dashboard load / pull-to-refresh / focus.
- **P10 · Custom Kinnship SVG tab icons** — new `KinnshipTabIcon` (react-native-svg). Shared shield outer frame + per-tab glyph (three-people, single-person, bell). Active = `#1B5E35`, inactive = `#8FA697` (muted grey-green — never plain grey). Identical geometry iOS↔Android.
- **P11 · Pending Invitation badge** — dashboard shows a yellow "🟡 Invitation Pending" card for each unsent invite, with cancel action and expiry date.
- **P12 · Configurable Play Store URL** — `KINNSHIP_PLAY_STORE_URL` env var; defaults to `https://play.google.com/store/apps/details?id=app.kinnship`.

---

## 📋 Regression Test Report
`/app/test_reports/iteration_17.json` — 19/19 pass, 0 blockers, 0 regressions.

---

## 🚦 Before shipping

- [x] Backend regression via testing_agent — 19/19 pass
- [x] Lint clean on all new files (add-member.tsx, invite/[token].tsx, KinnshipTabIcon.tsx, dashboard.tsx, (tabs)/_layout.tsx, member/[id].tsx, memberStore.ts, server.py, family_group.py, billing.py, expo_push.py)
- [ ] User device QA (Charles / Joyce two-account flow, invite email, deep link)
- [ ] Save to GitHub → verify lands on `main` (NOT a `conflict_*` branch)
- [ ] Railway auto-deploy verified
- [ ] `KINNSHIP_PLAY_STORE_URL` env var set on Railway (optional — default is fine)
- [ ] Stripe webhook endpoint verified in Dashboard → `POST /api/billing/webhook`
- [ ] EAS build: `.aab`, `production` profile only (per BUILD_POLICY.md)
- [ ] Google Play Internal Testing upload

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
