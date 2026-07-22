"""
Backend reverse geocoding — Stage 1: server becomes the canonical source
for location_name so all family members see the same label for the same
coordinates, regardless of platform or cache state on the sender's device.

Architecture
------------
Feature flag : GEOCODE_BACKEND env var ("true" / "false", default "false").
               When off, resolve_location_name returns (None, True) and the
               caller falls through to the existing client-provided label —
               zero change in behaviour.

Cache        : db.geocode_cache, keyed on coordinates rounded to 4 decimal
               places (~11 m grid at mid-latitudes).  Two devices in the
               same parking lot share one cache entry and one API call.
               TTL index (24 h) is created at startup by server.py.

Provider     : Google Geocoding REST API via httpx (async, 5 s timeout).
               Same parsing logic as the client-side geocodeWithGoogle so
               labels are identical to what a successful client REST call
               would have produced.

Diff logging : callers receive (backend_label, label_matches_client) and
               write the comparison into location_ingest_log so the beta
               period produces concrete evidence of divergence before the
               client-side geocoding code is removed.

Stage 2 (future, not this PR)
------------------------------
Once the diff log confirms consistent correctness, remove:
  • geocodeWithGoogle / _geocodeLabelWithDiag / geocodeLabelForCoord in
    frontend/src/locationRefresh.ts
  • the location_name field from the PUT /members/{id}/location body
  • lastGeocodedLat / lastGeocodedLon / lastGeocodedName cache variables
"""

from __future__ import annotations

import logging
import math
import os
from datetime import datetime, timedelta, timezone
from typing import Optional, Tuple

import httpx

logger = logging.getLogger(__name__)

# ── Feature flag ──────────────────────────────────────────────────────────────
# Set USE_BACKEND_GEOCODING=true in Railway environment variables to enable.
# Default is false — all existing client-side behaviour is preserved until
# the flag is explicitly turned on.
GEOCODE_BACKEND_ENABLED: bool = (
    os.environ.get("USE_BACKEND_GEOCODING", "false").strip().lower() == "true"
)

# ── Google Maps API key ───────────────────────────────────────────────────────
# Prefer a dedicated server-side key (GOOGLE_MAPS_API_KEY).
# Falls back to the app key (EXPO_PUBLIC_GOOGLE_MAPS_API_KEY) so the
# feature works immediately with the existing credential while a
# server-restricted key is being provisioned.
_GOOGLE_KEY: str = (
    os.environ.get("GOOGLE_MAPS_API_KEY", "").strip()
    or os.environ.get("EXPO_PUBLIC_GOOGLE_MAPS_API_KEY", "").strip()
)

# ── Cache configuration ───────────────────────────────────────────────────────
_COORD_PRECISION = 4          # 4 dp ≈ 11 m — enough to share cache across devices
_CACHE_COLLECTION = "geocode_cache"
CACHE_TTL = timedelta(hours=24)
_PROVIDER_LABEL = "Google Geocoding API"


# ── Helpers ───────────────────────────────────────────────────────────────────

def _cache_key(lat: float, lon: float) -> str:
    """Round lat/lon to _COORD_PRECISION and return a stable cache key string."""
    r = 10 ** _COORD_PRECISION
    rlat = math.floor(lat * r) / r
    rlon = math.floor(lon * r) / r
    return f"{rlat},{rlon}"


async def _cache_get(db, key: str) -> Optional[str]:
    try:
        doc = await db[_CACHE_COLLECTION].find_one({"_id": key}, {"location_name": 1})
        return doc["location_name"] if doc else None
    except Exception as exc:
        logger.warning(f"geocode_cache read failed: {exc!r}")
        return None


async def _cache_set(db, key: str, label: str, resolution_ms: float) -> None:
    try:
        await db[_CACHE_COLLECTION].update_one(
            {"_id": key},
            {"$set": {
                "location_name": label,
                "provider":      _PROVIDER_LABEL,
                "resolved_at":   datetime.now(timezone.utc),
                "resolution_ms": resolution_ms,
            }},
            upsert=True,
        )
    except Exception as exc:
        logger.warning(f"geocode_cache write failed: {exc!r}")


async def _call_google(lat: float, lon: float) -> Tuple[Optional[str], float]:
    """
    Call the Google Geocoding REST API.

    Returns (label, elapsed_ms).  label is None on any failure.
    Parsing mirrors client-side geocodeWithGoogle (locationRefresh.ts) so
    labels are identical to what a successful client REST call would produce:
      • "Walmart Supercenter, Phoenix"  (premise + locality)
      • "Phoenix, AZ"                   (locality + state)
      • "Phoenix"                       (locality only, non-US)
    """
    import time as _time

    if not _GOOGLE_KEY:
        logger.warning(
            "geocoding: GOOGLE_MAPS_API_KEY is not set — "
            "backend geocoding is enabled but will always fail. "
            "Set GOOGLE_MAPS_API_KEY (or EXPO_PUBLIC_GOOGLE_MAPS_API_KEY) "
            "in Railway environment variables."
        )
        return None, 0.0

    url = (
        f"https://maps.googleapis.com/maps/api/geocode/json"
        f"?latlng={lat},{lon}&key={_GOOGLE_KEY}"
    )
    t0 = _time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=5.0) as http:
            resp = await http.get(url)
        elapsed_ms = (_time.monotonic() - t0) * 1000

        if resp.status_code != 200:
            logger.warning(f"geocoding: Google API HTTP {resp.status_code}")
            return None, elapsed_ms

        j = resp.json()
        status = j.get("status")
        if status != "OK":
            logger.warning(f"geocoding: Google API status={status!r}")
            return None, elapsed_ms

        results = j.get("results") or []
        if not results:
            return None, elapsed_ms

        # Parse the first (most specific) result's address_components.
        components = results[0].get("address_components", [])
        locality = ""
        state_short = ""
        premise = ""
        route = ""

        for c in components:
            types = c.get("types", [])
            if "locality" in types:
                locality = c["long_name"]
            if "administrative_area_level_1" in types:
                state_short = c["short_name"]
            if any(t in types for t in ("premise", "establishment", "point_of_interest")):
                premise = c["long_name"]
            if "route" in types:
                route = c["long_name"]

        # A result with only a route and no locality is a street address — skip.
        if route and not locality:
            return None, elapsed_ms

        if premise and locality and premise != locality:
            return f"{premise}, {locality}", elapsed_ms
        if locality and state_short:
            return f"{locality}, {state_short}", elapsed_ms
        if locality:
            return locality, elapsed_ms

        logger.debug(f"geocoding: no locality in result for ({lat},{lon})")
        return None, elapsed_ms

    except Exception as exc:
        elapsed_ms = (_time.monotonic() - t0) * 1000
        logger.warning(f"geocoding: Google API exception: {exc!r}")
        return None, elapsed_ms


# ── Public API ────────────────────────────────────────────────────────────────

async def resolve_location_name(
    db,
    lat: float,
    lon: float,
    client_label: Optional[str] = None,
) -> Tuple[Optional[str], Optional[bool]]:
    """
    Resolve the canonical location_name for (lat, lon).

    Returns
    -------
    (backend_label, label_matches_client)

    backend_label        The server-resolved label, or None if:
                           - GEOCODE_BACKEND flag is off, OR
                           - API call failed and cache was cold.
                         When None the caller should retain the
                         client-provided label (existing behaviour).

    label_matches_client True  — backend and client agree (or flag is off).
                         False — divergence detected; caller should log.
                         None  — flag is off; no comparison was made.

    This function never raises.
    """
    if not GEOCODE_BACKEND_ENABLED:
        return None, None   # flag off — caller uses client label unchanged

    key = _cache_key(lat, lon)

    # 1. Cache hit — no API call needed.
    cached = await _cache_get(db, key)
    if cached is not None:
        matches = (cached == client_label)
        if not matches:
            logger.info(
                f"geocode_diff(cache_hit) "
                f"backend={cached!r} client={client_label!r} "
                f"key={key}"
            )
        return cached, matches

    # 2. Cache miss — call Google REST.
    label, elapsed_ms = await _call_google(lat, lon)
    if label:
        await _cache_set(db, key, label, elapsed_ms)
        matches = (label == client_label)
        if not matches:
            logger.info(
                f"geocode_diff(google_rest) "
                f"backend={label!r} client={client_label!r} "
                f"key={key} elapsed_ms={elapsed_ms:.0f}"
            )
        return label, matches

    # 3. API failed — return None so the caller keeps the client label.
    logger.warning(
        f"geocoding: all providers failed for ({lat},{lon}); "
        f"falling back to client label={client_label!r}"
    )
    return None, None


async def ensure_indexes(db) -> None:
    """Create the geocode_cache TTL index.  Called once at startup."""
    try:
        await db[_CACHE_COLLECTION].create_index(
            [("resolved_at", 1)],
            expireAfterSeconds=int(CACHE_TTL.total_seconds()),
            name="geocode_cache_ttl",
        )
        logger.info(f"geocode_cache TTL index ensured ({CACHE_TTL})")
    except Exception as exc:
        logger.warning(f"geocode_cache index skipped: {exc!r}")
