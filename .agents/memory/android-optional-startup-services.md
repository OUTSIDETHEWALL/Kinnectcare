---
name: Bound optional Android startup services
description: Optional Play/OEM callbacks must not be allowed to strand the React and authentication bootstrap.
---

Optional Android services such as Play Install Referrer must have a short startup deadline. Authentication restoration and the first interactive React surface must continue even if the native service never invokes success or error callbacks.

**Why:** A cold launcher start can wait indefinitely for an OEM/Play service callback, while Android continues displaying a stale starting-window snapshot that looks like the app but cannot receive React touches. A later activity reuse or resume can mask the failure and appear healthy.

**How to apply:** Bound startup waits, handle synchronous native throws and async persistence failures, and allow useful late callbacks to save their result without re-blocking startup.

If the bounded-referrer fix does not restore an interactive launcher start, stop treating Install Referrer as the presumed cause. Instrument and compare these milestones between a home-screen launch and Settings → Manage Apps → Open: app launched, splash hidden, React root mounted, AuthProvider started, referrer waiting, referrer completed/timed out, auth restored, and Welcome interactive. The first missing milestone determines the next investigation layer.