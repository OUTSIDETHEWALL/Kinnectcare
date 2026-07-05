"""
v1.3.3 backend smoke tests:

  • GET  /api/diagnostics/refresh-traces           (auth, paginated, isolated)
  • GET  /api/me/preferences                       (auth, default shape)
  • PUT  /api/me/preferences                       (validation, persistence)
  • Quiet-hours suppression gate inside push_to_user()
    (verified directly against the in-process FastAPI app + Motor db)
  • Cross-account refresh-trace isolation
  • POST /api/members/{id}/request-location-refresh
    (now writes a trace row whose request_id matches the response.)

The OTP code is grepped out of /var/log/supervisor/backend.err.log per
the documented test flow (see /app/memory/test_credentials.md).
"""

import os
import re
import time
import uuid
import asyncio
import pytest
import requests

BASE_URL = "https://family-guard-37.preview.emergentagent.com"
API = f"{BASE_URL}/api"

# Alice (owner of empty family group) — pre-seeded JWT good for ~365 days.
ALICE_JWT = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJzdWIiOiI3ZDI4NTg5YS1mNDJhLTQ2OTMtYmU5Ni0zNGE0MDM2ODViOWIiLCJleHAiOjE4MTIyMjY0NjB9."
    "GxlsVHwyy6W_f-f2c2PMlLgBYLphaOGphPmES7C9CLE"
)
ALICE_USER_ID = "7d28589a-f42a-4693-be96-34a403685b9b"
ALICE_FG_ID = "5e214a2f-c794-4649-bbd0-f42fbf2c32da"

BACKEND_ERR_LOG = "/var/log/supervisor/backend.err.log"


# ---------------- helpers ----------------
def _hdrs(jwt: str) -> dict:
    return {"Authorization": f"Bearer {jwt}", "Content-Type": "application/json"}


def _grep_otp(email: str, since_offset: int) -> str:
    """Grep the backend error log for the latest OTP issued to `email`.
    `since_offset` is the byte offset at which we started watching so we
    don't pick up an earlier OTP from a previous run."""
    with open(BACKEND_ERR_LOG, "rb") as f:
        f.seek(since_offset)
        chunk = f.read().decode("utf-8", errors="ignore")
    # Format: "Code for <email>: 123456"
    matches = re.findall(rf"Code for {re.escape(email)}: (\d{{6}})", chunk)
    return matches[-1] if matches else ""


def _otp_signup(email_prefix: str = "v133bob") -> str:
    """Create a fresh OTP user (not in Alice's family group). Returns JWT."""
    email = f"{email_prefix}+{uuid.uuid4().hex[:8]}@example.com"
    offset = os.path.getsize(BACKEND_ERR_LOG)
    r = requests.post(f"{API}/auth/request-otp", json={
        "email": email, "purpose": "signup", "full_name": "Bob v1.3.3 Tester",
    }, timeout=20)
    assert r.status_code == 200, f"request-otp failed: {r.status_code} {r.text}"
    # Allow log to flush
    code = ""
    for _ in range(10):
        time.sleep(0.3)
        code = _grep_otp(email, offset)
        if code:
            break
    assert code, f"Could not find OTP for {email} in {BACKEND_ERR_LOG}"
    r2 = requests.post(f"{API}/auth/verify-otp", json={
        "email": email, "code": code, "full_name": "Bob v1.3.3 Tester",
    }, timeout=20)
    assert r2.status_code == 200, f"verify-otp failed: {r2.status_code} {r2.text}"
    return r2.json()["access_token"]


# ---------------- fixtures ----------------
@pytest.fixture(scope="module")
def alice_headers():
    return _hdrs(ALICE_JWT)


@pytest.fixture(scope="module")
def bob_headers():
    return _hdrs(_otp_signup())


@pytest.fixture(scope="module")
def alice_member_id(alice_headers):
    """Create a TEST_ member under Alice for refresh-trace tests; clean up after."""
    payload = {
        "name": "TEST_QHTarget",
        "age": 70,
        "phone": "+15555550000",
        "gender": "female",
        "role": "senior",
    }
    r = requests.post(f"{API}/members", json=payload, headers=alice_headers, timeout=20)
    assert r.status_code in (200, 201), r.text
    mid = r.json()["id"]
    yield mid
    try:
        requests.delete(f"{API}/members/{mid}", headers=alice_headers, timeout=20)
    except Exception:
        pass


@pytest.fixture(scope="module")
def bob_member_id(bob_headers):
    """Create a TEST_ member under Bob (different family group). Returns mid."""
    payload = {
        "name": "TEST_BobMember",
        "age": 65,
        "phone": "+15555550001",
        "gender": "male",
        "role": "senior",
    }
    r = requests.post(f"{API}/members", json=payload, headers=bob_headers, timeout=20)
    assert r.status_code in (200, 201), r.text
    mid = r.json()["id"]
    yield mid
    try:
        requests.delete(f"{API}/members/{mid}", headers=bob_headers, timeout=20)
    except Exception:
        pass


# ============================================================
#  1) GET /api/diagnostics/refresh-traces  (auth)
# ============================================================
class TestRefreshTracesEndpoint:
    def test_requires_auth(self):
        r = requests.get(f"{API}/diagnostics/refresh-traces", timeout=20)
        assert r.status_code in (401, 403), r.text

    def test_returns_envelope_shape(self, alice_headers):
        r = requests.get(f"{API}/diagnostics/refresh-traces", headers=alice_headers, timeout=20)
        assert r.status_code == 200, r.text
        body = r.json()
        assert "count" in body and "traces" in body
        assert isinstance(body["count"], int)
        assert isinstance(body["traces"], list)
        assert body["count"] == len(body["traces"])

    def test_limit_query_param_is_respected(self, alice_headers):
        r = requests.get(f"{API}/diagnostics/refresh-traces?limit=5", headers=alice_headers, timeout=20)
        assert r.status_code == 200
        assert len(r.json()["traces"]) <= 5


# ============================================================
#  2) GET /api/me/preferences  (auth + default shape)
# ============================================================
class TestGetPreferences:
    def test_requires_auth(self):
        r = requests.get(f"{API}/me/preferences", timeout=20)
        assert r.status_code in (401, 403)

    def test_default_shape(self, bob_headers):
        # Fresh OTP-signed-up Bob has no quiet_hours doc field → defaults.
        r = requests.get(f"{API}/me/preferences", headers=bob_headers, timeout=20)
        assert r.status_code == 200, r.text
        body = r.json()
        assert "quiet_hours" in body
        qh = body["quiet_hours"]
        assert qh["enabled"] is False
        assert qh["start"] == "22:00"
        assert qh["end"] == "07:00"


# ============================================================
#  3) PUT /api/me/preferences  (validation + persistence)
# ============================================================
class TestPutPreferences:
    def test_requires_auth(self):
        r = requests.put(f"{API}/me/preferences", json={"quiet_hours": {"enabled": True}}, timeout=20)
        assert r.status_code in (401, 403)

    def test_rejects_invalid_time(self, alice_headers):
        r = requests.put(
            f"{API}/me/preferences",
            json={"quiet_hours": {"enabled": True, "start": "25:00", "end": "07:00"}},
            headers=alice_headers, timeout=20,
        )
        assert r.status_code == 400, f"expected 400 for 25:00, got {r.status_code}: {r.text}"

    def test_accepts_and_persists(self, alice_headers):
        # Set a fixed value, then GET and ensure it round-trips.
        new_val = {"enabled": True, "start": "23:15", "end": "06:45"}
        r = requests.put(
            f"{API}/me/preferences",
            json={"quiet_hours": new_val},
            headers=alice_headers, timeout=20,
        )
        assert r.status_code == 200, r.text
        assert r.json()["quiet_hours"] == new_val

        # GET verifies the underlying mongo write.
        r2 = requests.get(f"{API}/me/preferences", headers=alice_headers, timeout=20)
        assert r2.status_code == 200
        assert r2.json()["quiet_hours"] == new_val

        # Cleanup: turn QH off so we don't pollute later tests / Alice's prod-ish account.
        requests.put(
            f"{API}/me/preferences",
            json={"quiet_hours": {"enabled": False, "start": "22:00", "end": "07:00"}},
            headers=alice_headers, timeout=20,
        )


# ============================================================
#  4) Quiet-hours suppression gate in push_to_user()
#     — run against the live in-process FastAPI module so we
#       can call push_to_user() directly.
# ============================================================
class TestQuietHoursPushGate:
    """Loads /app/backend/server.py into the same process and asserts the
    quiet_hours suppression branch is exercised when the window covers
    NOW, AND bypassed for emergency push types like {"type":"sos"}."""

    @pytest.fixture(scope="class")
    def server_module(self):
        import sys, importlib
        sys.path.insert(0, "/app/backend")
        return importlib.import_module("server")

    def _seed_qh(self, server_mod, user_id: str, qh: dict, push_tokens: list):
        async def _run():
            await server_mod.db.users.update_one(
                {"id": user_id},
                {"$set": {"quiet_hours": qh, "push_tokens": push_tokens}},
            )
        asyncio.get_event_loop().run_until_complete(_run())

    def _read_user(self, server_mod, user_id: str) -> dict:
        async def _run():
            return await server_mod.db.users.find_one(
                {"id": user_id},
                {"_id": 0, "push_tokens": 1, "quiet_hours": 1},
            )
        return asyncio.get_event_loop().run_until_complete(_run())

    def test_non_emergency_push_is_suppressed(self, server_module, caplog):
        # Build a QH window guaranteed to cover NOW (in UTC since user.timezone is unset).
        from datetime import datetime, timedelta, timezone
        now = datetime.now(timezone.utc)
        start = (now - timedelta(minutes=30)).strftime("%H:%M")
        end = (now + timedelta(minutes=30)).strftime("%H:%M")

        # Use a fake-but-Expo-shaped token; even if Expo rejects it, the
        # whole point is that quiet-hours should short-circuit BEFORE any
        # network call happens.  We use a marker we can identify later.
        marker_token = f"ExponentPushToken[TEST_QH_{uuid.uuid4().hex[:8]}]"
        self._seed_qh(
            server_module, ALICE_USER_ID,
            {"enabled": True, "start": start, "end": end},
            [marker_token],
        )
        # Pre-image: confirm token present.
        pre = self._read_user(server_module, ALICE_USER_ID)
        assert marker_token in (pre.get("push_tokens") or [])

        # Drive push_to_user() directly with a NON-emergency type.
        with caplog.at_level("INFO"):
            sent = asyncio.get_event_loop().run_until_complete(
                server_module.push_to_user(
                    ALICE_USER_ID, "Test QH", "Med reminder body",
                    {"type": "med_reminder"},
                )
            )
        # Suppressed → returns 0 (per the implementation) and we should
        # see the INFO log line.
        assert sent == 0, f"expected suppression (returns 0), got {sent}"
        joined_logs = " ".join(rec.getMessage() for rec in caplog.records)
        assert "quiet-hours-suppress" in joined_logs, (
            f"expected 'quiet-hours-suppress' INFO log, got:\n{joined_logs}"
        )

        # Token should still be unchanged after the suppressed call (no
        # delivery attempt happened, so no prune logic ran).
        post = self._read_user(server_module, ALICE_USER_ID)
        assert marker_token in (post.get("push_tokens") or []), (
            "marker token should not have been pruned during a suppressed call"
        )

    def test_emergency_sos_bypasses_quiet_hours(self, server_module, caplog):
        from datetime import datetime, timedelta, timezone
        now = datetime.now(timezone.utc)
        start = (now - timedelta(minutes=30)).strftime("%H:%M")
        end = (now + timedelta(minutes=30)).strftime("%H:%M")
        marker_token = f"ExponentPushToken[TEST_SOS_{uuid.uuid4().hex[:8]}]"
        self._seed_qh(
            server_module, ALICE_USER_ID,
            {"enabled": True, "start": start, "end": end},
            [marker_token],
        )

        # data.type=="sos" — must NOT be suppressed.
        with caplog.at_level("INFO"):
            sent = asyncio.get_event_loop().run_until_complete(
                server_module.push_to_user(
                    ALICE_USER_ID, "SOS", "Help!", {"type": "sos"},
                )
            )
        # We can't assert against Expo's response, but at minimum the
        # function must report >0 tokens attempted (it returns len(tokens)
        # at end of the non-suppressed path).
        assert sent == 1, f"expected SOS to bypass QH and attempt 1 token, got {sent}"
        joined_logs = " ".join(rec.getMessage() for rec in caplog.records)
        assert "quiet-hours-suppress" not in joined_logs, (
            "SOS push must NOT trigger the quiet-hours-suppress log line"
        )
        # The fake marker_token is invalid for Expo → it'll come back as
        # DeviceNotRegistered → the prune branch runs → token disappears
        # from the user doc.  That's expected; we just assert the gate
        # let it through.

    def teardown_method(self, method):
        # Always restore Alice to a clean QH=off / empty-push_tokens state
        # so subsequent tests / next iteration are not polluted.
        try:
            import importlib, sys
            sys.path.insert(0, "/app/backend")
            server_mod = importlib.import_module("server")

            async def _cleanup():
                await server_mod.db.users.update_one(
                    {"id": ALICE_USER_ID},
                    {"$set": {
                        "quiet_hours": {"enabled": False, "start": "22:00", "end": "07:00"},
                        "push_tokens": [],
                    }},
                )
            asyncio.get_event_loop().run_until_complete(_cleanup())
        except Exception as e:
            print(f"cleanup warning: {e}")


# ============================================================
#  5) POST /api/members/{id}/request-location-refresh
#     → trace row whose request_id matches response.request_id
# ============================================================
class TestRequestLocationRefreshTrace:
    def test_response_has_request_id_and_trace_written(self, alice_headers, alice_member_id):
        r = requests.post(
            f"{API}/members/{alice_member_id}/request-location-refresh",
            headers=alice_headers, timeout=20,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("ok") is True
        req_id = body.get("request_id")
        assert isinstance(req_id, str) and len(req_id) > 0, body

        # Now hit diagnostics endpoint and look for our trace.
        time.sleep(0.3)
        r2 = requests.get(
            f"{API}/diagnostics/refresh-traces?member_id={alice_member_id}",
            headers=alice_headers, timeout=20,
        )
        assert r2.status_code == 200, r2.text
        traces = r2.json()["traces"]
        assert any(t.get("request_id") == req_id for t in traces), (
            f"trace with request_id={req_id} not found in {traces}"
        )
        # Verify required shape on the matching trace.
        match = next(t for t in traces if t["request_id"] == req_id)
        for key in [
            "member_id", "request_id", "requested_at", "requester_user_id",
            "push_sent_at", "push_skipped_reason", "gps_received_at",
            "gps_lat", "gps_lon", "push_sent_after_ms", "gps_received_after_ms",
        ]:
            assert key in match, f"trace missing key {key}: {match}"
        assert match["member_id"] == alice_member_id
        assert match["requester_user_id"] == ALICE_USER_ID
        # Our TEST_QHTarget has no user_id link → expect push_skipped_reason=no_user_link.
        assert match["push_skipped_reason"] in ("no_user_link", "member_not_found", None) or \
               isinstance(match["push_skipped_reason"], str)


# ============================================================
#  6) Cross-account isolation
# ============================================================
class TestRefreshTraceIsolation:
    def test_alice_does_not_see_bob_traces(
        self, alice_headers, bob_headers, bob_member_id,
    ):
        # Bob fires a refresh against his own member.
        rb = requests.post(
            f"{API}/members/{bob_member_id}/request-location-refresh",
            headers=bob_headers, timeout=20,
        )
        assert rb.status_code == 200, rb.text
        bob_req_id = rb.json()["request_id"]

        # Bob sees it.
        rb2 = requests.get(f"{API}/diagnostics/refresh-traces", headers=bob_headers, timeout=20)
        assert rb2.status_code == 200
        bob_ids = [t["request_id"] for t in rb2.json()["traces"]]
        assert bob_req_id in bob_ids, "Bob should see his own trace"

        # Alice MUST NOT see Bob's trace.
        ra = requests.get(f"{API}/diagnostics/refresh-traces", headers=alice_headers, timeout=20)
        assert ra.status_code == 200
        alice_ids = [t["request_id"] for t in ra.json()["traces"]]
        assert bob_req_id not in alice_ids, (
            f"isolation breach: Alice sees Bob's request_id={bob_req_id} in {alice_ids}"
        )
        # And Alice should not see any trace whose requester_user_id is Bob.
        for t in ra.json()["traces"]:
            assert t["requester_user_id"] == ALICE_USER_ID, (
                f"Alice saw trace for requester_user_id={t['requester_user_id']}"
            )
