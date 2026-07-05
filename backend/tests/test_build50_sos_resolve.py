"""
Backend regression + new-feature test suite for Kinnship Build #50 —
SOS Emergency Experience overhaul.

Covers:
  #1 SOS trigger (clean payload) still returns 200 and drops fall_detected
  #2 Legacy `fall_detected: true` payload — the review request expects a
     422.  Note: unless SOSRequest sets extra='forbid', Pydantic v2 will
     silently drop the unknown field.  The test asserts the requirement
     (422) so any drift is caught.
  #3 POST /alerts/{id}/resolve happy path + idempotency
  #4 POST /alerts/{id}/resolve with bogus id → 404
  #5 POST /alerts/{id}/resolve cross-tenant → 404
  #6 GET /alerts response includes resolved/resolved_at/resolved_by_*
  #7 POST /alerts/{id}/ack still works (older endpoint)

Requires backend running at EXPO_PUBLIC_BACKEND_URL (public preview URL
serving through kubernetes ingress).  Alice's long-lived JWT is loaded
from /app/memory/test_credentials.md.
"""
from __future__ import annotations

import os
import uuid
from typing import Any, Dict

import pymongo
import pytest
import requests
from dotenv import load_dotenv

load_dotenv("/app/frontend/.env")
load_dotenv("/app/backend/.env")

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "").rstrip("/")
assert BASE_URL, "EXPO_PUBLIC_BACKEND_URL not set — refusing to run"

ALICE_JWT = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJzdWIiOiI3ZDI4NTg5YS1mNDJhLTQ2OTMtYmU5Ni0zNGE0MDM2ODViOWIiLCJleHAiOjE4MTIyMjY0NjB9."
    "GxlsVHwyy6W_f-f2c2PMlLgBYLphaOGphPmES7C9CLE"
)
ALICE_USER_ID = "7d28589a-f42a-4693-be96-34a403685b9b"
ALICE_FAMILY_ID = "5e214a2f-c794-4649-bbd0-f42fbf2c32da"

AUTH_HEADERS = {
    "Authorization": f"Bearer {ALICE_JWT}",
    "Content-Type": "application/json",
}

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")


# ------------------------- fixtures -------------------------

@pytest.fixture(scope="session")
def api():
    s = requests.Session()
    s.headers.update(AUTH_HEADERS)
    return s


@pytest.fixture(scope="session")
def mongo():
    client = pymongo.MongoClient(MONGO_URL)
    return client[DB_NAME]


@pytest.fixture()
def created_alert_id(api) -> str:
    """
    Fires a real SOS as Alice and returns the resulting alert id.
    Each test that mutates the alert gets its own fresh alert so
    idempotency / resolve state is isolated per test.
    """
    r = api.post(
        f"{BASE_URL}/api/sos",
        json={"member_id": None, "latitude": 40.7128, "longitude": -74.0060},
    )
    assert r.status_code == 200, f"SOS setup failed: {r.status_code} {r.text}"
    alert_id = r.json().get("alert_id")
    assert alert_id, f"No alert_id in SOS response: {r.json()}"
    yield alert_id
    # best-effort cleanup — remove the alert we created
    try:
        client = pymongo.MongoClient(MONGO_URL)
        client[DB_NAME].alerts.delete_one({"id": alert_id})
    except Exception:
        pass


# ------------------------- tests -------------------------

# ============  #1 SOS clean payload — regression  ============
class TestSOSCleanPayload:
    def test_sos_accepts_payload_without_fall_detected(self, api):
        payload = {"member_id": None, "latitude": 12.34, "longitude": 56.78}
        r = api.post(f"{BASE_URL}/api/sos", json=payload)
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"

        body: Dict[str, Any] = r.json()
        # Response must NOT contain any fall-related field.
        for banned in ("fall_detected", "fall_prefix"):
            assert banned not in body, (
                f"Legacy field '{banned}' still in /sos response: {body}"
            )

        # Structural check — the shape the frontend expects.
        assert body.get("ok") is True
        assert body.get("alert_id")
        assert body.get("emergency_number") == "911"
        assert body.get("family_group_id") == ALICE_FAMILY_ID

        # Cleanup this incidental alert.
        try:
            client = pymongo.MongoClient(MONGO_URL)
            client[DB_NAME].alerts.delete_one({"id": body["alert_id"]})
        except Exception:
            pass


# ============  #2 SOS with legacy fall_detected — should 422  ============
class TestSOSLegacyRejected:
    def test_sos_rejects_legacy_fall_detected_key(self, api):
        payload = {
            "member_id": None,
            "latitude": 12.34,
            "longitude": 56.78,
            "fall_detected": True,  # legacy — MUST be rejected per Build 50 spec
        }
        r = api.post(f"{BASE_URL}/api/sos", json=payload)
        # Per review request, `fall_detected` was completely purged and the
        # endpoint should reject extra fields with 422.
        assert r.status_code == 422, (
            f"Legacy payload with fall_detected should be REJECTED with 422 "
            f"(Pydantic extra='forbid'). Got {r.status_code}: {r.text[:400]}"
        )


# ============  #3 Resolve happy path + idempotency  ============
class TestResolveHappyPath:
    def test_resolve_marks_alert_and_is_idempotent(self, api, created_alert_id):
        alert_id = created_alert_id

        # 1st call — should perform the resolution.
        r1 = api.post(f"{BASE_URL}/api/alerts/{alert_id}/resolve")
        assert r1.status_code == 200, f"resolve #1 failed: {r1.status_code} {r1.text}"
        j1 = r1.json()
        assert j1.get("ok") is True
        alert = j1.get("alert")
        assert isinstance(alert, dict), f"Missing 'alert' object: {j1}"
        assert alert.get("resolved") is True, alert
        assert alert.get("acknowledged") is True, alert
        assert alert.get("resolved_at"), f"resolved_at not stamped: {alert}"
        assert alert.get("resolved_by_user_id") == ALICE_USER_ID, alert
        # resolver_name falls back to full_name → email → generic
        assert alert.get("resolved_by_name"), alert
        assert not j1.get("already_resolved"), (
            "First resolve should NOT be flagged already_resolved"
        )

        # 2nd call — idempotent.
        r2 = api.post(f"{BASE_URL}/api/alerts/{alert_id}/resolve")
        assert r2.status_code == 200, f"resolve #2 failed: {r2.status_code} {r2.text}"
        j2 = r2.json()
        assert j2.get("ok") is True
        assert j2.get("already_resolved") is True, (
            f"Second resolve should return already_resolved=True: {j2}"
        )
        alert2 = j2.get("alert")
        assert alert2.get("resolved") is True
        # Idempotency: resolved_at must refer to the SAME instant (mongo
        # truncates to ms precision so a strict string match will fail;
        # compare at second-level to still catch a re-stamp).
        assert alert2.get("resolved_at")[:19] == alert.get("resolved_at")[:19], (
            f"resolved_at should not be re-stamped on idempotent resolve: "
            f"first={alert.get('resolved_at')} second={alert2.get('resolved_at')}"
        )
        assert alert2.get("resolved_by_user_id") == ALICE_USER_ID


# ============  #4 Bogus alert id → 404  ============
class TestResolveBogusId:
    def test_resolve_returns_404_for_unknown_alert(self, api):
        bogus_id = f"nonexistent-{uuid.uuid4()}"
        r = api.post(f"{BASE_URL}/api/alerts/{bogus_id}/resolve")
        assert r.status_code == 404, (
            f"Expected 404 for bogus id, got {r.status_code}: {r.text[:300]}"
        )


# ============  #5 Cross-tenant → 404  ============
class TestResolveCrossTenant:
    """
    Insert an alert directly into MongoDB under a foreign family_group_id
    (bypassing the /sos flow), then attempt to resolve it as Alice.
    Alice's JWT resolves to ALICE_FAMILY_ID, so the doc lookup with
    {alert_id, family_group_id: ALICE_FAMILY_ID} should MISS → 404.
    """

    def test_resolve_cross_tenant_returns_404(self, api, mongo):
        foreign_family_id = f"foreign-family-{uuid.uuid4()}"
        foreign_alert_id = f"foreign-alert-{uuid.uuid4()}"
        mongo.alerts.insert_one(
            {
                "id": foreign_alert_id,
                "owner_id": "someone-else",
                "family_group_id": foreign_family_id,
                "member_id": "m1",
                "member_name": "Stranger",
                "type": "sos",
                "severity": "critical",
                "title": "SOS Emergency — Stranger",
                "message": "test cross-tenant",
                "acknowledged": False,
                "resolved": False,
            }
        )
        try:
            r = api.post(f"{BASE_URL}/api/alerts/{foreign_alert_id}/resolve")
            assert r.status_code == 404, (
                f"Cross-tenant resolve should 404, got {r.status_code}: {r.text[:300]}"
            )

            # And crucially — the foreign alert must remain UNTOUCHED.
            doc = mongo.alerts.find_one({"id": foreign_alert_id})
            assert doc is not None
            assert doc.get("resolved") in (False, None), (
                f"Cross-tenant resolve leaked mutation: {doc}"
            )
        finally:
            mongo.alerts.delete_one({"id": foreign_alert_id})


# ============  #6 GET /alerts exposes new fields  ============
class TestAlertsListShape:
    def test_get_alerts_exposes_resolved_fields(self, api, created_alert_id):
        r = api.get(f"{BASE_URL}/api/alerts")
        assert r.status_code == 200, f"GET /alerts failed: {r.status_code} {r.text}"
        body = r.json()
        # Endpoint could return a list or {alerts: [...]}, handle either.
        alerts = body if isinstance(body, list) else body.get("alerts", [])
        assert isinstance(alerts, list) and alerts, (
            f"No alerts returned; expected at least the fresh SOS: {body}"
        )
        # Find our just-created alert.
        target = next((a for a in alerts if a.get("id") == created_alert_id), None)
        assert target is not None, (
            f"Freshly created alert {created_alert_id} not in GET /alerts response"
        )
        for field in ("resolved", "resolved_at", "resolved_by_user_id", "resolved_by_name"):
            assert field in target, (
                f"Alert missing new Build 50 field '{field}': keys={list(target.keys())}"
            )
        # New alert not yet resolved.
        assert target["resolved"] in (False, None)


# ============  #7 /alerts/{id}/ack still works  ============
class TestAckStillWorks:
    def test_ack_endpoint_regression(self, api, created_alert_id):
        r = api.post(f"{BASE_URL}/api/alerts/{created_alert_id}/ack")
        assert r.status_code == 200, f"/ack failed: {r.status_code} {r.text}"
        j = r.json()
        assert j.get("ok") is True, j

        # Bonus: unknown alert on /ack should still 404.
        r2 = api.post(f"{BASE_URL}/api/alerts/does-not-exist-{uuid.uuid4()}/ack")
        assert r2.status_code == 404, (
            f"/ack of unknown id should 404, got {r2.status_code}: {r2.text[:200]}"
        )
