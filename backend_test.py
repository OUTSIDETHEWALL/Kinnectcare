"""Smoke test for KinnectCare backend after frontend-only logo asset swap."""
import sys
from datetime import datetime
import requests

FRONTEND_ENV = "/app/frontend/.env"
BASE = None
with open(FRONTEND_ENV) as f:
    for line in f:
        line = line.strip()
        if line.startswith("EXPO_PUBLIC_BACKEND_URL=") or line.startswith("EXPO_BACKEND_URL="):
            v = line.split("=", 1)[1].strip().strip('"')
            BASE = v.rstrip("/") + "/api"
            break

assert BASE, "Could not resolve backend URL from /app/frontend/.env"
print(f"BASE = {BASE}")

EMAIL = "demo@kinnectcare.app"
PASSWORD = "password123"

failures = []
def check(name, cond, info=""):
    status = "PASS" if cond else "FAIL"
    print(f"[{status}] {name}{(' - ' + info) if info else ''}")
    if not cond:
        failures.append(f"{name}: {info}")

# 1. login
r = requests.post(f"{BASE}/auth/login", json={"email": EMAIL, "password": PASSWORD}, timeout=30)
check("POST /auth/login -> 200", r.status_code == 200, f"status={r.status_code} body={r.text[:200]}")
data = r.json() if r.status_code == 200 else {}
token = data.get("access_token")
check("login returns access_token", bool(token), f"token_present={bool(token)}")
H = {"Authorization": f"Bearer {token}"} if token else {}

# 2. /auth/me
r = requests.get(f"{BASE}/auth/me", headers=H, timeout=30)
check("GET /auth/me -> 200", r.status_code == 200, f"status={r.status_code}")

# 3. /summary
r = requests.get(f"{BASE}/summary", headers=H, timeout=30)
check("GET /summary -> 200", r.status_code == 200, f"status={r.status_code} body={r.text[:200]}")
summary = r.json() if r.status_code == 200 else {}
members_arr = summary.get("members")
check("summary has members array", isinstance(members_arr, list),
      f"type={type(members_arr).__name__} len={len(members_arr) if isinstance(members_arr, list) else 'n/a'}")

# 4. /members
r = requests.get(f"{BASE}/members", headers=H, timeout=30)
check("GET /members -> 200", r.status_code == 200, f"status={r.status_code}")
members = r.json() if r.status_code == 200 else []
check("/members non-empty", isinstance(members, list) and len(members) > 0,
      f"count={len(members) if isinstance(members, list) else 'n/a'}")

# 5. /billing/status
r = requests.get(f"{BASE}/billing/status", headers=H, timeout=30)
check("GET /billing/status -> 200", r.status_code == 200, f"status={r.status_code}")
billing = r.json() if r.status_code == 200 else {}
paid_plan = billing.get("paid_plan") or {}
check("billing.paid_plan.amount_cents == 999", paid_plan.get("amount_cents") == 999,
      f"got={paid_plan.get('amount_cents')}")

# 6. /sos with coords
r = requests.post(f"{BASE}/sos", headers=H, json={"latitude": 37.7749, "longitude": -122.4194}, timeout=30)
check("POST /sos -> 200", r.status_code == 200, f"status={r.status_code} body={r.text[:200]}")
sos = r.json() if r.status_code == 200 else {}
ts = sos.get("timestamp")
try:
    if ts:
        datetime.fromisoformat(ts)
    ts_ok = ts is not None
except Exception:
    ts_ok = False
check("sos.timestamp ISO parseable", ts_ok, f"timestamp={ts}")
check("sos.member_name present", bool(sos.get("member_name")), f"member_name={sos.get('member_name')}")
coords = sos.get("coordinates") or {}
check("sos.coordinates.latitude == 37.7749", coords.get("latitude") == 37.7749, f"lat={coords.get('latitude')}")
check("sos.coordinates.longitude == -122.4194", coords.get("longitude") == -122.4194,
      f"lng={coords.get('longitude')}")
check("sos.devices_notified is int", isinstance(sos.get("devices_notified"), int),
      f"devices_notified={sos.get('devices_notified')}")

# 7. /checkins
first_id = members[0]["id"] if members else None
check("first member id present", bool(first_id), f"id={first_id}")
if first_id:
    r = requests.post(
        f"{BASE}/checkins", headers=H,
        json={"member_id": first_id, "latitude": 12.97, "longitude": 77.59}, timeout=30,
    )
    check("POST /checkins -> 200", r.status_code == 200, f"status={r.status_code} body={r.text[:200]}")
    ci = r.json() if r.status_code == 200 else {}
    check("checkin returned with id", bool(ci.get("id")), f"id={ci.get('id')}")
    check("checkin.latitude == 12.97", ci.get("latitude") == 12.97, f"lat={ci.get('latitude')}")
    check("checkin.longitude == 77.59", ci.get("longitude") == 77.59, f"lng={ci.get('longitude')}")

print("\n========== SUMMARY ==========")
if failures:
    print(f"FAILED: {len(failures)} check(s)")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)
else:
    print("ALL GREEN")
    sys.exit(0)
