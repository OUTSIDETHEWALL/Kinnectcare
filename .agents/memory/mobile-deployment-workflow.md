---
name: Mobile deployment workflow
description: Kinnship's authoritative release path after merged pull requests.
---

Kinnship is a mobile app, not a Replit Web Publish deployment. After every approved PR merges, first classify the merged change as backend, mobile JavaScript/React Native, both, or non-deployable (tests, documentation, diagnostics planning, or project memory). Deploy only the affected surface: backend changes go to Railway; mobile JavaScript/React Native changes go through the existing Expo EAS production OTA workflow; when both changed, deploy Railway first, verify health, then publish the OTA. Non-deployable changes receive no deployment. Android and iOS native builds use EAS Build only when native changes require them.

**Why:** The production system is Railway for FastAPI backend services and Expo EAS Update for React Native/Expo JavaScript. Replit Web Publish targets a website and is the wrong release mechanism for this app.

**How to apply:** After a merge, inspect the merged diff before taking any release action. Interpret “publish,” “deploy,” “ship,” “release,” and “go live” as the established Kinnship workflow, never Replit Web Publish. Use Replit Web Publish only when the user explicitly says: “Publish the website to Replit.” For a backend-only release, deploy Railway and verify health. For a mobile-only release, publish the OTA. For both, complete and verify Railway before publishing the OTA. For tests, documentation, diagnostics planning, or project memory only, do nothing operationally. For an OTA, use the repository's established publish script, verify the production API URL and runtime version, clear Metro cache as required, and report the OTA group ID, platform update IDs, runtime version, and commit SHA.