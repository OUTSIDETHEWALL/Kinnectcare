---
name: Expo Router navigation context identity
description: Keep route hooks in the router-owned context when navigation dependencies have multiple installed copies.
---

Consume navigation through Expo Router's public APIs in its screens and their
hooks, rather than the application's direct React Navigation dependency.

**Why:** Separate installed navigation copies create separate React context
objects, even when their APIs are compatible. A focus hook can throw before a
screen's loading state or controls render. Mocked navigation hides this failure.
The owner confirmed that a scoped router-owned context correction restored the
tested two-phone Android SOS workflow; unrelated dependency upgrades were not
needed for that recovery.

**How to apply:** Preserve focus/blur subscriptions and cancellation when changing
the import boundary. Verify context identity using the installed libraries as
well as ordinary lifecycle fixtures. Prefer a scoped public-API correction over
unrelated dependency upgrades during an emergency repair; JavaScript verification
does not replace physical Android acceptance.
