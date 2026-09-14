---
name: BackgroundFetch execution generations
description: Lifecycle rule for preventing timed-out Android background work from corrupting a later invocation.
---

Treat every BackgroundFetch invocation as a unique generation even when the library supplies the same task ID. A timeout must invalidate that generation before finishing it; late continuations must not log outcomes or finish a newer generation.

**Why:** Android reuses task IDs, and the timeout callback does not cancel pending JavaScript or native promises. A boolean keyed only by task ID lets an old continuation finish or write evidence into a later run.

**How to apply:** Give each invocation an identity token, verify that token before post-await writes and completion, serialize shared diagnostic writes, and test timeout overlap with two runs using the same task ID.