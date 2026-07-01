# Kinnship — Android Build Policy

_Effective: Build #50 (June 2026). Set by the product owner._

## Standard Workflow (AAB-only)

All Android builds MUST be **Android App Bundles (`.aab`)** using the
`production` EAS profile. Distribution flow:

1. `eas build --profile production --platform android` → produces signed `.aab`
2. Upload `.aab` to **Google Play Console → Testing → Internal testing → Create new release**
3. Testers install / update the app via the **Play Store** (they get an email invite link)
4. QA is performed on the Play-distributed build

## Why AAB, not APK

- **Play Console requires AAB** for every track (internal / closed / open / production). APK uploads are rejected.
- AAB lets Play optimise per-device delivery (CPU / density / language splits) → smaller downloads for users.
- Signing is handled by Play App Signing → keystore doesn't drift between builds.
- One artifact serves internal testing → closed beta → production without a rebuild.

## APK Policy

**DO NOT** generate APKs unless the product owner explicitly requests one for
a documented special-case reason (offline device QA, side-loading a specific
tester who can't use the Play Store, etc.).

If an APK is ever required for a one-off, we can either:
- Add a temporary `apk-special-request` profile to `eas.json` for that build only, or
- Convert an existing signed `.aab` locally with `bundletool build-apks --mode=universal`.

## Current `eas.json` profiles

| Profile        | Android output | Purpose                                   |
|----------------|----------------|-------------------------------------------|
| `development`  | dev client APK | On-device debugging with Metro (dev-only) |
| `preview`      | **AAB**        | Internal-distribution QA (Play internal)  |
| `production`   | **AAB**        | Play Internal / Closed Beta / Production  |

`production-apk` was removed on Build #50 to make the policy enforceable at
the tooling level.

## Command Cheatsheet

```bash
# Standard build for Play Internal Testing
export EXPO_TOKEN=<token>
cd /app/frontend
eas build --profile production --platform android --non-interactive --no-wait

# Auto-submit variant (once play-service-account.json is populated):
eas build --profile production --platform android --auto-submit
```
