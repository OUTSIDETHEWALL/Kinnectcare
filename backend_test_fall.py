"""Backend tests for KinnectCare fall_detected SOS feature."""
import os
import sys
import json
import requests
from datetime import datetime

BASE = "https://family-guard-37.preview.emergentagent.com/api"
EMAIL = "demo@kinnectcare.app"
PASSWORD = "password123"

results = []


def check(name, cond, info=""):
    status = "PASS" if cond else "FAIL"
    results.append((status, name, info))
    print(f"[{status}] {name} {info}")
    return cond


def main():
    # Login
    r = requests.post(f"{BASE}/auth/login", json={"email": EMAIL, "password": PASSWORD}, timeout=30)
    check("auth/login 200", r.status_code == 200, f"status={r.status_code}")
    if r.status_code != 200:
        print("Cannot continue without auth")
        sys.exit(1)
    auth = r.json()
    token = auth["access_token"]
    user = auth["user"]
    h = {"Authorization": f"Bearer {token}"}

    # /auth/me
    r = requests.get(f"{BASE}/auth/me", headers=h, timeout=30)
    check("auth/me 200", r.status_code == 200)
    me = r.json()
    check("auth/me email matches", me["email"] == EMAIL.lower(), f"email={me['email']}")

    # Test 1: POST /api/sos with coords + fall_detected: true
    body1 = {"latitude": 37.7749, "longitude": -122.4194, "fall_detected": True}
    r = requests.post(f"{BASE}/sos", headers=h, json=body1, timeout=30)
    check("T1 POST /sos with fall_detected=true 200", r.status_code == 200, f"status={r.status_code}")
    if r.status_code == 200:
        b = r.json()
        # timestamp parseable
        ts_ok = False
        try:
            datetime.fromisoformat(b["timestamp"])
            ts_ok = True
        except Exception as e:
            print("ts parse err:", e)
        check("T1 timestamp ISO-parseable", ts_ok, f"ts={b.get('timestamp')}")
        check("T1 member_name present (non-empty)", bool(b.get("member_name")), f"member_name={b.get('member_name')}")
        check("T1 coordinates lat==37.7749", b.get("coordinates", {}).get("latitude") == 37.7749, f"coords={b.get('coordinates')}")
        check("T1 coordinates lng==-122.4194", b.get("coordinates", {}).get("longitude") == -122.4194)
        check("T1 devices_notified is int", isinstance(b.get("devices_notified"), int), f"devices_notified={b.get('devices_notified')}")
        check("T1 ok=True", b.get("ok") is True)
        print(f"  T1 full response: {json.dumps(b, indent=2)}")
        alert1_id = b.get("alert_id")
    else:
        alert1_id = None
        print("T1 body:", r.text)

    # Test 2: POST /api/sos with coords only (no fall_detected)
    body2 = {"latitude": 1.0, "longitude": 1.0}
    r = requests.post(f"{BASE}/sos", headers=h, json=body2, timeout=30)
    check("T2 POST /sos no fall_detected 200", r.status_code == 200, f"status={r.status_code}")
    if r.status_code == 200:
        b = r.json()
        check("T2 coordinates lat==1.0", b.get("coordinates", {}).get("latitude") == 1.0, f"coords={b.get('coordinates')}")
        check("T2 coordinates lng==1.0", b.get("coordinates", {}).get("longitude") == 1.0)
        check("T2 devices_notified is int", isinstance(b.get("devices_notified"), int))
        alert2_id = b.get("alert_id")
    else:
        alert2_id = None

    # Test 3: POST /api/sos fall_detected=true with no coords
    body3 = {"fall_detected": True}
    r = requests.post(f"{BASE}/sos", headers=h, json=body3, timeout=30)
    check("T3 POST /sos fall_detected no coords 200", r.status_code == 200, f"status={r.status_code}")
    if r.status_code == 200:
        b = r.json()
        check("T3 coordinates == null", b.get("coordinates") is None, f"coords={b.get('coordinates')}")
        check("T3 member_name present", bool(b.get("member_name")))
        alert3_id = b.get("alert_id")
    else:
        alert3_id = None

    # Test 4: POST /api/sos with empty body
    r = requests.post(f"{BASE}/sos", headers=h, json={}, timeout=30)
    check("T4 POST /sos empty body 200", r.status_code == 200, f"status={r.status_code}")
    if r.status_code == 200:
        b = r.json()
        check("T4 coordinates == null", b.get("coordinates") is None)
        check(
            "T4 member_name == user.full_name",
            b.get("member_name") == user["full_name"],
            f"member_name={b.get('member_name')} vs user.full_name={user['full_name']}",
        )
        alert4_id = b.get("alert_id")
    else:
        alert4_id = None

    # Test 5: GET /api/alerts -> confirm SOS alerts exist
    r = requests.get(f"{BASE}/alerts", headers=h, timeout=30)
    check("T5 GET /alerts 200", r.status_code == 200, f"status={r.status_code}")
    if r.status_code == 200:
        alerts = r.json()
        sos_alerts = [a for a in alerts if a.get("type") == "sos" and a.get("severity") == "critical"]
        check("T5 SOS critical alerts exist (>=4)", len(sos_alerts) >= 4, f"count={len(sos_alerts)}")
        new_ids = {alert1_id, alert2_id, alert3_id, alert4_id} - {None}
        found_ids = {a["id"] for a in alerts}
        missing = new_ids - found_ids
        check("T5 all newly inserted SOS alert ids found", not missing, f"missing={missing}")

    # Test 6: Smoke tests
    r = requests.get(f"{BASE}/summary", headers=h, timeout=30)
    check("T6 GET /summary 200", r.status_code == 200, f"status={r.status_code}")
    if r.status_code == 200:
        s = r.json()
        check("T6 /summary has members", isinstance(s.get("members"), list) and len(s["members"]) > 0)
        first = s["members"][0]
        required = {"medication_total", "medication_taken", "medication_missed", "routine_total", "weekly_compliance_percent"}
        check("T6 /summary member fields present", required.issubset(set(first.keys())), f"missing={required - set(first.keys())}")

    r = requests.get(f"{BASE}/billing/status", headers=h, timeout=30)
    check("T6 GET /billing/status 200", r.status_code == 200, f"status={r.status_code}")
    if r.status_code == 200:
        b = r.json()
        paid_plan = b.get("paid_plan") or {}
        check("T6 paid_plan.amount_cents == 999", paid_plan.get("amount_cents") == 999, f"amount_cents={paid_plan.get('amount_cents')}")

    r = requests.get(f"{BASE}/members", headers=h, timeout=30)
    check("T6 GET /members 200", r.status_code == 200, f"status={r.status_code}")
    member_id = None
    if r.status_code == 200:
        members = r.json()
        check("T6 members list non-empty", len(members) > 0, f"count={len(members)}")
        if members:
            member_id = members[0]["id"]

    if member_id:
        body = {"member_id": member_id, "latitude": 12.97, "longitude": 77.59, "location_name": "Smoke FallTest"}
        r = requests.post(f"{BASE}/checkins", headers=h, json=body, timeout=30)
        check("T6 POST /checkins 200", r.status_code == 200, f"status={r.status_code}")
        if r.status_code == 200:
            ci = r.json()
            check("T6 checkin latitude=12.97", ci.get("latitude") == 12.97)
            check("T6 checkin longitude=77.59", ci.get("longitude") == 77.59)

    # Summary
    print("\n" + "=" * 70)
    passed = sum(1 for s, _, _ in results if s == "PASS")
    failed = sum(1 for s, _, _ in results if s == "FAIL")
    print(f"TOTAL: {passed} passed, {failed} failed out of {len(results)}")
    if failed:
        print("\nFAILURES:")
        for s, n, i in results:
            if s == "FAIL":
                print(f"  - {n} {i}")
    return failed == 0


if __name__ == "__main__":
    ok = main()
    sys.exit(0 if ok else 1)
