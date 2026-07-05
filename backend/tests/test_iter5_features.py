"""Iteration 5 backend tests: weekly compliance % per member in /api/summary."""
import os
import uuid
import time
import requests
import pytest

BASE_URL = "https://family-guard-37.preview.emergentagent.com"
API = f"{BASE_URL}/api"


def _signup():
    email = f"v5test+{uuid.uuid4().hex[:10]}@kinnship.app"
    r = requests.post(f"{API}/auth/signup", json={
        "email": email, "password": "password123",
        "full_name": "Iter5 Tester", "timezone": "America/New_York",
    }, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()["access_token"], r.json()["user"]


@pytest.fixture(scope="module")
def auth():
    token, user = _signup()
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}, user


def _james_id(auth_headers):
    r = requests.get(f"{API}/members", headers=auth_headers, timeout=20)
    assert r.status_code == 200
    for m in r.json():
        if m["name"] == "James" and m["role"] == "senior":
            return m["id"]
    raise AssertionError("Seeded senior James missing")


def _med_reminder_ids(auth_headers, member_id):
    r = requests.get(f"{API}/reminders/member/{member_id}", headers=auth_headers, timeout=20)
    assert r.status_code == 200
    return [x["id"] for x in r.json() if x["category"] == "medication"]


# --- Weekly compliance --- #
class TestWeeklyCompliance:
    def test_initial_compliance_null(self, auth):
        headers, _ = auth
        r = requests.get(f"{API}/summary", headers=headers, timeout=20)
        assert r.status_code == 200
        data = r.json()
        members = data.get("members", [])
        assert len(members) >= 1
        # No marks yet => weekly_compliance_percent should be None and weekly_logged 0
        for m in members:
            assert "weekly_compliance_percent" in m
            assert "weekly_logged" in m
            assert m["weekly_compliance_percent"] is None
            assert m["weekly_logged"] == 0

    def test_one_taken_yields_100(self, auth):
        headers, _ = auth
        jid = _james_id(headers)
        meds = _med_reminder_ids(headers, jid)
        assert len(meds) >= 2
        # Mark 1 taken
        r = requests.post(f"{API}/reminders/{meds[0]}/mark",
                          headers=headers, json={"status": "taken"}, timeout=20)
        assert r.status_code == 200
        time.sleep(0.5)
        s = requests.get(f"{API}/summary", headers=headers, timeout=20).json()
        james = next(m for m in s["members"] if m["member_id"] == jid)
        assert james["weekly_compliance_percent"] == 100
        assert james["weekly_logged"] == 1

    def test_then_one_missed_yields_50(self, auth):
        headers, _ = auth
        jid = _james_id(headers)
        meds = _med_reminder_ids(headers, jid)
        r = requests.post(f"{API}/reminders/{meds[1]}/mark",
                          headers=headers, json={"status": "missed"}, timeout=20)
        assert r.status_code == 200
        time.sleep(0.5)
        s = requests.get(f"{API}/summary", headers=headers, timeout=20).json()
        james = next(m for m in s["members"] if m["member_id"] == jid)
        assert james["weekly_compliance_percent"] == 50
        assert james["weekly_logged"] == 2

    def test_routine_marks_do_not_affect_compliance(self, auth):
        headers, _ = auth
        jid = _james_id(headers)
        # Get a routine reminder
        all_r = requests.get(f"{API}/reminders/member/{jid}", headers=headers, timeout=20).json()
        routines = [x for x in all_r if x["category"] == "routine"]
        assert routines
        r = requests.post(f"{API}/reminders/{routines[0]['id']}/mark",
                          headers=headers, json={"status": "taken"}, timeout=20)
        assert r.status_code == 200
        s = requests.get(f"{API}/summary", headers=headers, timeout=20).json()
        james = next(m for m in s["members"] if m["member_id"] == jid)
        # unchanged: still 50% and weekly_logged still 2
        assert james["weekly_logged"] == 2
        assert james["weekly_compliance_percent"] == 50


# --- Iter4 regressions --- #
class TestIter4Regression:
    def test_signup_timezone_accepts(self):
        email = f"v5tz+{uuid.uuid4().hex[:8]}@kinnship.app"
        r = requests.post(f"{API}/auth/signup", json={
            "email": email, "password": "password123",
            "full_name": "TZ Reg", "timezone": "America/Los_Angeles",
        }, timeout=20)
        assert r.status_code == 200
        assert r.json()["user"]["timezone"] == "America/Los_Angeles"

    def test_put_timezone_invalid_rejected(self, auth):
        headers, _ = auth
        r = requests.put(f"{API}/auth/timezone", headers=headers,
                         json={"timezone": "Mars/Olympus"}, timeout=20)
        assert r.status_code == 400

    def test_put_timezone_valid(self, auth):
        headers, _ = auth
        r = requests.put(f"{API}/auth/timezone", headers=headers,
                         json={"timezone": "Europe/London"}, timeout=20)
        assert r.status_code == 200
        assert r.json()["timezone"] == "Europe/London"
        # restore for later tests
        requests.put(f"{API}/auth/timezone", headers=headers,
                     json={"timezone": "America/New_York"}, timeout=20)

    def test_push_token_invalid_format(self, auth):
        headers, _ = auth
        r = requests.post(f"{API}/auth/push-token", headers=headers,
                          json={"token": "not-a-token"}, timeout=20)
        assert r.status_code == 200
        assert r.json()["ok"] is False

    def test_push_token_valid_format(self, auth):
        headers, _ = auth
        r = requests.post(f"{API}/auth/push-token", headers=headers,
                          json={"token": "ExponentPushToken[xxxxAAAA]", "platform": "ios"}, timeout=20)
        assert r.status_code == 200
        assert r.json()["ok"] is True

    def test_history_endpoint(self, auth):
        headers, _ = auth
        jid = _james_id(headers)
        r = requests.get(f"{API}/history/member/{jid}?days=7", headers=headers, timeout=20)
        assert r.status_code == 200
        data = r.json()
        assert len(data["series"]) == 7
        assert "compliance_percent" in data
        assert data["totals"]["logged"] >= 2  # from earlier marks

    def test_sos_with_coords(self, auth):
        headers, _ = auth
        r = requests.post(f"{API}/sos", headers=headers,
                          json={"latitude": 40.7128, "longitude": -74.0060}, timeout=20)
        assert r.status_code == 200
        body = r.json()
        assert body["ok"] is True
        assert body["emergency_number"] == "911"
        assert body["alert_id"]
        # Verify alert created with coords
        alerts = requests.get(f"{API}/alerts", headers=headers, timeout=20).json()
        sos_alert = next((a for a in alerts if a["id"] == body["alert_id"]), None)
        assert sos_alert is not None
        assert sos_alert["latitude"] == 40.7128
        assert sos_alert["longitude"] == -74.0060
        assert "40.7128" in sos_alert["message"]

    def test_mark_missed_generates_alert(self, auth):
        headers, _ = auth
        jid = _james_id(headers)
        meds = _med_reminder_ids(headers, jid)
        # mark a new med missed
        r = requests.post(f"{API}/reminders/{meds[2]}/mark",
                          headers=headers, json={"status": "missed"}, timeout=20)
        assert r.status_code == 200
        time.sleep(0.5)
        alerts = requests.get(f"{API}/alerts", headers=headers, timeout=20).json()
        med_alerts = [a for a in alerts if a["type"] == "medication" and "missed" in a["title"].lower()]
        assert len(med_alerts) >= 1


# --- Iter3 basic regression --- #
class TestIter3Regression:
    def test_login_works(self):
        # Use freshly created user
        email = f"v5log+{uuid.uuid4().hex[:8]}@kinnship.app"
        requests.post(f"{API}/auth/signup", json={
            "email": email, "password": "password123",
            "full_name": "Login Test", "timezone": "UTC",
        }, timeout=20)
        r = requests.post(f"{API}/auth/login",
                          json={"email": email, "password": "password123"}, timeout=20)
        assert r.status_code == 200
        assert "access_token" in r.json()

    def test_create_member_and_reminder(self, auth):
        headers, _ = auth
        m = requests.post(f"{API}/members", headers=headers, json={
            "name": "TEST_Senior", "age": 72, "phone": "+1-555-1234",
            "gender": "Female", "role": "senior",
        }, timeout=20)
        assert m.status_code == 200
        mid = m.json()["id"]
        rem = requests.post(f"{API}/reminders", headers=headers, json={
            "member_id": mid, "title": "TEST_Med", "category": "medication",
            "dosage": "10mg", "times": ["09:00"],
        }, timeout=20)
        assert rem.status_code == 200
        # delete member to clean up (cascades)
        d = requests.delete(f"{API}/members/{mid}", headers=headers, timeout=20)
        assert d.status_code == 200

    def test_checkin_flow(self, auth):
        headers, _ = auth
        jid = _james_id(headers)
        r = requests.post(f"{API}/checkins", headers=headers, json={
            "member_id": jid, "location_name": "Home",
            "latitude": 40.7, "longitude": -74.0,
        }, timeout=20)
        assert r.status_code == 200
        s = requests.get(f"{API}/summary", headers=headers, timeout=20).json()
        james = next(m for m in s["members"] if m["member_id"] == jid)
        assert james["checked_in_today"] is True
