---
name: EAS Node 20 dependency constraint
description: Expo SDK 54 Android EAS builders currently install dependencies with Node 20.
---

Direct JavaScript dependencies must remain compatible with Node 20 for Expo SDK 54 Android EAS builds. In particular, do not allow `@babel/preset-env` 8.x into the frontend lockfile; it requires Node 22+ and fails during EAS dependency installation.

**Why:** A native Android build failed before Gradle because Yarn resolved `@babel/preset-env` 8.0.2, whose engine constraint excludes the Node 20 EAS image.

**How to apply:** Pin a Node-20-compatible Babel 7 release and run the repository lockfile normalization script before starting EAS.