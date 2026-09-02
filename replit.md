# Kinnship

Family safety and senior wellness app. Backend on Railway (FastAPI/Python), database on MongoDB Atlas, frontend is React Native/Expo (Android, Google Play Internal Testing). Stripe subscriptions, Expo push notifications, Transistor background geolocation, Twilio SMS, Resend email.

## Project status

Feature-complete for v1.0. No new features until public beta. Current goal: stabilize for public beta by resolving known bugs in priority order.

## Engineering process

Every repair must follow this sequence — no exceptions:

1. Observe the bug
2. Investigate the code
3. Collect live evidence from the database and/or API
4. Explain the exact root cause
5. State confidence level
6. Describe exactly how the fix will be verified before anything else changes

Speculative fixes are not acceptable. "This should work" is not acceptable. If confidence is low, say so.

## Git workflow

- GitHub main is the single source of truth
- All changes go through a pull request — never commit directly to main
- Branch naming: `fix/<short-description>` for bug fixes
- PR description must follow the engineering process format above: bug, fix, why, confidence level, verification steps
- **No force-pushes to any branch without Charles's explicit approval**
- Charles reviews and approves every merge
- **Git push:** always use `GITHUB_PAT` secret with the `x-access-token` URL scheme. Never rely on the Replit built-in git credential helper — it times out consistently in this environment. Reset the remote URL to the plain HTTPS form immediately after each push so the token is never left in the config.

## Release commands

Always run from the `frontend/` directory.

### Release target rules

- Production is the only default target for Kinnship. Every Android build and every OTA publish must target package `app.kinnship.client` with the EAS profile/channel `production`, unless Charles explicitly instructs otherwise in that conversation.
- Do not use `preview`, staging, testing, alternate channels, alternate EAS profiles, or experimental release paths by default. If there is any uncertainty about the target, stop and ask before publishing anywhere.
- The established Android release workflow is: build the production Android App Bundle, verify it completed successfully, provide the `.aab`, and let Charles manually upload it to Google Play Internal testing.
- Do not introduce automatic Google Play submission, EAS Submit, Google Play service-account automation, CI/CD release pipelines, automatic Play uploads, or any new publishing process unless Charles explicitly requests it.
- Before building or publishing anything, verify the package, runtime, version code, EAS profile/channel, artifact type, and Google Play track/status. Before announcing completion, verify the finished EAS build/update record reports the intended runtime, channel, distribution, and target.

### Stability-first development rules

- Do not introduce new release infrastructure, credentials, services, or automation while fixing application bugs.
- If a code fix requires a workflow change, explain why first and wait for Charles's approval. Solving an application bug must not result in a new deployment process.
- Kinnship is approaching beta, so stability is more important than engineering elegance. When multiple technically valid solutions exist, prefer the one that minimizes complexity, preserves existing workflows, and gets the application reliably into testers' hands.
- Before announcing completion, verify the finished EAS build/update record reports the intended runtime, channel, distribution, and target.

| Task | Command |
|---|---|
| Publish OTA update | `yarn ota:publish "Your message"` |
| Submit Android native build | `yarn build:android "Build N message"` |
| Normalize yarn.lock only | `yarn normalize-lockfile` |

### Why yarn.lock needs normalization before every native build

Replit sets four shell environment variables at the container level that redirect all npm/yarn traffic through a local proxy:

```
YARN_REGISTRY            = http://package-firewall.replit.local/npm/
YARN_NPM_REGISTRY_SERVER = http://package-firewall.replit.local/npm/
npm_config_registry      = http://package-firewall.replit.local/npm/
NPM_CONFIG_REGISTRY      = http://package-firewall.replit.local/npm/
```

Every `yarn add` or `yarn install` inside Replit writes `http://package-firewall.replit.local/npm/…` into yarn.lock's `resolved:` fields. EAS cloud build servers have no route to that host, so `yarn install --frozen-lockfile` fails before any native code compiles.

`scripts/build-android.sh` handles this automatically: it detects any proxy URLs in yarn.lock, replaces them with `https://registry.yarnpkg.com/`, commits the result directly to main (yarn.lock only — the one permitted direct-to-main commit because it is purely mechanical), and then submits the EAS build. The SHA1 fragment and SHA512 integrity fields in yarn.lock are content-based and remain valid after the URL replacement.

OTA updates (`yarn ota:publish`) are not affected — EAS OTA bundling runs on EAS's servers and does not re-run `yarn install`.

## User preferences

- Treat Charles as a non-programmer. Step-by-step guidance for all technical work.
- Move slowly and correctly rather than quickly with new problems.
- No speculative fixes. No assumptions without live evidence.
- State confidence levels explicitly on every diagnosis and repair.
- After every OTA publish, always show the update group ID prominently so Charles can verify it on his phone.
