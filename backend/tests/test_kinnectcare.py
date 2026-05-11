"""KinnectCare backend API tests"""
import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://family-guard-37.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"


@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def new_user(session):
    email = f"tester+{uuid.uuid4().hex[:8]}@kinnectcare.app"
    payload = {"email": email, "password": "password123", "full_name": "Test User"}
    r = session.post(f"{API}/auth/signup", json=payload, timeout=30)
    assert r.status_code == 200, r.text
    data = r.json()
    assert "access_token" in data and "user" in data
    return {"email": email, "password": "password123", "token": data["access_token"], "user": data["user"]}


@pytest.fixture(scope="module")
def auth_headers(new_user):
    return {"Authorization": f"Bearer {new_user['token']}", "Content-Type": "application/json"}


# Auth
class TestAuth:
    def test_signup_seeds_data(self, session, new_user):
        h = {"Authorization": f"Bearer {new_user['token']}"}
        members = session.get(f"{API}/members", headers=h, timeout=30).json()
        names = sorted([m["name"] for m in members])
        assert "Gregory" in names and "James" in names
        rems = session.get(f"{API}/reminders", headers=h, timeout=30).json()
        assert len(rems) >= 3
        alerts = session.get(f"{API}/alerts", headers=h, timeout=30).json()
        assert len(alerts) >= 3

    def test_login_success(self, session, new_user):
        r = session.post(f"{API}/auth/login", json={"email": new_user["email"], "password": new_user["password"]}, timeout=30)
        assert r.status_code == 200
        assert "access_token" in r.json()

    def test_login_invalid(self, session, new_user):
        r = session.post(f"{API}/auth/login", json={"email": new_user["email"], "password": "wrongpass"}, timeout=30)
        assert r.status_code == 401

    def test_me(self, session, auth_headers, new_user):
        r = session.get(f"{API}/auth/me", headers=auth_headers, timeout=30)
        assert r.status_code == 200
        assert r.json()["email"] == new_user["email"]

    def test_me_unauthorized(self, session):
        r = session.get(f"{API}/auth/me", timeout=30)
        assert r.status_code in (401, 403)

    def test_signup_duplicate(self, session, new_user):
        r = session.post(f"{API}/auth/signup", json={"email": new_user["email"], "password": "password123", "full_name": "Dup"}, timeout=30)
        assert r.status_code == 409


# Members
class TestMembers:
    def test_create_member_and_persist(self, session, auth_headers):
        payload = {"name": "TEST_Alice", "age": 30, "phone": "+1-555-0000", "gender": "Female", "role": "family"}
        r = session.post(f"{API}/members", json=payload, headers=auth_headers, timeout=30)
        assert r.status_code == 200, r.text
        mid = r.json()["id"]
        g = session.get(f"{API}/members/{mid}", headers=auth_headers, timeout=30)
        assert g.status_code == 200
        assert g.json()["name"] == "TEST_Alice"

    def test_update_location(self, session, auth_headers):
        members = session.get(f"{API}/members", headers=auth_headers, timeout=30).json()
        mid = members[0]["id"]
        r = session.put(f"{API}/members/{mid}/location",
                        json={"latitude": 37.77, "longitude": -122.42, "location_name": "SF"},
                        headers=auth_headers, timeout=30)
        assert r.status_code == 200
        body = r.json()
        assert body["latitude"] == 37.77 and body["location_name"] == "SF"

    def test_delete_member(self, session, auth_headers):
        payload = {"name": "TEST_Del", "age": 40, "phone": "+1-555-9999", "gender": "Male", "role": "family"}
        mid = session.post(f"{API}/members", json=payload, headers=auth_headers, timeout=30).json()["id"]
        d = session.delete(f"{API}/members/{mid}", headers=auth_headers, timeout=30)
        assert d.status_code == 200
        g = session.get(f"{API}/members/{mid}", headers=auth_headers, timeout=30)
        assert g.status_code == 404


# Alerts
class TestAlerts:
    def test_list_and_ack(self, session, auth_headers):
        alerts = session.get(f"{API}/alerts", headers=auth_headers, timeout=30).json()
        assert len(alerts) >= 1
        aid = alerts[0]["id"]
        r = session.post(f"{API}/alerts/{aid}/ack", headers=auth_headers, timeout=30)
        assert r.status_code == 200
        after = session.get(f"{API}/alerts", headers=auth_headers, timeout=30).json()
        acked = next((a for a in after if a["id"] == aid), None)
        assert acked and acked["acknowledged"] is True


# Reminders
class TestReminders:
    def test_list_and_member_filter_and_toggle(self, session, auth_headers):
        rems = session.get(f"{API}/reminders", headers=auth_headers, timeout=30).json()
        assert len(rems) >= 3
        member_id = rems[0]["member_id"]
        filtered = session.get(f"{API}/reminders/member/{member_id}", headers=auth_headers, timeout=30).json()
        assert all(r["member_id"] == member_id for r in filtered)
        rid = rems[0]["id"]
        prev = rems[0]["taken"]
        t = session.post(f"{API}/reminders/{rid}/toggle", headers=auth_headers, timeout=30).json()
        assert t["taken"] == (not prev)


# Check-ins
class TestCheckins:
    def test_checkin_sets_healthy(self, session, auth_headers):
        members = session.get(f"{API}/members", headers=auth_headers, timeout=30).json()
        # find James (warning)
        james = next((m for m in members if m["name"] == "James"), members[0])
        r = session.post(f"{API}/checkins",
                         json={"member_id": james["id"], "location_name": "Home"},
                         headers=auth_headers, timeout=30)
        assert r.status_code == 200
        m = session.get(f"{API}/members/{james['id']}", headers=auth_headers, timeout=30).json()
        assert m["status"] == "healthy"


# SOS
class TestSOS:
    def test_sos_creates_alert(self, session, auth_headers):
        before = len(session.get(f"{API}/alerts", headers=auth_headers, timeout=30).json())
        r = session.post(f"{API}/sos", json={}, headers=auth_headers, timeout=30)
        assert r.status_code == 200
        body = r.json()
        assert body["ok"] is True and body["emergency_number"] == "911"
        after = session.get(f"{API}/alerts", headers=auth_headers, timeout=30).json()
        assert len(after) == before + 1
        assert any(a["type"] == "sos" and a["severity"] == "critical" for a in after)
