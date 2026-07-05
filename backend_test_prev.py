"""
KinnectCare Backend API Tests
Focus: TimeSlot reminders (POST/PUT/GET), backward compat, validation, plus regression.
"""
import os
import sys
import uuid
import json
import random
import string
from pathlib import Path

import requests

# Resolve base URL from frontend env
FRONTEND_ENV = Path("/app/frontend/.env")
BASE = None
for line in FRONTEND_ENV.read_text().splitlines():
    if line.startswith("EXPO_PUBLIC_BACKEND_URL="):
        BASE = line.split("=", 1)[1].strip().strip('"')
        break
if not BASE:
    print("ERROR: EXPO_PUBLIC_BACKEND_URL not found in /app/frontend/.env")
    sys.exit(1)
API = BASE.rstrip("/") + "/api"
print(f"Using API base: {API}")

DEMO_EMAIL = "demo@kinnectcare.app"
DEMO_PASSWORD = "password123"

results = []  # (name, status, detail)


def record(name, ok, detail=""):
    results.append((name, ok, detail))
    icon = "✅" if ok else "❌"
    print(f"{icon} {name} - {detail}")


def post(path, json_body=None, token=None, expected=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    r = requests.post(API + path, json=json_body, headers=headers, timeout=30)
    return r


def get(path, token=None):
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return requests.get(API + path, headers=headers, timeout=30)


def put(path, json_body=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return requests.put(API + path, json=json_body, headers=headers, timeout=30)


def delete(path, token=None):
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return requests.delete(API + path, headers=headers, timeout=30)


# ==== Auth bootstrap ====

def test_login_demo():
    r = post("/auth/login", {"email": DEMO_EMAIL, "password": DEMO_PASSWORD})
    if r.status_code != 200:
        record("Login demo user", False, f"status={r.status_code} body={r.text[:200]}")
        return None
    data = r.json()
    if "access_token" not in data or "user" not in data:
        record("Login demo user", False, f"missing fields in response: {data}")
        return None
    record("Login demo user", True, f"user_id={data['user']['id']}")
    return data["access_token"]


def test_signup_new_user():
    rand = "".join(random.choices(string.ascii_lowercase + string.digits, k=8))
    email = f"qa.{rand}@kinnectqa.com"
    r = post("/auth/signup", {
        "email": email,
        "password": "ValidPass!123",
        "full_name": "QA Tester",
        "timezone": "America/New_York",
    })
    if r.status_code != 200:
        record("Signup new user", False, f"status={r.status_code} body={r.text[:200]}")
        return None
    data = r.json()
    if data.get("user", {}).get("email") != email:
        record("Signup new user", False, f"email mismatch: {data}")
        return None
    record("Signup new user", True, f"email={email}")
    return data["access_token"]


def test_me(token):
    r = get("/auth/me", token=token)
    if r.status_code != 200:
        record("GET /api/auth/me", False, f"status={r.status_code} body={r.text[:200]}")
        return
    data = r.json()
    if not data.get("id") or not data.get("email"):
        record("GET /api/auth/me", False, f"missing fields: {data}")
        return
    record("GET /api/auth/me", True, f"email={data['email']}")


def test_timezone_update(token):
    r = put("/auth/timezone", {"timezone": "America/Los_Angeles"}, token=token)
    if r.status_code != 200:
        record("PUT /api/auth/timezone", False, f"status={r.status_code} body={r.text[:200]}")
        return
    if r.json().get("timezone") != "America/Los_Angeles":
        record("PUT /api/auth/timezone", False, f"tz not persisted: {r.json()}")
        return
    record("PUT /api/auth/timezone", True, "set to America/Los_Angeles")
    # restore
    put("/auth/timezone", {"timezone": "UTC"}, token=token)


def test_push_token(token):
    # invalid token format -> 200 but ok=False
    r1 = post("/auth/push-token", {"token": "not-a-valid-token"}, token=token)
    cond1 = r1.status_code == 200 and r1.json().get("ok") is False
    # valid prefix
    valid = f"ExponentPushToken[{uuid.uuid4()}]"
    r2 = post("/auth/push-token", {"token": valid}, token=token)
    cond2 = r2.status_code == 200 and r2.json().get("ok") is True
    if cond1 and cond2:
        record("POST /api/auth/push-token (invalid + valid)", True, "invalid silently ignored, valid accepted")
    else:
        record("POST /api/auth/push-token (invalid + valid)", False,
               f"invalid: {r1.status_code} {r1.text[:120]} | valid: {r2.status_code} {r2.text[:120]}")


# ==== Members ====

def test_members(token):
    r = get("/members", token=token)
    if r.status_code != 200:
        record("GET /api/members", False, f"status={r.status_code} body={r.text[:200]}")
        return None
    members = r.json()
    if not isinstance(members, list) or len(members) == 0:
        record("GET /api/members", False, f"empty/invalid list: {members}")
        return None
    record("GET /api/members", True, f"count={len(members)}")
    first_id = members[0]["id"]

    # POST create member
    new_payload = {"name": "Grace Park", "age": 72, "phone": "+1-555-0199", "gender": "Female", "role": "senior"}
    rc = post("/members", new_payload, token=token)
    if rc.status_code == 200 and rc.json().get("name") == "Grace Park":
        record("POST /api/members", True, f"created id={rc.json()['id']}")
        created_id = rc.json()["id"]
    else:
        record("POST /api/members", False, f"status={rc.status_code} body={rc.text[:200]}")
        created_id = None

    # GET /members/{id}
    rg = get(f"/members/{first_id}", token=token)
    if rg.status_code == 200 and rg.json()["id"] == first_id:
        record("GET /api/members/{id}", True, f"name={rg.json()['name']}")
    else:
        record("GET /api/members/{id}", False, f"status={rg.status_code} body={rg.text[:200]}")
    return first_id, created_id


# ==== Reminders new shape ====

def test_create_reminder_new_shape(token, member_id):
    body = {
        "member_id": member_id,
        "category": "medication",
        "title": "Test Vitamin",
        "dosage": "1 tab",
        "times": [{"time": "07:30", "label": "Morning"}, {"time": "21:00"}],
    }
    r = post("/reminders", body, token=token)
    if r.status_code != 200:
        record("POST /api/reminders (new TimeSlot shape)", False, f"status={r.status_code} body={r.text[:300]}")
        return None
    data = r.json()
    times = data.get("times", [])
    ok = (
        data.get("id")
        and isinstance(times, list)
        and len(times) == 2
        and all(isinstance(t, dict) and "time" in t for t in times)
        and times[0]["time"] == "07:30"
        and times[0].get("label") == "Morning"
        and times[1]["time"] == "21:00"
    )
    if ok:
        record("POST /api/reminders (new TimeSlot shape)", True, f"id={data['id']} times={times}")
        return data["id"]
    else:
        record("POST /api/reminders (new TimeSlot shape)", False, f"response={data}")
        return None


def test_create_reminder_legacy_shape(token, member_id):
    body = {
        "member_id": member_id,
        "category": "medication",
        "title": "Legacy Calcium",
        "dosage": "500mg",
        "times": ["08:00", "20:00"],
    }
    r = post("/reminders", body, token=token)
    if r.status_code != 200:
        record("POST /api/reminders (legacy list[str] coercion)", False, f"status={r.status_code} body={r.text[:300]}")
        return None
    data = r.json()
    times = data.get("times", [])
    ok = (
        len(times) == 2
        and isinstance(times[0], dict)
        and times[0].get("time") == "08:00"
        and times[1].get("time") == "20:00"
        and times[0].get("label") in (None, "")
    )
    if ok:
        record("POST /api/reminders (legacy list[str] coercion)", True, f"times={times}")
        return data["id"]
    else:
        record("POST /api/reminders (legacy list[str] coercion)", False, f"response={data}")
        return None


def test_create_reminder_invalid_time(token, member_id):
    body = {
        "member_id": member_id,
        "category": "medication",
        "title": "Bad Time Med",
        "times": [{"time": "25:99"}],
    }
    r = post("/reminders", body, token=token)
    if r.status_code == 400:
        record("POST /api/reminders (invalid time '25:99' -> 400)", True, f"detail={r.json().get('detail')}")
    else:
        record("POST /api/reminders (invalid time '25:99' -> 400)", False,
               f"expected 400 got {r.status_code} body={r.text[:200]}")


def test_put_reminder(token, reminder_id):
    # Happy path
    body = {"title": "Test Vitamin (updated)", "dosage": "2 tabs", "times": [{"time": "06:00", "label": "Dawn"}]}
    r = put(f"/reminders/{reminder_id}", body, token=token)
    if r.status_code != 200:
        record("PUT /api/reminders/{id} (update)", False, f"status={r.status_code} body={r.text[:300]}")
        return
    data = r.json()
    times = data.get("times", [])
    ok = (
        data.get("title") == "Test Vitamin (updated)"
        and data.get("dosage") == "2 tabs"
        and len(times) == 1
        and times[0]["time"] == "06:00"
        and times[0].get("label") == "Dawn"
    )
    if ok:
        record("PUT /api/reminders/{id} (update)", True, f"title={data['title']}, times={times}")
    else:
        record("PUT /api/reminders/{id} (update)", False, f"response={data}")
        return

    # Verify GET reflects change
    r2 = get(f"/reminders/member/{data['member_id']}", token=token)
    if r2.status_code == 200:
        match = next((x for x in r2.json() if x["id"] == reminder_id), None)
        if match and match["title"] == "Test Vitamin (updated)" and match["times"][0]["time"] == "06:00":
            record("PUT update reflected in GET /reminders/member/{id}", True, "updated record returned")
        else:
            record("PUT update reflected in GET /reminders/member/{id}", False, f"not reflected: {match}")
    else:
        record("PUT update reflected in GET /reminders/member/{id}", False, f"status={r2.status_code}")


def test_put_reminder_invalid_time(token, reminder_id):
    body = {"times": [{"time": "9999"}]}
    r = put(f"/reminders/{reminder_id}", body, token=token)
    if r.status_code == 400:
        record("PUT /api/reminders/{id} (invalid time '9999' -> 400)", True, f"detail={r.json().get('detail')}")
    else:
        record("PUT /api/reminders/{id} (invalid time '9999' -> 400)", False,
               f"expected 400 got {r.status_code} body={r.text[:200]}")


def test_put_reminder_not_found(token):
    r = put(f"/reminders/{uuid.uuid4()}", {"title": "x"}, token=token)
    if r.status_code == 404:
        record("PUT /api/reminders/{id} (non-existent -> 404)", True, "")
    else:
        record("PUT /api/reminders/{id} (non-existent -> 404)", False,
               f"expected 404 got {r.status_code} body={r.text[:200]}")


def test_put_reminder_unauthorized(reminder_id):
    r = requests.put(f"{API}/reminders/{reminder_id}", json={"title": "x"}, timeout=30)
    if r.status_code in (401, 403):
        record("PUT /api/reminders/{id} without token -> 401/403", True, f"status={r.status_code}")
    else:
        record("PUT /api/reminders/{id} without token -> 401/403", False,
               f"expected 401/403 got {r.status_code} body={r.text[:200]}")


def test_get_reminders_by_member(token, member_id):
    r = get(f"/reminders/member/{member_id}", token=token)
    if r.status_code != 200:
        record("GET /api/reminders/member/{id}", False, f"status={r.status_code} body={r.text[:200]}")
        return
    items = r.json()
    if not isinstance(items, list) or len(items) == 0:
        record("GET /api/reminders/member/{id}", False, f"empty/invalid: {items}")
        return
    # Every reminder's times must be list of dicts
    bad = [it for it in items if not isinstance(it.get("times"), list) or any(not isinstance(t, dict) or "time" not in t for t in it["times"])]
    if bad:
        record("GET /api/reminders/member/{id} (times as list of objects)", False, f"bad items: {bad[:1]}")
    else:
        record("GET /api/reminders/member/{id} (times as list of objects)", True,
               f"count={len(items)}, sample times={items[0]['times']}")


def test_mark_toggle_delete(token, reminder_id_taken, reminder_id_missed, reminder_id_to_delete):
    # mark taken
    r = post(f"/reminders/{reminder_id_taken}/mark", {"status": "taken"}, token=token)
    ok1 = r.status_code == 200 and r.json().get("status") == "taken"
    # mark missed
    r2 = post(f"/reminders/{reminder_id_missed}/mark", {"status": "missed"}, token=token)
    ok2 = r2.status_code == 200 and r2.json().get("status") == "missed"
    if ok1 and ok2:
        record("POST /api/reminders/{id}/mark (taken & missed)", True, "both marks accepted")
    else:
        record("POST /api/reminders/{id}/mark (taken & missed)", False,
               f"taken: {r.status_code} {r.text[:120]} | missed: {r2.status_code} {r2.text[:120]}")

    # toggle
    rt = post(f"/reminders/{reminder_id_taken}/toggle", token=token)
    if rt.status_code == 200 and "taken" in rt.json():
        record("POST /api/reminders/{id}/toggle", True, f"taken={rt.json()['taken']}")
    else:
        record("POST /api/reminders/{id}/toggle", False, f"status={rt.status_code} body={rt.text[:200]}")

    # delete
    rd = delete(f"/reminders/{reminder_id_to_delete}", token=token)
    if rd.status_code == 200 and rd.json().get("ok") is True:
        record("DELETE /api/reminders/{id}", True, "")
    else:
        record("DELETE /api/reminders/{id}", False, f"status={rd.status_code} body={rd.text[:200]}")


# ==== Summary, SOS, alerts, check-ins, history ====

def test_summary(token):
    r = get("/summary", token=token)
    if r.status_code == 200 and "members" in r.json():
        record("GET /api/summary", True, f"members={len(r.json()['members'])}")
    else:
        record("GET /api/summary", False, f"status={r.status_code} body={r.text[:200]}")


def test_sos_and_alerts(token):
    body = {"latitude": 40.7128, "longitude": -74.0060}
    r = post("/sos", body, token=token)
    if r.status_code != 200 or not r.json().get("alert_id"):
        record("POST /api/sos", False, f"status={r.status_code} body={r.text[:200]}")
        return
    alert_id = r.json()["alert_id"]
    record("POST /api/sos", True, f"alert_id={alert_id}")

    r2 = get("/alerts", token=token)
    if r2.status_code != 200:
        record("GET /api/alerts (includes SOS)", False, f"status={r2.status_code} body={r2.text[:200]}")
        return
    alerts = r2.json()
    if any(a["id"] == alert_id for a in alerts):
        record("GET /api/alerts (includes SOS)", True, f"total alerts={len(alerts)}")
    else:
        record("GET /api/alerts (includes SOS)", False, "new SOS alert not found in list")


def test_checkins(token, member_id):
    r = post("/checkins", {"member_id": member_id, "location_name": "Home", "latitude": 40.7, "longitude": -74.0}, token=token)
    if r.status_code == 200 and r.json().get("member_id") == member_id:
        record("POST /api/checkins", True, f"id={r.json()['id']}")
    else:
        record("POST /api/checkins", False, f"status={r.status_code} body={r.text[:200]}")
        return
    r2 = get(f"/checkins/member/{member_id}", token=token)
    if r2.status_code == 200 and isinstance(r2.json(), list):
        record("GET /api/checkins/member/{id}", True, f"count={len(r2.json())}")
    else:
        record("GET /api/checkins/member/{id}", False, f"status={r2.status_code} body={r2.text[:200]}")
    r3 = get("/checkins/recent", token=token)
    if r3.status_code == 200 and isinstance(r3.json(), list):
        record("GET /api/checkins/recent", True, f"count={len(r3.json())}")
    else:
        record("GET /api/checkins/recent", False, f"status={r3.status_code} body={r3.text[:200]}")


def test_history(token, member_id):
    r = get(f"/history/member/{member_id}?days=7", token=token)
    if r.status_code != 200:
        record("GET /api/history/member/{id}?days=7", False, f"status={r.status_code} body={r.text[:200]}")
        return
    data = r.json()
    ok = (
        data.get("member_id") == member_id
        and isinstance(data.get("series"), list)
        and len(data["series"]) == 7
        and "compliance_percent" in data
    )
    if ok:
        record("GET /api/history/member/{id}?days=7", True,
               f"compliance={data['compliance_percent']}%, totals={data['totals']}")
    else:
        record("GET /api/history/member/{id}?days=7", False, f"response={data}")


def main():
    print("\n=== AUTH ===")
    signup_token = test_signup_new_user()
    token = test_login_demo()
    if not token:
        print("Cannot continue without demo token.")
        sys.exit(1)
    test_me(token)
    test_timezone_update(token)
    test_push_token(token)

    print("\n=== MEMBERS ===")
    members_ret = test_members(token)
    if not members_ret:
        print("Cannot continue without member id.")
        sys.exit(1)
    first_id, created_id = members_ret
    member_id = first_id

    print("\n=== REMINDERS (new TimeSlot) ===")
    rem_id = test_create_reminder_new_shape(token, member_id)
    legacy_rem_id = test_create_reminder_legacy_shape(token, member_id)
    test_create_reminder_invalid_time(token, member_id)

    if rem_id:
        test_put_reminder(token, rem_id)
        test_put_reminder_invalid_time(token, rem_id)
        test_put_reminder_unauthorized(rem_id)
    test_put_reminder_not_found(token)

    test_get_reminders_by_member(token, member_id)

    # mark/toggle/delete using two reminders we created
    extra_for_delete = test_create_reminder_new_shape(token, member_id)
    if rem_id and legacy_rem_id and extra_for_delete:
        test_mark_toggle_delete(token, rem_id, legacy_rem_id, extra_for_delete)

    print("\n=== SUMMARY / SOS / ALERTS / CHECKINS / HISTORY ===")
    test_summary(token)
    test_sos_and_alerts(token)
    test_checkins(token, member_id)
    test_history(token, member_id)

    print("\n=== RESULTS ===")
    passed = sum(1 for _, ok, _ in results if ok)
    failed = sum(1 for _, ok, _ in results if not ok)
    print(f"Passed: {passed} | Failed: {failed} | Total: {len(results)}")
    for name, ok, detail in results:
        print(f"  {'PASS' if ok else 'FAIL'}: {name} :: {detail}")

    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
