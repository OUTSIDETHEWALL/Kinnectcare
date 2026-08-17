"""Task #66 — Catch a silent geocoding failure that leaves every family member
showing 'Unknown' after a phone upload.

Coverage matrix
---------------
1. GET /diagnostics/health reports geocoding_enabled=true.
   Confirms USE_BACKEND_GEOCODING is set in the Railway environment.
   Failure here means every upload will leave location_name=None.

2. GET /diagnostics/health reports geocoding_key_present=true.
   Confirms GOOGLE_MAPS_API_KEY (or fallback) is non-empty.
   Flag enabled + key missing = silent failure on every geocode call.

3. GET /diagnostics/health reports geocoding_healthy=true.
   Convenience assertion: both flag and key are present at once.

4. After a location upload, GET /members returns a non-null, non-sentinel
   location_name for the uploaded member.
   Confirms the full pipeline (upload → lazy geocode → dashboard) works
   end-to-end; catches a regression where the flag is set but geocoding
   silently returns None (bad key, quota, etc.).

Configuration (all via environment variables — no credentials in source)
------------------------------------------------------------------------
KINNSHIP_TEST_BASE_URL   Base URL of the deployment under test.
                         Defaults to http://localhost:8000.
                         Example: https://family-guard-37.preview.emergentagent.com

KINNSHIP_TEST_JWT        Bearer token for an authenticated test user.
                         Required: all tests are skipped when absent.

KINNSHIP_TEST_LAT        Latitude for geocoding tests (float string).
                         Defaults to 35.0248 (Fort Mohave, AZ — coordinates
                         already warm in the geocode_cache from prior test runs).

KINNSHIP_TEST_LON        Longitude for geocoding tests (float string).
                         Defaults to -114.5742.
"""

import os
import time
import pytest
import requests

# ---------------------------------------------------------------------------
# Configuration from environment — no credentials committed to source
# ---------------------------------------------------------------------------

BASE_URL = os.environ.get("KINNSHIP_TEST_BASE_URL", "http://localhost:8000").rstrip("/")
API = f"{BASE_URL}/api"

_RAW_JWT = os.environ.get("KINNSHIP_TEST_JWT", "")

# Default test coordinates: Fort Mohave, AZ — already warm in geocode_cache
# from prior test runs; avoids a live Google API call in most executions.
TEST_LAT = float(os.environ.get("KINNSHIP_TEST_LAT", "35.0248"))
TEST_LON = float(os.environ.get("KINNSHIP_TEST_LON", "-114.5742"))


def _auth() -> dict:
    return {"Authorization": f"Bearer {_RAW_JWT}", "Content-Type": "application/json"}


# ---------------------------------------------------------------------------
# Module-level skip when required credentials are absent
# ---------------------------------------------------------------------------

def _require_jwt():
    """Skip the whole module gracefully when no JWT is configured."""
    if not _RAW_JWT:
        pytest.skip(
            "KINNSHIP_TEST_JWT env var not set — skipping live-API geocoding tests. "
            "Set KINNSHIP_TEST_JWT (and optionally KINNSHIP_TEST_BASE_URL) to run."
        )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _create_test_member(headers: dict, name: str) -> dict:
    payload = {
        "name": name,
        "age": 70,
        "phone": "+15550001234",
        "gender": "female",
        "role": "senior",
    }
    r = requests.post(f"{API}/members", headers=headers, json=payload, timeout=15)
    assert r.status_code == 200, f"create_member failed: {r.status_code} {r.text}"
    return r.json()


def _delete_member(headers: dict, member_id: str) -> None:
    try:
        requests.delete(f"{API}/members/{member_id}", headers=headers, timeout=10)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def alice_headers():
    _require_jwt()
    return _auth()


@pytest.fixture()
def geocoding_member(alice_headers):
    """Ephemeral member — created fresh, deleted after each test."""
    m = _create_test_member(alice_headers, f"TEST_GeoCfg_{int(time.time())}")
    yield m
    _delete_member(alice_headers, m["id"])


# ---------------------------------------------------------------------------
# 1–3. /diagnostics/health — geocoding configuration assertions
# ---------------------------------------------------------------------------


class TestGeocodingConfigHealth:
    def test_diagnostics_health_endpoint_responds(self, alice_headers):
        """GET /diagnostics/health returns 200 and the expected shape."""
        r = requests.get(f"{API}/diagnostics/health", headers=alice_headers, timeout=10)
        assert r.status_code == 200, (
            f"GET /diagnostics/health failed: {r.status_code} {r.text}"
        )
        body = r.json()
        # All four keys must be present.
        for key in ("geocoding_enabled", "geocoding_key_present",
                    "geocoding_key_source", "geocoding_healthy"):
            assert key in body, (
                f"Missing key {key!r} in /diagnostics/health response: {body}"
            )

    def test_geocoding_flag_is_enabled(self, alice_headers):
        """USE_BACKEND_GEOCODING must be true in the Railway environment.

        If this fails, every location upload will leave location_name=None in
        the DB and caregivers will see "Unknown" on every member card.
        """
        r = requests.get(f"{API}/diagnostics/health", headers=alice_headers, timeout=10)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["geocoding_enabled"] is True, (
            "geocoding_enabled=False — USE_BACKEND_GEOCODING is not set to 'true' "
            "in the deployment environment variables. Every location upload will "
            "leave location_name=null and caregivers will see 'Unknown' on the dashboard."
        )

    def test_geocoding_api_key_is_present(self, alice_headers):
        """GOOGLE_MAPS_API_KEY (or its fallback) must be non-empty.

        If this fails, backend geocoding is enabled but every API call will
        fail silently and return None, leaving location_name=null in the DB.
        """
        r = requests.get(f"{API}/diagnostics/health", headers=alice_headers, timeout=10)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["geocoding_key_present"] is True, (
            f"geocoding_key_present=False (source={body.get('geocoding_key_source')!r}) — "
            "no GOOGLE_MAPS_API_KEY found. Backend geocoding is enabled but will "
            "fail on every API call, leaving location_name=null."
        )

    def test_geocoding_healthy_flag(self, alice_headers):
        """geocoding_healthy must be True — flag on AND key present.

        This is the single convenience check Charles can monitor; it fails
        when either condition is broken.
        """
        r = requests.get(f"{API}/diagnostics/health", headers=alice_headers, timeout=10)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["geocoding_healthy"] is True, (
            f"geocoding_healthy=False — flag={body.get('geocoding_enabled')} "
            f"key_present={body.get('geocoding_key_present')} "
            f"key_source={body.get('geocoding_key_source')!r}. "
            "Caregivers will see 'Unknown' for every family member location."
        )


# ---------------------------------------------------------------------------
# 4. End-to-end: upload → lazy geocode → non-sentinel name in GET /members
# ---------------------------------------------------------------------------


class TestGeocodingEndToEnd:
    def test_upload_then_list_returns_non_sentinel_name(
        self, alice_headers, geocoding_member
    ):
        """After PUT /location, GET /members must return a resolved location_name
        — not null, not blank, not 'Unknown', not 'Location Sharing Off'.

        Catches the silent regression described in Task #66: flag off (or key
        missing) → resolve_location_name returns (None, None) → GET /members
        returns null → FamilyMember model falls back to 'Unknown'.
        """
        mid = geocoding_member["id"]

        # Upload real coordinates (default: Fort Mohave — geocode_cache may
        # already be warm from prior test runs, which is fine: cache hit is
        # the correct behaviour and avoids a live Google API call).
        r_put = requests.put(
            f"{API}/members/{mid}/location",
            headers=alice_headers,
            json={"latitude": TEST_LAT, "longitude": TEST_LON},
            timeout=15,
        )
        assert r_put.status_code == 200, f"PUT /location failed: {r_put.text}"

        # GET /members — the lazy geocoding block must resolve the name.
        r_list = requests.get(f"{API}/members", headers=alice_headers, timeout=15)
        assert r_list.status_code == 200, f"GET /members failed: {r_list.text}"

        row = next((m for m in r_list.json() if m["id"] == mid), None)
        assert row is not None, "Test member missing from GET /members response"

        name = row.get("location_name")

        assert name is not None, (
            "location_name is None after upload+lazy geocoding — "
            "caregivers would see 'Unknown'. "
            "Check USE_BACKEND_GEOCODING and GOOGLE_MAPS_API_KEY in the deployment "
            f"environment. member_id={mid}"
        )
        assert name.strip() != "", (
            f"location_name is blank after lazy geocoding: {name!r}"
        )
        assert name not in ("Unknown", "Location Sharing Off"), (
            f"location_name is a sentinel/error label — geocoding failed silently: "
            f"{name!r}. member_id={mid}"
        )
