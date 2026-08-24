---
name: Active Railway backend
description: Which duplicated backend tree is currently serving Railway production, and how to verify it before reviewing or changing release behavior.
---

Production Railway is currently serving the `backend/` implementation, not the duplicated root-level backend files.

**Why:** The live service's authenticated welfare-check routes and successful location-ingest behavior match code that exists only in the `backend/` tree. Reviewing the root copy alone produced false reports of missing routes and rejected native location payloads.

**How to apply:** Before evaluating or changing backend behavior, inspect the `backend/` implementation and verify the live endpoint when deployment source matters. Do not infer the active Railway source solely from the root `railway.json` while the duplicate tree remains.