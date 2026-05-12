"""Iter 3 feature tests: medication reminders, check-in system, daily routine,
SOS improvements, summary endpoint, lazy missed-checkin detection."""
import os
import time
import uuid
import pytest
import requests

BASE_URL = os.environ.get("EXPO_BACKEND_URL", "https://family-guard-37.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"


@pytest.fixture(scope="module")
def auth():
    """Fresh signup → returns (session, user, members dict by name, james_id)."""
    email = f"featuretest+{uuid.uuid4().hex[:8]}@kinnectcare.app"
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    r = s.post(f"{API}/auth/signup", json={
        "email": email, "password": "password123", "full_name": "Feature Tester"
    })
    assert r.status_code == 200, f"signup failed: {r.status_code} {r.text}"
    token = r.json()["access_token"]
    s.headers.update({"Authorization": f"Bearer {token}"})

    m = s.get(f"{API}/members").json()
    by_name = {x["name"]: x for x in m}
    assert "James" in by_name and "Gregory" in by_name
    return {"session": s, "email": email, "members": by_name, "james_id": by_name["James"]["id"],
            "gregory_id": by_name["Gregory"]["id"]}


# ============ Seed verification ============
class TestSignupSeed:
    def test_james_has_3_meds_and_4_routines(self, auth):
        s = auth["session"]
        rems = s.get(f"{API}/reminders/member/{auth['james_id']}").json()
        meds = [r for r in rems if r["category"] == "medication"]
        routs = [r for r in rems if r["category"] == "routine"]
        assert len(meds) == 3, f"expected 3 meds, got {len(meds)}"
        assert len(routs) == 4, f"expected 4 routines, got {len(routs)}"

    def test_james_has_default_checkin_time(self, auth):
        m = auth["members"]["James"]
        assert m["daily_checkin_time"] == "09:00"

    def test_gregory_no_checkin_time(self, auth):
        assert auth["members"]["Gregory"].get("daily_checkin_time") is None


# ============ Reminders CRUD ============
class TestReminders:
    def test_create_medication_reminder(self, auth):
        s = auth["session"]
        r = s.post(f"{API}/reminders", json={
            "member_id": auth["james_id"], "title": "TEST_Vitamin D",
            "category": "medication", "dosage": "500mg",
            "times": ["08:00", "20:00"],
        })
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["category"] == "medication"
        assert body["dosage"] == "500mg"
        assert body["times"] == ["08:00", "20:00"]
        assert body["status"] == "pending"
        auth["med_id"] = body["id"]

    def test_create_routine_reminder(self, auth):
        s = auth["session"]
        r = s.post(f"{API}/reminders", json={
            "member_id": auth["james_id"], "title": "TEST_Stretch",
            "category": "routine", "times": ["07:00"],
        })
        assert r.status_code == 200
        assert r.json()["category"] == "routine"
        auth["routine_id"] = r.json()["id"]

    def test_mark_taken_no_alert(self, auth):
        s = auth["session"]
        before = len(s.get(f"{API}/alerts").json())
        r = s.post(f"{API}/reminders/{auth['med_id']}/mark", json={"status": "taken"})
        assert r.status_code == 200
        assert r.json()["status"] == "taken"
        after = len(s.get(f"{API}/alerts").json())
        # taken should NOT create an alert; allow >= because lazy missed-checkin might add one
        # Check directly that no medication alert with the title was created
        alerts = s.get(f"{API}/alerts").json()
        med_alerts = [a for a in alerts if a["type"] == "medication" and "TEST_Vitamin D" in a["title"]]
        assert len(med_alerts) == 0, "taken should NOT create a medication alert"

    def test_mark_missed_creates_alert(self, auth):
        s = auth["session"]
        r = s.post(f"{API}/reminders/{auth['med_id']}/mark", json={"status": "missed"})
        assert r.status_code == 200
        assert r.json()["status"] == "missed"
        alerts = s.get(f"{API}/alerts").json()
        med_alerts = [a for a in alerts if a["type"] == "medication" and "TEST_Vitamin D" in a["title"]]
        assert len(med_alerts) >= 1, "missed should create a medication alert"

    def test_mark_missed_routine_creates_routine_alert(self, auth):
        s = auth["session"]
        r = s.post(f"{API}/reminders/{auth['routine_id']}/mark", json={"status": "missed"})
        assert r.status_code == 200
        alerts = s.get(f"{API}/alerts").json()
        rt_alerts = [a for a in alerts if a["type"] == "routine" and "TEST_Stretch" in a["title"]]
        assert len(rt_alerts) >= 1

    def test_delete_reminder(self, auth):
        s = auth["session"]
        # create one fresh to delete
        r = s.post(f"{API}/reminders", json={
            "member_id": auth["james_id"], "title": "TEST_ToDelete",
            "category": "medication", "times": ["10:00"],
        })
        rid = r.json()["id"]
        d = s.delete(f"{API}/reminders/{rid}")
        assert d.status_code == 200
        # verify gone
        rems = s.get(f"{API}/reminders/member/{auth['james_id']}").json()
        assert not any(x["id"] == rid for x in rems)


# ============ Check-in settings & system ============
class TestCheckinSystem:
    def test_update_checkin_time(self, auth):
        s = auth["session"]
        r = s.put(f"{API}/members/{auth['james_id']}/checkin-settings",
                  json={"daily_checkin_time": "09:00"})
        assert r.status_code == 200
        assert r.json()["daily_checkin_time"] == "09:00"

    def test_disable_checkin_with_null(self, auth):
        s = auth["session"]
        r = s.put(f"{API}/members/{auth['gregory_id']}/checkin-settings",
                  json={"daily_checkin_time": None})
        assert r.status_code == 200
        assert r.json().get("daily_checkin_time") is None

    def test_invalid_time_format_rejected(self, auth):
        s = auth["session"]
        r = s.put(f"{API}/members/{auth['james_id']}/checkin-settings",
                  json={"daily_checkin_time": "not-a-time"})
        assert r.status_code == 400

    def test_create_checkin_acks_missed_alerts(self, auth):
        s = auth["session"]
        # Set james time to 00:01 so we are past it → lazy missed-checkin will trigger
        s.put(f"{API}/members/{auth['james_id']}/checkin-settings",
              json={"daily_checkin_time": "00:01"})
        # Trigger detection
        alerts1 = s.get(f"{API}/alerts").json()
        missed = [a for a in alerts1 if a["type"] == "missed_checkin" and a["member_id"] == auth["james_id"]]
        assert len(missed) >= 1, "missed_checkin should have been created"
        # Dedupe: second GET should not create another
        alerts2 = s.get(f"{API}/alerts").json()
        missed2 = [a for a in alerts2 if a["type"] == "missed_checkin" and a["member_id"] == auth["james_id"]
                   and not a["acknowledged"]]
        assert len(missed2) == len(missed), "missed_checkin must be deduped per day"
        # Now check in → should ack missed alerts
        r = s.post(f"{API}/checkins", json={"member_id": auth["james_id"]})
        assert r.status_code == 200
        alerts3 = s.get(f"{API}/alerts").json()
        still_open = [a for a in alerts3 if a["type"] == "missed_checkin"
                      and a["member_id"] == auth["james_id"] and not a["acknowledged"]]
        assert len(still_open) == 0, "check-in should ack open missed_checkin alerts"


# ============ Summary ============
class TestSummary:
    def test_summary_structure(self, auth):
        s = auth["session"]
        r = s.get(f"{API}/summary")
        assert r.status_code == 200
        body = r.json()
        assert "members" in body
        assert len(body["members"]) >= 2
        for m in body["members"]:
            for k in ("member_id", "name", "role", "medication_total", "medication_taken",
                      "medication_missed", "routine_total", "routine_done",
                      "checked_in_today", "daily_checkin_time"):
                assert k in m, f"missing key {k} in summary member"

    def test_summary_reflects_checkin(self, auth):
        s = auth["session"]
        body = s.get(f"{API}/summary").json()
        james = next(m for m in body["members"] if m["member_id"] == auth["james_id"])
        # we checked in James in TestCheckinSystem
        assert james["checked_in_today"] is True


# ============ SOS ============
class TestSOS:
    def test_sos_with_coords(self, auth):
        s = auth["session"]
        r = s.post(f"{API}/sos", json={"latitude": 37.7749, "longitude": -122.4194})
        assert r.status_code == 200
        assert r.json().get("emergency_number") == "911"
        alerts = s.get(f"{API}/alerts").json()
        sos = [a for a in alerts if a["type"] == "sos"]
        assert len(sos) >= 1
        # check coords stored on alert
        last = sos[0]
        assert last["latitude"] == 37.7749
        assert last["longitude"] == -122.4194
        assert last["severity"] == "critical"
        # message should contain timestamp-ish string e.g. "HH:MM UTC"
        assert "UTC" in last["message"]
        # coord substring
        assert "37.7749" in last["message"]

    def test_sos_for_member(self, auth):
        s = auth["session"]
        r = s.post(f"{API}/sos", json={"member_id": auth["james_id"],
                                       "latitude": 40.0, "longitude": -75.0})
        assert r.status_code == 200
        alerts = s.get(f"{API}/alerts").json()
        sos_for_james = [a for a in alerts if a["type"] == "sos" and a["member_id"] == auth["james_id"]]
        assert len(sos_for_james) >= 1
        assert "James" in sos_for_james[0]["title"]
