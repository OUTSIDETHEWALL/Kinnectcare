# Kinnship — Build & Release Policy (Canonical)

> **This file is the constitution of the Kinnship build pipeline. Any agent
> working on this project MUST read and obey these rules before invoking
> `eas build` or any command that consumes a paid build credit.**

_Effective: Build #50 (June 2026). Set by Charles (product owner)._

---

## ⛔ Rule 1 — Pre-Build Approval Checkpoint (MANDATORY)

**Before consuming any paid build credit, summarize the build configuration
and wait for Charles's explicit "Proceed" approval.**

The summary MUST include:

- Build label (e.g. "Build #51")
- **Profile** (`production` / `development`)
- **Artifact type** (must state "AAB" for Android — never assume)
- **Distribution target** (Google Play Internal Testing / Dev-client)
- **`versionCode`** for Android (or iOS `buildNumber`)
- Backend URL / environment being baked into the JS bundle

**Template:**

> About to start Build #N:
> - Profile: `production`
> - Artifact: **AAB**
> - Distribution: Google Play Internal Testing
> - Version Code: N
> - Backend: `https://kinnectcare-production.up.railway.app`
>
> Proceed?

Charles must reply "Proceed" (or equivalent) BEFORE `eas build` is invoked.

**No exceptions.** Never chain "build immediately" onto a code-completion
message. Build credits are limited and one wrong build is one wasted credit.

---

## 📦 Rule 2 — Android AAB Only

- **ALL Android builds are Android App Bundles (`.aab`).**
- Build with the `production` EAS profile.
- Deploy exclusively through **Google Play Internal Testing** for all QA
  and beta testing.
- **Do not generate APKs** unless Charles explicitly requests one for a
  documented special purpose (offline QA, non-Play side-load, etc.).
- Before starting any EAS build, verify `eas.json` → target profile →
  `android.buildType` is `"app-bundle"`.

**Reason:** Every tester installs from the Play Store, so QA must be on the
exact Play-distributed artifact. APKs waste build credits, drift from the
Play-signed artifact, and can't be uploaded to the Console anyway.

---

## 🧭 Standard Workflow

1. Land the code change (feature / bug fix) and get user approval.
2. Bump `versionCode` in `app.config.js` with a release-note stamp.
3. **Emit the Rule 1 checkpoint summary and WAIT.**
4. On user "Proceed", run:
   ```bash
   cd /app/frontend
   export EXPO_TOKEN=<token from Charles>
   eas build --profile production --platform android --non-interactive --no-wait
   ```
5. Report the build URL to Charles.
6. Charles downloads the `.aab` → uploads to Play Console → Internal Testing → tests via Play Store.

---

## Current `eas.json` state (Build #50)

| Profile        | Android output | Purpose                                   |
|----------------|----------------|-------------------------------------------|
| `development`  | dev-client APK | On-device debugging with Metro (dev-only) |
| `preview`      | **AAB**        | Internal QA (Play internal track)         |
| `production`   | **AAB**        | Play Internal / Closed Beta / Production  |

`production-apk` was removed on Build #50 to make Rule 2 enforceable at
the tooling level.

---

## APK Special-Case Procedure

If Charles ever explicitly asks for an APK:

1. Emit the Rule 1 checkpoint summary — but with `Artifact: APK` clearly labelled AND the reason quoted from Charles's request.
2. On approval, either:
   - Add a temporary `apk-special-request` profile to `eas.json` for that build only, then remove it after, or
   - Convert an existing signed `.aab` locally: `bundletool build-apks --bundle app.aab --output app.apks --mode=universal`.
3. Never let an APK profile linger in `eas.json`.

---

## Command Cheatsheet (post-approval only)

```bash
# Standard AAB build for Play Internal Testing
export EXPO_TOKEN=<token>
cd /app/frontend
eas build --profile production --platform android --non-interactive --no-wait

# Auto-submit variant (once play-service-account.json is populated):
eas build --profile production --platform android --auto-submit
```
