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

## User preferences

- Treat Charles as a non-programmer. Step-by-step guidance for all technical work.
- Move slowly and correctly rather than quickly with new problems.
- No speculative fixes. No assumptions without live evidence.
- State confidence levels explicitly on every diagnosis and repair.
