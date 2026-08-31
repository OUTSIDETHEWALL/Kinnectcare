---
name: Hero health clock-skew tolerance
description: Why the Diagnostics hero tolerates a small future persisted-upload timestamp.
---

Persisted successful-upload timestamps up to five seconds ahead of the live Diagnostics clock are treated as an upload that happened just now. Timestamps further ahead are not upload evidence.

**Why:** A small NTP or wall-clock correction between writing the AsyncStorage timestamp and the next one-second UI tick can otherwise make a freshly successful upload look absent, briefly showing a misleading startup state. A strict bound preserves protection against implausible future timestamps.

**How to apply:** Keep the bounded tolerance wherever the Diagnostics hero interprets its persisted successful-upload evidence. Cover both the inclusive five-second boundary and rejection beyond it whenever this logic changes.