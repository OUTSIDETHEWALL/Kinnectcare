---
name: Mobile deployment workflow
description: Kinnship's authoritative release path after merged pull requests.
---

Kinnship is a mobile app, not a Replit Web Publish deployment. After approved PRs merge, verify the merged `main` branch, deploy backend changes through the established Railway workflow when backend files changed, and publish frontend JavaScript through the existing Expo EAS production OTA workflow. Android and iOS native builds use EAS Build only when native changes require them.

**Why:** The production system is Railway for FastAPI backend services and Expo EAS Update for React Native/Expo JavaScript. Replit Web Publish targets a website and is the wrong release mechanism for this app.

**How to apply:** Interpret “publish,” “deploy,” “ship,” “release,” and “go live” as the established Kinnship workflow, never Replit Web Publish. Use Replit Web Publish only when the user explicitly says: “Publish the website to Replit.” For an OTA, use the repository's established publish script, verify the production API URL and runtime version, clear Metro cache as required, and report the OTA group ID, platform update IDs, runtime version, and commit SHA.