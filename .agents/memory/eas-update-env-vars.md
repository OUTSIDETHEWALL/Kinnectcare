---
name: EAS Update env var requirement
description: EXPO_PUBLIC_* vars must come from a .env.production file — shell env vars are silently ignored by @expo/env and Metro's babel transform. Metro's FileStore cache must also be cleared on every publish.
---

## Rule

`EXPO_PUBLIC_*` variables for OTA builds MUST be provided via `frontend/.env.production`. Shell environment variables are explicitly ignored by `@expo/env` (Expo SDK 50+) and never reach Metro's babel transform.

**Why (three-layer failure, all confirmed from source):**

1. **`@expo/env` reads only from `.env` files.** Source at `node_modules/@expo/env/build/index.js` line 197-203: values already in `process.env` (from the shell) are skipped when building the set injected into Metro's transform context. Shell vars set inline, via Replit env manager, or any other method are silently ignored.

2. **Production inlining uses babel-preset-expo, not the Metro serializer.** Source at `node_modules/@expo/metro-config/build/serializer/environmentVariableSerializerPlugin.js` line 62-65: in production mode (`!options.dev`) the serializer explicitly returns early. The actual substitution of `process.env.EXPO_PUBLIC_BACKEND_URL` happens at babel transform time.

3. **Metro's FileStore cache (`.metro-cache/`) preserves stale transforms.** `metro.config.js` uses a custom `FileStore`. If source files haven't changed, Metro serves cached babel-transformed modules even when the env var value changed. Two "fix" OTAs produced identical bundle hashes because Metro never re-ran babel. **Always clear `.metro-cache/` before publishing.**

**How to apply:**

- `frontend/.env.production` is the canonical location. Committed — root `.gitignore` has a `!frontend/.env.production` exception.
- The canonical publish command: `cd frontend && bash scripts/publish-ota.sh "your message"`
- The script (v2, 8 steps) handles everything: file check → @expo/env verification → domain check → health probe → EXPO_TOKEN → cache wipe → publish → summary with bundle hash.

**@expo/env verification step (Step 2 of publish-ota.sh):**
```bash
cd frontend && NODE_ENV=production node -e "
  const { parseProjectEnv } = require('@expo/env');
  const result = parseProjectEnv(process.cwd());
  console.log(result.env['EXPO_PUBLIC_BACKEND_URL'] || 'UNDEFINED');
"
```
`parseProjectEnv` returns only file-sourced values (never shell env). If it prints the correct URL, babel will inline it. If it prints `UNDEFINED` or empty, the bundle will be broken.

**Bundle hash verification:**
After each publish, the new bundle hash must differ from all prior OTAs. Identical hash = Metro served stale cache = env var not picked up. Hash appears in `eas update` output under "android bundles" / "ios bundles".

## Incident

Sprint 2 OTA connectivity outage: all devices called `undefined/api/auth/request-otp` with `ERR_NETWORK`. Confirmed via diagnostic OTA (screenshot from device). Five OTA publishes across the incident before the correct fix was found. Fixed in OTA `5b547265` (bundle hash `entry-f77defb0…` / `entry-5feba3e8…`) — different from all prior broken OTAs, confirming full re-transformation.
