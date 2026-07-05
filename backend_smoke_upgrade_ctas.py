"""
Fast backend smoke after frontend-only upgrade CTAs change.
Verifies regressions around /billing/status, /summary, /members, /sos, /checkins.
"""
import os
import sys
import requests
from datetime import datetime

BASE = "https://family-guard-37.preview.emergentagent.com/api"
EMAIL = "demo@kinnectcare.app"
PASSWORD = "password123"

failed = []
passed = []

def check(name, cond, info=""):
    if cond:
        passed.append(name)
        print(f"PASS: {name}")
    else:
        failed.append((name, info))
        print(f"FAIL: {name} :: {info}")

# 1) Login
r = requests.post(f"{BASE}/auth/login", json={"email": EMAIL, "password": PASSWORD}, timeout=30)
check("POST /auth/login -> 200", r.status_code == 200, f"status={r.status_code} body={r.text[:200]}")
token = r.json().get("access_token") if r.status_code == 200 else None
check("login returns access_token", bool(token))
H = {"Authorization": f"Bearer {token}"} if token else {}

# 2) /auth/me
r = requests.get(f"{BASE}/auth/me", headers=H, timeout=30)
check("GET /auth/me -> 200", r.status_code == 200, f"status={r.status_code}")

# 3) /billing/status
r = requests.get(f"{BASE}/billing/status", headers=H, timeout=30)
check("GET /billing/status -> 200", r.status_code == 200, f"status={r.status_code} body={r.text[:300]}")
if r.status_code == 200:
    b = r.json()
    plan = b.get("plan")
    check("billing.plan in ('free','family_plan')", plan in ("free", "family_plan"), f"plan={plan}")
    ml = b.get("member_limit")
    if plan == "free":
        check("billing.member_limit is int when free", isinstance(ml, int), f"ml={ml}")
    else:
        check("billing.member_limit is null when paid", ml is None, f"ml={ml}")
    check("billing.member_count is int", isinstance(b.get("member_count"), int), f"member_count={b.get('member_count')}")
    # members_remaining: int when free, None when paid
    mr = b.get("members_remaining")
    if plan == "free":
        check("billing.members_remaining is int when free", isinstance(mr, int), f"mr={mr}")
    else:
        check("billing.members_remaining is null when paid", mr is None, f"mr={mr}")
    pp = b.get("paid_plan") or {}
    check("paid_plan.amount_cents == 999", pp.get("amount_cents") == 999, f"got={pp.get('amount_cents')}")
    check("paid_plan.currency == 'usd'", pp.get("currency") == "usd", f"got={pp.get('currency')}")
    check("paid_plan.interval == 'month'", pp.get("interval") == "month", f"got={pp.get('interval')}")
    check("paid_plan.product_name non-empty", bool(pp.get("product_name")), f"got={pp.get('product_name')}")

# 4) /summary
r = requests.get(f"{BASE}/summary", headers=H, timeout=30)
check("GET /summary -> 200", r.status_code == 200, f"status={r.status_code} body={r.text[:200]}")
members_arr = []
if r.status_code == 200:
    body = r.json()
    members_arr = body.get("members") or []
    check("summary.members is a list", isinstance(members_arr, list))
    check("summary.members non-empty", len(members_arr) > 0, f"len={len(members_arr)}")

# 5) /members
r = requests.get(f"{BASE}/members", headers=H, timeout=30)
check("GET /members -> 200", r.status_code == 200, f"status={r.status_code}")
members_list = r.json() if r.status_code == 200 else []
check("/members returns non-empty list", isinstance(members_list, list) and len(members_list) > 0, f"len={len(members_list) if isinstance(members_list,list) else 'n/a'}")
first_member_id = None
if isinstance(members_list, list) and members_list:
    first_member_id = members_list[0].get("id")

# 6) SOS with coords
sos_body = {"latitude": 37.7749, "longitude": -122.4194}
r = requests.post(f"{BASE}/sos", json=sos_body, headers=H, timeout=30)
check("POST /sos with coords -> 200", r.status_code == 200, f"status={r.status_code} body={r.text[:300]}")
if r.status_code == 200:
    s = r.json()
    # timestamp ISO
    ts = s.get("timestamp")
    iso_ok = False
    try:
        datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        iso_ok = True
    except Exception:
        iso_ok = False
    check("sos.timestamp is ISO parseable", iso_ok, f"ts={ts}")
    check("sos.member_name present (non-empty)", bool(s.get("member_name")), f"member_name={s.get('member_name')}")
    coords = s.get("coordinates") or {}
    check("sos.coordinates.latitude == 37.7749", coords.get("latitude") == 37.7749, f"coords={coords}")
    check("sos.coordinates.longitude == -122.4194", coords.get("longitude") == -122.4194, f"coords={coords}")
    check("sos.devices_notified is int", isinstance(s.get("devices_notified"), int), f"got={s.get('devices_notified')}")

# 7) check-in with coords
if first_member_id:
    chk_body = {"member_id": first_member_id, "latitude": 12.97, "longitude": 77.59, "location_name": "Smoke"}
    r = requests.post(f"{BASE}/checkins", json=chk_body, headers=H, timeout=30)
    check("POST /checkins with coords -> 200", r.status_code == 200, f"status={r.status_code} body={r.text[:300]}")
    rec = r.json() if r.status_code == 200 else {}
    # GET recent and ensure first matches
    r2 = requests.get(f"{BASE}/checkins/recent", headers=H, timeout=30)
    check("GET /checkins/recent -> 200", r2.status_code == 200, f"status={r2.status_code}")
    if r2.status_code == 200:
        recent = r2.json()
        check("/checkins/recent returns non-empty list", isinstance(recent, list) and len(recent) > 0)
        if isinstance(recent, list) and recent:
            top = recent[0]
            check("/checkins/recent first.member_id matches", top.get("member_id") == first_member_id, f"top.member_id={top.get('member_id')} expected={first_member_id}")
            check("/checkins/recent first.latitude == 12.97", top.get("latitude") == 12.97, f"got={top.get('latitude')}")
            check("/checkins/recent first.longitude == 77.59", top.get("longitude") == 77.59, f"got={top.get('longitude')}")
            check("/checkins/recent first.location_name == 'Smoke'", top.get("location_name") == "Smoke", f"got={top.get('location_name')}")

    # 8) check-in without coords
    chk_body2 = {"member_id": first_member_id}
    r = requests.post(f"{BASE}/checkins", json=chk_body2, headers=H, timeout=30)
    check("POST /checkins without coords -> 200", r.status_code == 200, f"status={r.status_code} body={r.text[:300]}")
    if r.status_code == 200:
        rec2 = r.json()
        check("/checkins no-coords: latitude is null", rec2.get("latitude") in (None,), f"got={rec2.get('latitude')}")
        check("/checkins no-coords: longitude is null", rec2.get("longitude") in (None,), f"got={rec2.get('longitude')}")
else:
    failed.append(("first_member_id resolution", "no member id available"))

print()
print(f"PASSED: {len(passed)} / {len(passed)+len(failed)}")
if failed:
    print("FAILURES:")
    for n, info in failed:
        print(f"  - {n} :: {info}")
    sys.exit(1)
sys.exit(0)
