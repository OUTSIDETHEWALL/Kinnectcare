---
name: EAS Update env var requirement
description: EXPO_PUBLIC_* variables must be present in the shell environment when running eas update — eas.json build profile env section is NOT applied automatically for eas update.
---

## Rule

When running `eas update` from the Replit shell, every `EXPO_PUBLIC_*` variable used in the frontend code must be explicitly present in the shell environment. Setting them only in `eas.json`'s `build.<profile>.env` section is NOT sufficient for `eas update` — that section is applied for `eas build` only.

**Why:** Metro bundler (which `eas update` invokes) inlines `process.env.EXPO_PUBLIC_*` at bundle time by reading the build process's environment. If the variable is absent, Metro inlines `undefined`, making e.g. `baseURL = "undefined/api"`. Every HTTP request then fails with Axios "Network Error" before leaving the device. This caused a full production outage on both test devices.

**How to apply:**
- `EXPO_PUBLIC_BACKEND_URL` is now saved as a Replit shared env var (set 2026-07-11). It is automatically available in all future shell sessions.
- The correct `eas update` command pattern is:
  ```bash
  cd frontend && EXPO_TOKEN=<token> npx eas update --channel production --message "<msg>" --non-interactive
  ```
  The `EXPO_PUBLIC_BACKEND_URL` env var is now always present from the Replit environment — no need to pass it inline anymore.
- Before publishing any OTA, verify the env var is set: `printenv | grep EXPO_PUBLIC`

## Verification note

HBC (Hermes bytecode) does NOT store strings as raw UTF-8 bytes. Binary verification with `grep`, `strings`, or Python `bytes.in()` will ALWAYS return False even when the URL is correctly inlined. This is not evidence the URL is missing — it reflects HBC's internal string table format. The only reliable verification is behavioral (does the app connect?).

## Incident

First Sprint 2 OTA (update group 4f35b82d) was published without `EXPO_PUBLIC_BACKEND_URL` in the shell. Metro inlined `undefined`. Both Charles and Joyce's devices showed "No connection" on every API call. Fixed OTA published as update group a22e9706 with env var correctly set and saved to Replit env vars.
