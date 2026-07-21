---
name: Replit yarn.lock proxy contamination
description: Replit injects its npm proxy via env vars; yarn.lock gets poisoned URLs that break EAS cloud builds. Permanent fix is in scripts/build-android.sh.
---

## The problem

Replit sets four shell environment variables at the container level (not in any config file — cannot be overridden by a .yarnrc or .npmrc):

```
YARN_REGISTRY            = http://package-firewall.replit.local/npm/
YARN_NPM_REGISTRY_SERVER = http://package-firewall.replit.local/npm/
npm_config_registry      = http://package-firewall.replit.local/npm/
NPM_CONFIG_REGISTRY      = http://package-firewall.replit.local/npm/
```

Every `yarn add` or `yarn install` inside Replit writes `http://package-firewall.replit.local/npm/…` into yarn.lock's `resolved:` fields. EAS cloud build servers cannot reach that host → `yarn install --frozen-lockfile` fails before any native code compiles.

OTA builds are NOT affected (EAS OTA bundling does not re-run yarn install).

## The fix (already implemented)

`scripts/normalize-lockfile.sh` — replaces all proxy URLs with `https://registry.yarnpkg.com/`. Safe because SHA1 and SHA512 fields are content-based.

`scripts/build-android.sh` — pre-build wrapper that normalizes automatically, commits the fix to main if needed (lockfile-only direct commit — the one permitted exception to the PR rule), and submits the EAS build.

**Why:** `yarn add frontend/yarn.lock` — build command to use from now on is `yarn build:android "message"`.

## How to apply

Never run `eas build` directly for native builds. Always use:
```
yarn build:android "Build N — description"
```

If you must run `eas build` directly, run `yarn normalize-lockfile` first and commit the result.
