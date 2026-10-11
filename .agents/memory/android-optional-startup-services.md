---
name: Bound optional Android startup services
description: Optional native callbacks must not strand startup or block enforcement of a known privacy withdrawal.
---

Optional Android services such as Play Install Referrer must have a short startup deadline. Authentication restoration and the first interactive React surface must continue even if the native service never invokes success or error callbacks.

**Why:** A cold launcher start can wait indefinitely for an OEM/Play service callback, while Android continues displaying a stale starting-window snapshot that looks like the app but cannot receive React touches. A later activity reuse or resume can mask the failure and appear healthy.

**How to apply:** Bound startup waits, handle synchronous native throws and async persistence failures, and allow useful late callbacks to save their result without re-blocking startup.

If the bounded-referrer fix does not restore an interactive launcher start, stop treating Install Referrer as the presumed cause. Instrument and compare these milestones between a home-screen launch and Settings → Manage Apps → Open: app launched, splash hidden, React root mounted, AuthProvider started, referrer waiting, referrer completed/timed out, auth restored, and Welcome interactive. The first missing milestone determines the next investigation layer.

Known privacy withdrawal must take precedence over permission inspection or other optional prerequisite callbacks during a cold wake.

**Why:** A rejected or never-returning permission query, including an unrelated notification-permission query, can otherwise prevent an already-recorded GPS revocation from reaching native shutdown. Passing tests with immediately resolved permission mocks do not establish this safety property.

**How to apply:** Enforce recorded revocation before optional inspection; test rejected and never-settling prerequisites with native tracking initially enabled and after process recreation. Keep optional battery authorization separate. Never use a timeout to release a queue around an uncancelled native operation that can later enable tracking.