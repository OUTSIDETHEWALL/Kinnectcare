---
name: GPS capture timestamp guard
description: How the backend prevents SDK buffer-replay from overwriting the current member location with historical GPS fixes.
---

## The rule
`update_member_location` uses a MongoDB atomic conditional update filter.  It only writes lat/lon/captured_at if `incoming_captured_at` is strictly greater than the stored `captured_at`.  `last_seen` (server contact time) is always written regardless, so Leonidas heartbeat monitoring is never blocked.

## Why
The Transistor Background Geolocation SDK buffers GPS fixes when offline and replays them in bulk when connectivity returns. Writing `last_seen = datetime.now()` unconditionally makes every upload (live or buffered) look identical. During a replay at ~90 uploads/minute the member row can oscillate across many historical locations; caregivers then see a different location on each refresh.

## How to apply
- `LocationUpdate.captured_at` property: parses `timestamp` field (ISO-8601 string or epoch-ms int/float); falls back to `coords.timestamp` for the Android nested fallback path; returns None if absent.
- Upper-bound guard in handler: if `incoming_captured_at > server_now + 5min`, discard it and fall back to unconditional write (device clock skew protection).
- MongoDB filter: `{"$or": [{"captured_at": {"$exists": False}}, {"captured_at": {"$lt": incoming}}]}` — atomic; safe against concurrent uploads.
- `FamilyMember` model has `captured_at: Optional[datetime] = None` — None for pre-Build-60 rows, populated on first upload after deploy.
- `location_ingest_log` has permanent fields: `incoming_captured_at`, `stored_captured_at`, `write_accepted`, `rejection_reason`.
- `diagnostics/my-members` projects `captured_at` alongside `last_seen`.
- Regression test: `backend/test_captured_at_guard.py` — 31 tests, no write access needed.
