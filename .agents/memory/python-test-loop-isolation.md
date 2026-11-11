---
name: Python test loop isolation
description: Preserve ambient loops and distinguish offline checks from live database integration tests.
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

## Offline versus live verification

Inspect a legacy suite's fixtures and resource setup before adding it to an
offline release check. A temporary database name does not make a test offline
or authorize database writes/drop operations.

**Why:** Expanding a focused check with a historical integration suite can
silently introduce real database connections and teardown writes, then stall
verification when the service is unavailable.

**How to apply:** Keep mocked endpoint/helper checks separate from explicitly
authorized live integration acceptance. Report unavailable integration checks
as unverified, not as passing and not as a product regression.
