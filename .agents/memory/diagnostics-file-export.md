---
name: Diagnostics file export
description: Native availability and top-of-page usability rules for complete Diagnostics file sharing.
---

Full Diagnostics file sharing must reuse the complete payload, write it to a timestamped file and share that file, rather than replacing the export with a clipboard excerpt.

**Why:** Clipboard transfer through SMS or Telegram truncated a large diagnostics export. Introducing a native file-sharing dependency through an OTA-only update can crash a binary that does not contain it.

**How to apply:** Verify native sharing is already in the target binary before OTA-only adjustments. Adding a missing native module requires a normal binary; do not initiate a standalone diagnostics binary without the user's request. Preserve Copy Log, all diagnostic contents, retention, storage and operational behavior.

## First practical action

Share Full Diagnostics / Share Diagnostics must be the first practical action
when Diagnostics opens, before long health, log and timeline sections.

**Why:** The user reported having to scroll through an enormous Diagnostics page
just to reach the export control.

**How to apply:** Keep full sharing above the long content when reorganizing the
screen, and preserve existing export concurrency and lifecycle protections.