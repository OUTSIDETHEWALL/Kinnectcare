---
name: Railway entrypoint parity
description: How to safely maintain duplicated root and backend Railway deployment paths.
---

Treat the checked-in root and backend Railway entrypoints as independently deployable until the deployment is explicitly consolidated. Apply and test startup security and runtime dependency fixes in both paths.

**Why:** A security patch initially updated only the backend requirements, while the checked-in root Railway configuration builds the root requirements and starts the root server. Earlier production observations pointed at the backend copy, so neither source alone is sufficient to infer deployment behavior.

**How to apply:** For deployment-relevant changes, inspect both Railway configurations and test both server imports. Before a production change, verify the selected service's active source configuration externally rather than relying on repository structure or prior observations.