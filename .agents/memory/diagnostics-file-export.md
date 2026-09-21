---
name: Diagnostics file export
description: Deferred delivery rule for exporting the complete Full Diagnostics payload as a shareable file.
---

Add one Export Diagnostics File action beside Copy Log in the next normal Android binary. It must reuse the existing Full Diagnostics payload unchanged, write the complete JSON to a timestamped file, and open Android's native share sheet with that file attached.

**Why:** Clipboard transfer through SMS or Telegram truncated a large diagnostics export. The current production binary does not contain a native file-sharing module, and introducing one through an OTA-only update risks a module-load crash.

**How to apply:** Include the required native sharing dependency only when preparing the next otherwise-needed Android binary. Preserve Copy Log and all diagnostic contents, retention, storage, and operational behavior. Do not create a standalone Android binary solely for this usability improvement.