---
name: Expo Router lazy isolation
description: How to keep a diagnostic implementation out of initial route initialization.
---

For a genuinely isolated bootloader, keep every dynamically loaded diagnostic implementation outside Expo Router's `app/` directory. The route file should expose only the dependency-minimal bootloader; button handlers can then use `import()` for targets under `src/`.

**Why:** Expo Router discovers files under `app/` as routes. Leaving the old implementation there made it appear in the generated route list and defeated the experiment's claim that Full Diagnostics was unavailable until its button was pressed.

**How to apply:** When isolating a startup crash, verify the generated route list and startup console. Before any button press, neither the lazy target route nor its module-evaluation marker should appear.