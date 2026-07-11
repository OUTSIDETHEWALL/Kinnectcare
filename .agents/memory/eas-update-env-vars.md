---
name: EAS Update env var requirement
description: EXPO_PUBLIC_* vars must come from a .env.production file — shell env vars are silently ignored by @expo/env and Metro's babel transform. Metro's FileStore cache must also be cleared when env vars change.
---

## Rule

`EXPO_PUBLIC_*` variables for OTA builds MUST be provided via `frontend/.env.production`. Shell environment variables are explicitly ignored by `@expo/env` (Expo SDK 50+) and never reach Metro's babel transform.

**Why (three-layer failure, all confirmed from source):**

1. **`@expo/env` reads only from `.env` files.** Source at `node_modules/@expo/env/build/index.js` line 197-203: values already in `process.env` (from the shell) are skipped when building the set that gets injected into Metro's transform context. Shell vars set inline (`EXPO_PUBLIC_BACKEND_URL=value npx eas update`) or via Replit env manager are silently ignored.

2. **Production inlining uses babel-preset-expo, not the Metro serializer.** Source at `node_modules/@expo/metro-config/build/serializer/environmentVariableSerializerPlugin.js` line 62-65: in production mode (`!options.dev`) the serializer explicitly returns early with a log message "in favor of babel-preset-expo inlining with source maps." The actual substitution of `process.env.EXPO_PUBLIC_BACKEND_URL` happens at babel transform time.

3. **Metro's FileStore cache (`.metro-cache/`) preserves stale transforms.** The project's `metro.config.js` uses a custom `FileStore` at `.metro-cache/`. If source files haven't changed, Metro serves cached babel-transformed modules even when the env var value changed. Two "fix" OTAs produced identical bundle hashes because Metro never re-ran babel. Clearing `.metro-cache/` forces a full re-transform.

**How to apply:**

- `frontend/.env.production` is the canonical location. It is committed (not gitignored — the root `.gitignore` has a `!frontend/.env.production` exception).
- Before any OTA publish, clear the Metro cache: `rm -rf frontend/.metro-cache`
- The `publish-ota.sh` script validates the file (not shell env) and should be used for all future OTA publishes: `cd frontend && bash scripts/publish-ota.sh "your message"`
- The script currently does NOT auto-clear the cache. If env vars change, clear manually first.

## Incident

Sprint 2 OTA connectivity outage: all devices called `undefined/api/auth/request-otp` with `ERR_NETWORK`. Confirmed via diagnostic OTA that showed raw URL in the error dialog. Root cause was missing `.env.production` combined with stale Metro cache. Fixed in OTA `5b547265` (bundle hash `entry-f77defb0…`) which had a different hash from all prior broken OTAs, confirming full re-transformation.

## Verification method

After a cache-clear publish, confirm the new bundle has a DIFFERENT hash from the previous one. Identical hashes = Metro served cache = env var not picked up. The bundle hash appears in the `eas update` output under "android bundles" and "ios bundles".
