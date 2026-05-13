"""Backend tests for enhanced KinnectCare SOS push notification system + regression."""
import sys
import uuid
from datetime import datetime
import requests

BASE = "https://family-guard-37.preview.emergentagent.com/api"
DEMO_EMAIL = "demo@kinnectcare.app"
DEMO_PASS = "password123"

results = []
def record(name, passed, info=""):
    status = "PASS" if passed else "FAIL"
    results.append((name, passed, info))
    print(f"[{status}] {name}  {info}")

def post(path, **kwargs): return requests.post(f"{BASE}{path}", timeout=30, **kwargs)
def get(path, **kwargs):  return requests.get(f"{BASE}{path}", timeout=30, **kwargs)
def put(path, **kwargs):  return requests.put(f"{BASE}{path}", timeout=30, **kwargs)
def delete(path, **kwargs): return requests.delete(f"{BASE}{path}", timeout=30, **kwargs)

def _iso_ok(s):
    try: datetime.fromisoformat(s); return True
    except Exception: return False


def main():
    r = post("/auth/login", json={"email": DEMO_EMAIL, "password": DEMO_PASS})
    record("POST /auth/login (demo)", r.status_code == 200 and "access_token" in r.json(),
           f"status={r.status_code}")
    if r.status_code != 200:
        print(r.text); return False
    token = r.json()["access_token"]
    user = r.json()["user"]
    H = {"Authorization": f"Bearer {token}"}

    r = get("/auth/me", headers=H)
    record("GET /auth/me", r.status_code == 200 and r.json()["email"] == DEMO_EMAIL,
           f"status={r.status_code}")

    r = get("/members", headers=H)
    record("GET /members", r.status_code == 200 and isinstance(r.json(), list),
           f"count={len(r.json()) if r.status_code==200 else '?'}")
    members = r.json() if r.status_code == 200 else []
    seniors = [m for m in members if m.get("role") == "senior"]
    record("Has at least one senior member", len(seniors) >= 1, f"seniors={len(seniors)}")
    if not seniors: return False
    senior = seniors[0]

    # ---- 2a. SOS with senior + coords ----
    body = {"member_id": senior["id"], "latitude": 37.7749, "longitude": -122.4194}
    r = post("/sos", headers=H, json=body)
    ok = r.status_code == 200
    j = r.json() if ok else {}
    record("POST /sos with member_id + coords -> 200", ok, f"status={r.status_code}")
    alert_id_with_coords = None
    if ok:
        ts = j.get("timestamp")
        record("SOS.timestamp ISO parseable", _iso_ok(ts), f"ts={ts}")
        record("SOS.member_name == senior.name",
               j.get("member_name") == senior["name"],
               f"got={j.get('member_name')} expected={senior['name']}")
        coords = j.get("coordinates")
        record("SOS.coordinates == {latitude:37.7749, longitude:-122.4194}",
               coords == {"latitude": 37.7749, "longitude": -122.4194}, f"coords={coords}")
        record("SOS.devices_notified is int >=0",
               isinstance(j.get("devices_notified"), int) and j["devices_notified"] >= 0,
               f"devices_notified={j.get('devices_notified')}")
        record("SOS.alert_id present", bool(j.get("alert_id")), f"alert_id={j.get('alert_id')}")
        record("SOS.emergency_number == '911'", j.get("emergency_number") == "911",
               f"emergency_number={j.get('emergency_number')}")
        record("SOS.ok == True", j.get("ok") is True, "")
        alert_id_with_coords = j.get("alert_id")

    # ---- 2b. SOS empty body ----
    r = post("/sos", headers=H, json={})
    ok = r.status_code == 200
    j = r.json() if ok else {}
    record("POST /sos empty body -> 200", ok, f"status={r.status_code}")
    alert_id_no_coords = None
    if ok:
        record("SOS empty: member_name == user.full_name",
               j.get("member_name") == user["full_name"],
               f"got={j.get('member_name')} expected={user['full_name']}")
        record("SOS empty: coordinates == null", j.get("coordinates") is None,
               f"coordinates={j.get('coordinates')}")
        record("SOS empty: timestamp parseable", _iso_ok(j.get("timestamp")), f"ts={j.get('timestamp')}")
        alert_id_no_coords = j.get("alert_id")

    # ---- 2c. /alerts shows both ----
    r = get("/alerts", headers=H)
    if r.status_code == 200:
        alerts = r.json()
        sos_ids = {a["id"] for a in alerts if a.get("type") == "sos" and a.get("severity") == "critical"}
        found = (alert_id_with_coords in sos_ids) and (alert_id_no_coords in sos_ids)
        record("GET /alerts includes both new SOS (type=sos severity=critical)", found,
               f"with={alert_id_with_coords in sos_ids} no={alert_id_no_coords in sos_ids}")
    else:
        record("GET /alerts", False, f"status={r.status_code}")

    # ---- 2d. push token + SOS device count ----
    fake_tok = "ExponentPushToken[FAKE_TEST_TOKEN_KINNECT]"
    r = post("/auth/push-token", headers=H, json={"token": fake_tok, "platform": "ios"})
    record("POST /auth/push-token (fake expo) -> 200",
           r.status_code == 200 and r.json().get("ok") is True, f"status={r.status_code}")
    r = post("/sos", headers=H, json={"latitude": 12.97, "longitude": 77.59})
    if r.status_code == 200:
        dn = r.json().get("devices_notified")
        record("POST /sos after push-token: devices_notified >= 1",
               isinstance(dn, int) and dn >= 1, f"devices_notified={dn}")
    else:
        record("POST /sos after push-token", False, f"status={r.status_code}")

    # ===== REGRESSION =====
    rand_email = f"qa_{uuid.uuid4().hex[:10]}@kinnectcare.app"
    r = post("/auth/signup", json={"email": rand_email, "password": "Password123!",
                                   "full_name": "QA Tester", "timezone": "America/New_York"})
    record("POST /auth/signup (random email)",
           r.status_code == 200 and "access_token" in r.json(),
           f"status={r.status_code} email={rand_email}")
    new_token = r.json().get("access_token") if r.status_code == 200 else None
    NH = {"Authorization": f"Bearer {new_token}"} if new_token else {}
    if new_token:
        r = get("/auth/me", headers=NH)
        record("GET /auth/me (new user)",
               r.status_code == 200 and r.json().get("email") == rand_email, f"status={r.status_code}")

    r = get("/summary", headers=H)
    summary_ok = r.status_code == 200 and "members" in r.json()
    record("GET /summary (demo) -> 200 with members (no KeyError)", summary_ok,
           f"status={r.status_code}")
    if summary_ok:
        req = ["medication_total","medication_taken","medication_missed","routine_total","weekly_compliance_percent"]
        all_have = all(all(k in m for k in req) for m in r.json()["members"])
        record("/summary members have all required fields", all_have, "")

    # members CRUD
    r = post("/members", headers=H, json={"name": "Eleanor Vance", "age": 74,
                                          "phone": "+1-555-0188", "gender": "Female", "role": "senior"})
    new_member_id = r.json().get("id") if r.status_code == 200 else None
    record("POST /members (Eleanor)", r.status_code == 200 and bool(new_member_id),
           f"status={r.status_code}")
    if new_member_id:
        r = get(f"/members/{new_member_id}", headers=H)
        record("GET /members/{id}", r.status_code == 200 and r.json().get("id") == new_member_id,
               f"status={r.status_code}")

    # reminders flow
    if new_member_id:
        body = {"member_id": new_member_id, "title": "Atorvastatin", "category": "medication",
                "dosage": "20mg", "times": [{"time": "08:00", "label": "Morning"}, {"time": "20:00"}]}
        r = post("/reminders", headers=H, json=body)
        rid = r.json().get("id") if r.status_code == 200 else None
        record("POST /reminders (TimeSlot shape)", r.status_code == 200 and bool(rid),
               f"status={r.status_code}")
        if rid:
            r = put(f"/reminders/{rid}", headers=H,
                    json={"title": "Atorvastatin (edited)", "dosage": "40mg",
                          "times": [{"time": "07:30", "label": "Dawn"}]})
            record("PUT /reminders/{id}",
                   r.status_code == 200 and r.json().get("title") == "Atorvastatin (edited)",
                   f"status={r.status_code}")
            r = post(f"/reminders/{rid}/mark", headers=H, json={"status": "taken"})
            record("POST /reminders/{id}/mark taken", r.status_code == 200, f"status={r.status_code}")
            r = post(f"/reminders/{rid}/toggle", headers=H)
            record("POST /reminders/{id}/toggle", r.status_code == 200, f"status={r.status_code}")
            r = delete(f"/reminders/{rid}", headers=H)
            record("DELETE /reminders/{id}", r.status_code == 200, f"status={r.status_code}")

    # check-ins
    if new_member_id:
        r = post("/checkins", headers=H,
                 json={"member_id": new_member_id, "location_name": "Home",
                       "latitude": 40.7128, "longitude": -74.0060})
        record("POST /checkins", r.status_code == 200, f"status={r.status_code}")
    r = get("/checkins/recent", headers=H)
    record("GET /checkins/recent",
           r.status_code == 200 and isinstance(r.json(), list),
           f"status={r.status_code}")

    if new_member_id:
        r = get(f"/history/member/{new_member_id}?days=7", headers=H)
        ok = r.status_code == 200 and len(r.json().get("series", [])) == 7
        record("GET /history/member/{id}?days=7", ok, f"status={r.status_code}")

    print("\n" + "="*60)
    total = len(results); passed = sum(1 for _,p,_ in results if p)
    print(f"PASSED: {passed}/{total}")
    failures = [(n,i) for n,p,i in results if not p]
    if failures:
        print("\nFAILURES:")
        for n,i in failures:
            print(f"  - {n}  {i}")
    return passed == total

if __name__ == "__main__":
    ok = main()
    sys.exit(0 if ok else 1)
