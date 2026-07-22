---
name: Geocoding architecture decision
description: Backend canonical reverse geocoding — live in production. Stage 2 scope and key restriction guidance.
---

## Current production state (as of July 2026)

Backend geocoding is **live**. `USE_BACKEND_GEOCODING=true` in Railway. Startup log confirms:
```
geocoding init: key=present source=GOOGLE_MAPS_API_KEY key_len=39 flag_enabled=True
```

Dedicated backend `GOOGLE_MAPS_API_KEY` is set in Railway, separate from the Expo/mobile key.

**Why this was built:** Two devices in the same vehicle showed different city names ("Fort Mohave, AZ" vs "Bullhead City, AZ") because each device ran its own geocoder independently. iOS falls back to Apple MapKit on Google REST failure; Android uses Google native. Background location task never geocoded at all.

## Architecture

```
Phone → GPS Coordinates → Backend → Mongo cache → Google (cache miss only) → Canonical location name → Dashboard
```

`db.geocode_cache`: key = 4 dp rounded coords (~11 m grid), TTL 24 h. Cache doc: `location_name`, `provider`, `resolved_at`, `resolution_ms`.

`resolve_location_name()` never raises — GPS uploads cannot be blocked by a geocoding failure. Client geocoding code (`locationRefresh.ts`) is intentionally untouched until Stage 2.

## Beta validation query

```js
db.location_ingest_log.find(
  { geocode_label_matched: false },
  { at:1, member_id:1, location_name:1, backend_location_name:1, latitude:1, longitude:1 }
).sort({ at:-1 }).limit(50)
```

`geocode_label_matched: false` = backend and client labels diverged. Review each during Charles + Joyce field test.

## Stage 2 — future PR (after beta validates consistency)

Remove in one PR:
- `geocodeWithGoogle`, `_geocodeLabelWithDiag`, `geocodeLabelForCoord` from `frontend/src/locationRefresh.ts`
- `lastGeocodedLat`, `lastGeocodedLon`, `lastGeocodedName` module-level cache vars
- `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY` fallback from `backend/geocoding.py` (`_GOOGLE_KEY` or-clause)
- `location_name` from client PUT request body
- Platform fallback geocoder (`Location.reverseGeocodeAsync` path)

**Why:** Charles explicitly approved removing the Expo key fallback and client geocoding in the same cleanup PR.

## Google Maps API key restriction (outstanding)

**Always apply:** API restriction → Geocoding API only in Google Cloud Console (limits blast radius; noted in rollout doc as not yet confirmed complete).

**IP restriction:** Only on Railway **Pro plan** (provides stable static outbound IPs). On lower plans, egress IPs are dynamic — IP restriction breaks silently on redeploy. Confirm static IPs in Railway dashboard before adding to Google Cloud.

## Logging quirk — lesson learned

Module-level `logger.info()` in `geocoding.py` fires at import time (server.py line 40), before `logging.basicConfig()` at line 4601. Python's last-resort handler silently drops INFO. Any future startup diagnostics must go inside `ensure_indexes()` or another FastAPI startup event handler.
