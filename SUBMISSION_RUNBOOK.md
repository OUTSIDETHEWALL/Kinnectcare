# 🚀 Kinnship — App Store & Play Store Submission Runbook

This is your end-to-end checklist + copy-paste commands to ship Kinnship v1.0.0 to the App Store and Google Play.

Estimated time: **~3–5 business days end to end** (most of that is Apple review, not your effort). Active hands-on time: **~4–6 hours**.

---

## Phase 0 — Accounts (do these first, in parallel)

| Account | Cost | Sign-up URL | Lead time |
|---|---|---|---|
| **Expo account** | Free | https://expo.dev/signup | 2 min |
| **Apple Developer Program** | $99 / year | https://developer.apple.com/programs/enroll | **~24–48h** (Apple identity verification) |
| **Google Play Developer** | $25 one-time | https://play.google.com/console/signup | ~24h (identity verification) |

> 💡 **Start the Apple + Google enrollments TODAY** — they take the longest. Everything else can happen while you wait.

### Apple Developer enrollment notes
- Enroll as **Individual** unless you have an LLC + D-U-N-S number.
- You'll need a credit card and a notarized ID flow on your iPhone via the Apple Developer app.
- Use the **same Apple ID** that you want to publish under.

### Google Play enrollment notes
- $25 is a one-time fee, *not* annual.
- New accounts opened after Nov 2023 must do **closed testing with 12+ testers for 14 days** before being allowed to publish to production. Plan around this:
  - For Kinnship v1.0 you can publish to **internal testing** immediately (you + family + friends).
  - To go fully **public on Google Play**, you'll need that 14-day closed-test period first. Apple has no equivalent gate.

---

## Phase 1 — Environment ready (✅ already done in this repo)

Everything below is already done — **no action needed**, just verify:

- ✅ `app.json` configured (bundle ID `app.kinnship.client`, version 1.0.0, ios buildNumber 1, android versionCode 1)
- ✅ Privacy & permissions usage strings set (iOS NSLocation/NSCamera/NSContacts, plus `ITSAppUsesNonExemptEncryption: false` to skip export compliance)
- ✅ Android permissions declared (ACCESS_FINE/COARSE_LOCATION, POST_NOTIFICATIONS, READ_CONTACTS)
- ✅ Store icon regenerated at **1024×1024 RGB, no alpha** (`assets/images/kinnship-icon-1024.png`)
- ✅ Adaptive icon foreground at 1024×1024 RGBA
- ✅ `eas.json` with `development`, `preview` (APK for sideload), `production` (AAB for store) profiles
- ✅ `.gitignore` rejects play-service-account*.json, *.p8, *.p12, *.key, *.pem

---

## Phase 2 — Initialize EAS (once you have an Expo account)

Run these from a terminal with the project mounted at `/app/frontend`. **You must be logged into the same machine you ran them from** — these are interactive.

```bash
cd /app/frontend

# 1. Login to EAS (paste your Expo username + password)
eas login

# 2. Verify
eas whoami
# → should print your Expo username

# 3. Initialize the EAS project (this writes a real projectId into app.json)
eas init
# → Choose "Create a new project" → confirm slug "kinnship"
# → app.json's extra.eas.projectId will be auto-replaced
```

After this, `app.json → extra.eas.projectId` will have a real UUID. **Commit this change to git.**

---

## Phase 3 — Preview builds (test on your real device before going to stores)

Preview builds are signed but distributed **outside** the stores — you sideload them on your own devices/family beta testers via a download link.

```bash
cd /app/frontend

# Build BOTH platforms in parallel (takes ~15-30 min on EAS cloud)
eas build --profile preview --platform all
```

While building, EAS will:
- **iOS:** prompt you to register your iPhone's UDID with Apple. Easiest path: `eas device:create` first, scan QR with your iPhone, install Apple's provisioning profile, then run the build. *(Requires the Apple Developer account from Phase 0.)*
- **Android:** auto-generates a debug keystore and produces an `.apk` file you can install directly on any Android phone.

**Outputs:**
- iOS: `.ipa` installable via TestFlight or direct sideload (limited to UDID-registered devices for non-TestFlight preview)
- Android: `.apk` — download to phone, open the file, allow "install from unknown sources"

> 🧪 **DO test the preview build on your physical device before kicking off production builds.** Especially:
> - SOS button + 911 dial
> - Fall detection (shake your phone hard)
> - Stripe checkout via in-app browser
> - Push notifications (you'll need a development build to receive them outside Expo Go)

---

## Phase 4 — Create store listings (do BEFORE production build)

You need the store records to exist before `eas submit` works.

### 4a. App Store Connect (iOS)
1. Sign in at https://appstoreconnect.apple.com with your Apple Developer account.
2. **My Apps → ➕ → New App**
   - Platform: **iOS**
   - Name: **Kinnship**
   - Primary Language: **English (U.S.)**
   - Bundle ID: select **app.kinnship.client** (it'll appear in the dropdown after Phase 2's `eas build` registers it via Apple identifiers — if not, register it manually at https://developer.apple.com/account/resources/identifiers)
   - SKU: `kinnship-ios-001` (any unique string)
   - User Access: **Full Access**
3. Note the **App Store Connect App ID** (10-digit number in the URL after creation). This goes into `eas.json → submit.production.ios.ascAppId`.

### 4b. Google Play Console (Android)
1. Sign in at https://play.google.com/console.
2. **Create app**
   - App name: **Kinnship**
   - Default language: **English (United States)**
   - App or game: **App**
   - Free or paid: **Free** (with in-app purchases via Stripe)
   - Confirm developer policy declarations
3. **Set up your app** dashboard → fill out:
   - **App access** (login required → provide your demo creds: `demo@kinnship.app` / `password123`)
   - **Ads** declaration: No
   - **Content rating** questionnaire (probably 3+, no violence/sexual content)
   - **Target audience**: 13+ (or 18+ if you want to skip the family-policy hassle)
   - **Data safety** form: declare location, contacts, account info collection (see Appendix A)
   - **News app** declaration: No
   - **COVID-19 tracing**: No
   - **Government app**: No
   - **Financial features**: No (Stripe is a payment processor, not banking)

### 4c. Generate Play Store service account (for automated submission)
1. Google Play Console → **Setup → API access**
2. **Link a new Google Cloud project** (or use existing).
3. **Create service account** → click the link, takes you to Google Cloud.
4. In Cloud Console: Service account → grant role **Service Account User** → create.
5. Open the new service account → **Keys → Add key → JSON** → download.
6. Back in Play Console API access page → **Grant access** to the new service account with these permissions:
   - **App access**: all apps
   - **Account permissions**: Admin (release manager is enough but Admin avoids gotchas)
7. Save the JSON file as `/app/frontend/play-service-account.json` (already in .gitignore).

---

## Phase 5 — Production builds

```bash
cd /app/frontend

# Update eas.json with your real values BEFORE running:
#   - submit.production.ios.appleId            ← your Apple ID email
#   - submit.production.ios.ascAppId           ← 10-digit number from Phase 4a
#   - submit.production.ios.appleTeamId        ← 10-char from developer.apple.com/account

# Then build:
eas build --profile production --platform all

# Wait ~20-30 min. Watch progress at https://expo.dev/accounts/<you>/projects/kinnship/builds
```

**iOS credentials prompts** (first build only):
- "Generate a new Apple Distribution Certificate?" → **Yes** (EAS manages this)
- "Generate a new Apple Provisioning Profile?" → **Yes**
- EAS will ask for your Apple ID + app-specific password (NOT your normal Apple password — generate at https://appleid.apple.com → Security → App-Specific Passwords)

**Android credentials prompts** (first build only):
- "Generate a new Android Keystore?" → **Yes** (EAS manages, never lose this — backup with `eas credentials`)

---

## Phase 6 — Submit to stores

```bash
cd /app/frontend

# Submit the latest production build to BOTH stores
eas submit --profile production --platform all
# OR submit individually:
eas submit --profile production --platform ios
eas submit --profile production --platform android
```

**iOS submission:**
- EAS uploads the `.ipa` to App Store Connect.
- The build will appear under **TestFlight → Builds** within ~30 min.
- You can immediately push it to **TestFlight internal testers** (no review needed for internal).
- For **App Store review**: go to App Store Connect → 1.0.0 → attach the build → fill out metadata (Phase 7) → **Submit for Review**.

**Android submission:**
- EAS uploads the `.aab` to Google Play → **Internal testing** track (because `eas.json` says `"track": "internal", "releaseStatus": "draft"`).
- Go to Play Console → **Testing → Internal testing → review release → roll out**.
- For **Production** release: promote from Internal → Closed → Open → Production (or jump straight from Internal → Production if your account is allowed).

---

## Phase 7 — Store listing metadata (the actual review-blocking work)

Both stores require this metadata. Prepare it **in parallel with Phase 5 builds**.

### App Store Connect — App Information tab
| Field | Suggested value |
|---|---|
| Name | Kinnship |
| Subtitle | Family safety & senior care |
| Category (Primary) | Medical |
| Category (Secondary) | Health & Fitness |
| Privacy Policy URL | https://privacy.kinnship.app ✅ |
| Support URL | https://kinnship.app (or a support email landing page) |
| Marketing URL | (optional) |
| Copyright | © 2025 Kinnship |

### App Store Connect — Version 1.0.0 tab
| Field | Suggested value |
|---|---|
| Promotional text (170 char) | Stay connected to elderly loved ones. Real-time SOS, fall detection, medication reminders, GPS check-ins — peace of mind in one tap. |
| Description (4000 char) | See Appendix B below |
| Keywords (100 char) | senior,elderly,care,family,SOS,fall,detection,medication,reminder,GPS,safety |
| Support URL | https://kinnship.app |
| Version | 1.0.0 |
| Sign-in info for review | demo@kinnship.app / password123 |
| Contact info | Your phone + email |
| Notes for reviewer | "SOS button is a demo flow — in production it dials 911 via tel: URL. Stripe subscription uses live keys; reviewers can skip via 'Maybe Later' button on paywall." |

### App Store Connect — App Privacy section
Declare these data types are collected:
- **Contact Info → Email Address** (linked to identity, used for app functionality)
- **Contact Info → Name** (linked to identity)
- **Location → Precise Location** (linked to identity, app functionality + sharing with family)
- **Contacts** (NOT linked, NOT used for tracking — only used to populate emergency contact picker, never uploaded)
- **Health & Fitness → Other Health Data** (medications — linked, app functionality)
- **Identifiers → Device ID** (push token, linked, app functionality)

### Google Play — Main store listing
| Field | Suggested value |
|---|---|
| App name | Kinnship |
| Short description (80 char) | SOS, fall detection & medication reminders for senior family members |
| Full description | See Appendix B (reuse iOS description) |
| App icon | 512×512 PNG — use `kinnship-icon-1024.png` resized to 512 |
| Feature graphic | **1024×500 JPG/PNG, REQUIRED** — you'll need to design this (e.g., Canva) |
| Phone screenshots | At least 2, recommended 8 — see Appendix C |
| Privacy policy | https://privacy.kinnship.app ✅ |
| Category | Medical |
| Tags | senior care, family safety, health |
| Contact email | your support email |
| Website | https://kinnship.app |

### Screenshots (both stores need these)

**iOS** — required sizes:
- 6.7" iPhone (1290×2796 or 1320×2868) — **required**
- 6.5" iPhone (1242×2688 or 1284×2778) — required if you support older devices
- 12.9" iPad Pro (2048×2732) — required because `supportsTablet: true`

**Android** — phone screenshots: 1080×1920 minimum, 7680×7680 maximum, 16:9 or 9:16 aspect ratio.

**Easiest workflow:** Open your preview build on a real device → take 6-8 screenshots → run them through https://appmockup.com or Figma to add device frames + marketing copy.

---

## Phase 8 — Review & launch

| Step | iOS | Android |
|---|---|---|
| Avg review time | **24-72h** (sometimes 7d if Stripe/health flagged) | **2-7d** (longer for new accounts) |
| Common rejection reasons | • Missing demo creds • No reviewer notes about SOS • Permissions not justified | • Data safety form mismatch • Privacy policy not accessible • Sensitive permissions over-declared |
| Response to rejection | Reply via App Store Connect → Resolution Center | Reply via Play Console → policy issue resolution |

**Pre-submission self-check:**
```
✅ Login as demo user works without WiFi (cellular)
✅ SOS confirmation flow is obvious (you must hold 3 seconds — not auto-fire)
✅ Stripe paywall has a "skip" / "Maybe later" path
✅ All in-app strings reference "Kinnship" (no KinnectCare leftovers)
✅ "Sign in info for review" populated on App Store
✅ Reviewer notes explain SOS demo behavior
✅ Privacy policy URL loads on a mobile browser
✅ App icon shows correctly on home screen (no black background)
```

---

## Appendix A — Google Play Data Safety form quick answers

| Data type | Collected? | Shared? | Optional? | Purpose |
|---|---|---|---|---|
| Approximate location | Yes | Yes (within family group) | No | App functionality |
| Precise location | Yes | Yes (within family group) | No | App functionality |
| Name | Yes | No | No | Account mgmt |
| Email address | Yes | No | No | Account mgmt, comms |
| Phone number | Yes | Yes (SOS to emergency contacts) | No | App functionality |
| Contacts | No (we only read picker, never upload) | – | – | – |
| Health info — Other (medications) | Yes | Yes (within family group) | No | App functionality |
| App activity (in-app actions) | Yes | No | No | Analytics |
| Device or other IDs | Yes | No | No | Push notifications |

Encryption in transit: **Yes (HTTPS)**.
Encryption at rest: **Yes (MongoDB Atlas encryption + Stripe PCI)**.
Data deletion: **Yes** — point to in-app `Delete Account` flow.

---

## Appendix B — Sample App Description (4000-char ready)

> **Kinnship — Stay close to the people who matter most.**
>
> Kinnship is the all-in-one family safety app for caring for aging parents, grandparents, and loved ones who live independently. From a single tap SOS to passive fall detection and medication reminders, Kinnship keeps your whole family connected, informed, and ready to help — wherever they are.
>
> **🚨 One-tap SOS**
> A hold-to-confirm emergency button instantly notifies every family member, shares your GPS location, and offers to dial 911. Even when you can't speak, your family will know.
>
> **🤕 Automatic fall detection**
> Wearing your phone? Kinnship's accelerometer-based fall detection notifies your family 30 seconds after an impact, with a cancel-button countdown to prevent false alarms.
>
> **💊 Smart medication reminders**
> Set hourly or custom-time reminders for every medication. If a dose is missed, the alert escalates to family members at +30 minutes and again at +2 hours — so nobody slips through the cracks. Refill reminders fire automatically when supplies run low.
>
> **📍 Live location & daily check-ins**
> Family members can opt-in to share location during check-ins. Kinnship gently prompts each loved one at a custom daily time to confirm they're OK.
>
> **👨‍👩‍👧 Multi-user family groups**
> Invite parents, siblings, and caregivers with a one-tap invite code. Everyone stays in sync — no more "wait, did you call mom?" group chats.
>
> **🔒 Privacy-first**
> Location is only shared during check-ins and SOS. Your data is encrypted in transit and at rest. Read our privacy policy at privacy.kinnship.app.
>
> **Free tier**: up to 2 family members.
> **Family Plan** ($9.99/mo or $99.99/yr): unlimited members, priority push, weekly compliance charts.
>
> Built by families, for families. Welcome to Kinnship.

---

## Appendix C — Screenshot script

Take these 6 screenshots on your preview build:

1. **Dashboard** — showing 2-3 family member cards with green/yellow/red status pills
2. **SOS confirmation screen** — full red bg, big "HOLD TO CONFIRM" button
3. **Member detail** — map with current location pin + medication list
4. **Add medication modal** — showing the time wheel picker
5. **Settings → Plan card** — showing Family Plan with renewal date
6. **Family group invite code screen** — shows the QR/code

Add a 1-line marketing caption at the top of each (Canva templates work well).

---

## What to do RIGHT NOW

1. ☐ Open https://expo.dev/signup → create account → DM me your username so I update `app.json`
2. ☐ Open https://developer.apple.com/programs/enroll → start Apple enrollment ($99, 24-48h)
3. ☐ Open https://play.google.com/console/signup → start Google Play enrollment ($25, ~24h)
4. ☐ Once Expo account exists: run `eas login` + `eas init` in /app/frontend
5. ☐ Once that's done, ping me and I'll run `eas build --profile preview --platform all` with you — we can debug in real-time

I'll be your copilot through every step. Just say the word.
