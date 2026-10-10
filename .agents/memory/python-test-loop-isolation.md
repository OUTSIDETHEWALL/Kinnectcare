---
name: Python test loop isolation
description: Keep new async scenario tests from changing the ambient loop used by legacy synchronous backend tests.
---

New async scenario tests must own and close their loop without clearing the
process's ambient event loop.

**Why:** On Python 3.12, asyncio.run() clears the selected default loop. Tests
that pass alone can then break unchanged legacy synchronous tests that use
get_event_loop(), purely because they execute earlier in the full suite.

**How to apply:** Use asyncio.Runner with an explicit new_event_loop factory
for new synchronous wrappers around async scenarios. Verify both focused and
full-suite execution; do not refactor unrelated legacy tests to hide new test
isolation failures.
