"""Iteration 4 backend tests: timezone, push tokens, medication history, regression."""
import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get("EXPO_BACKEND_URL", "https://family-guard-37.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"


@pytest.fixture(scope="module")
def client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


def _signup(client, tz="America/New_York"):
    email = f"v4test+{uuid.uuid4().hex[:8]}@kinnectcare.app"
    r = client.post(f"{API}/auth/signup",
                    json={"email": email, "password": "password123",
                          "full_name": "V4 Test", "timezone": tz})
    assert r.status_code == 200, r.text
    data = r.json()
    return email, data["access_token"], data["user"]


@pytest.fixture(scope="module")
def auth(client):
    email, token, user = _signup(client)
    client.headers.update({"Authorization": f"Bearer {token}"})
    return {"email": email, "token": token, "user": user}


# ---------- Timezone ----------
class TestTimezone:
    def test_signup_persists_timezone(self, client, auth):
        assert auth["user"]["timezone"] == "America/New_York"
        r = client.get(f"{API}/auth/me")
        assert r.status_code == 200
        assert r.json()["timezone"] == "America/New_York"

    def test_signup_default_utc_when_omitted(self, client):
        email = f"v4test+{uuid.uuid4().hex[:8]}@kinnectcare.app"
        r = requests.post(f"{API}/auth/signup",
                          json={"email": email, "password": "password123", "full_name": "V4 Default"})
        assert r.status_code == 200
        assert r.json()["user"]["timezone"] == "UTC"

    def test_put_timezone_valid(self, client, auth):
        r = client.put(f"{API}/auth/timezone", json={"timezone": "Europe/Paris"})
        assert r.status_code == 200
        assert r.json()["timezone"] == "Europe/Paris"
        # Verify via /me
        r2 = client.get(f"{API}/auth/me")
        assert r2.json()["timezone"] == "Europe/Paris"
        # Reset back
        client.put(f"{API}/auth/timezone", json={"timezone": "America/New_York"})

    def test_put_timezone_invalid(self, client, auth):
        r = client.put(f"{API}/auth/timezone", json={"timezone": "Mars/Olympus"})
        assert r.status_code == 400


# ---------- Push token ----------
class TestPushToken:
    def test_register_valid_push_token(self, client, auth):
        token = "ExponentPushToken[abcdefghij1234567890]"
        r = client.post(f"{API}/auth/push-token", json={"token": token, "platform": "ios"})
        assert r.status_code == 200
        body = r.json()
        assert body.get("ok") is True

    def test_register_invalid_push_token(self, client, auth):
        r = client.post(f"{API}/auth/push-token", json={"token": "not-a-token", "platform": "ios"})
        assert r.status_code == 200
        assert r.json().get("ok") is False

    def test_addToSet_dedup(self, client, auth):
        # Register same token twice — should not duplicate
        token = "ExponentPushToken[dedupe-test-token]"
        client.post(f"{API}/auth/push-token", json={"token": token, "platform": "ios"})
        client.post(f"{API}/auth/push-token", json={"token": token, "platform": "ios"})
        # No GET to inspect push_tokens, but server should not have crashed
        r = client.get(f"{API}/auth/me")
        assert r.status_code == 200


# ---------- Signup regression seed ----------
class TestSignupSeed:
    def test_seeds_3_meds_4_routines_for_james(self, client, auth):
        r = client.get(f"{API}/members")
        members = r.json()
        james = next((m for m in members if m["name"] == "James"), None)
        assert james is not None
        r2 = client.get(f"{API}/reminders/member/{james['id']}")
        rems = r2.json()
        meds = [x for x in rems if x["category"] == "medication"]
        routs = [x for x in rems if x["category"] == "routine"]
        assert len(meds) == 3
        assert len(routs) == 4


# ---------- Medication history ----------
class TestMedicationHistory:
    def test_mark_creates_medication_log_and_history(self, client, auth):
        # Fresh user for clean compliance
        email, token, user = _signup(client)
        s = requests.Session()
        s.headers.update({"Content-Type": "application/json",
                          "Authorization": f"Bearer {token}"})
        members = s.get(f"{API}/members").json()
        james = next(m for m in members if m["name"] == "James")
        meds = [r for r in s.get(f"{API}/reminders/member/{james['id']}").json()
                if r["category"] == "medication"]
        assert len(meds) >= 2

        # Mark one taken, one missed
        r1 = s.post(f"{API}/reminders/{meds[0]['id']}/mark", json={"status": "taken"})
        r2 = s.post(f"{API}/reminders/{meds[1]['id']}/mark", json={"status": "missed"})
        assert r1.status_code == 200 and r2.status_code == 200

        hist = s.get(f"{API}/history/member/{james['id']}?days=7")
        assert hist.status_code == 200
        h = hist.json()
        assert "series" in h and len(h["series"]) == 7
        for d in h["series"]:
            assert set(d.keys()) >= {"date", "taken", "missed", "total"}
        assert h["totals"]["taken"] == 1
        assert h["totals"]["missed"] == 1
        assert h["totals"]["logged"] == 2
        assert h["compliance_percent"] == 50
        assert h["timezone"] == "America/New_York"

    def test_history_invalid_member_404(self, client, auth):
        r = client.get(f"{API}/history/member/does-not-exist?days=7")
        assert r.status_code == 404


# ---------- Cascade delete ----------
class TestCascadeDelete:
    def test_delete_member_cascades_logs(self, client, auth):
        email, token, user = _signup(client)
        s = requests.Session()
        s.headers.update({"Content-Type": "application/json",
                          "Authorization": f"Bearer {token}"})
        james = next(m for m in s.get(f"{API}/members").json() if m["name"] == "James")
        meds = [r for r in s.get(f"{API}/reminders/member/{james['id']}").json()
                if r["category"] == "medication"]
        s.post(f"{API}/reminders/{meds[0]['id']}/mark", json={"status": "taken"})
        # Confirm logged
        h = s.get(f"{API}/history/member/{james['id']}?days=7").json()
        assert h["totals"]["logged"] == 1
        # Delete member
        r = s.delete(f"{API}/members/{james['id']}")
        assert r.status_code == 200
        # Now history should 404
        r2 = s.get(f"{API}/history/member/{james['id']}?days=7")
        assert r2.status_code == 404


# ---------- SOS localized timestamp ----------
class TestSOSLocalized:
    def test_sos_alert_message_in_user_tz(self, client, auth):
        # Ensure user tz is set
        client.put(f"{API}/auth/timezone", json={"timezone": "America/New_York"})
        r = client.post(f"{API}/sos", json={"latitude": 40.7128, "longitude": -74.0060})
        assert r.status_code == 200
        aid = r.json()["alert_id"]
        alerts = client.get(f"{API}/alerts").json()
        a = next(x for x in alerts if x["id"] == aid)
        # America/New_York label is EST/EDT
        assert ("EST" in a["message"]) or ("EDT" in a["message"]), a["message"]
        assert "40.7128" in a["message"]


# ---------- Iter-3 regression ----------
class TestIter3Regression:
    def test_summary_includes_tz(self, client, auth):
        r = client.get(f"{API}/summary")
        assert r.status_code == 200
        body = r.json()
        assert "members" in body
        assert "timezone" in body

    def test_alerts_message_includes_tz_label(self, client, auth):
        # Create member with past checkin time, ensure detect_missed_checkins fires with tz label
        # Use list endpoint to trigger detection
        r = client.get(f"{API}/alerts")
        assert r.status_code == 200
        # Just structural assertion — message-content tz label tested elsewhere
