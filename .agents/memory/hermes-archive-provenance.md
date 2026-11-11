---
name: Hermes source archive provenance
description: A pinned source revision does not pin GitHub archive owner prefixes
---

A pinned Hermes revision does not guarantee a stable tarball root folder.
GitHub repository ownership changes can alter that prefix without changing the
requested revision.

**Why:** A native build failed after the pinned download began using
`meta-hermes-…`, while the React Native extractor only flattened
`facebook-hermes-…`. The source existed under an extra directory, so CMake
reported a missing source file even though downloading and unpacking succeeded.

**How to apply:** On source-configuration failures, inspect the actual archive
layout before blaming download failure, Gradle task ordering or changing
dependencies. Keep the revision pinned and narrowly adapt root normalization;
do not solve this by upgrading Hermes or bypassing patched React Native builds.
