---
name: Exact Diagnostics crash attribution
description: How to attribute Diagnostics render and async failures to persisted records without naming a false culprit.
---

Storage crash provenance must be attached to the exact thrown error. Persisted-record UI needs a real child React error boundary so reconciliation failures are caught; async readers need error-identity context.

**Why:** Global “last record read” state misattributes unrelated sibling failures, reversed/copied arrays, and concurrent reader rejections. A synchronous JSX callback also misses React reconciliation errors.

**How to apply:** Scope every persisted-record list row and latest-record summary with a child boundary. For unassociated errors, record null key/index/raw fields rather than inferring a culprit.