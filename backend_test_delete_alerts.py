"""
Focused test for DELETE /api/alerts endpoint.
Tests against http://localhost:8001 (per review request).
"""
import requests
import sys

BASE = "http://localhost:8001/api"
EMAIL = "demo@kinnship.app"
PASSWORD = "password123"

results = []

def record(name, passed, detail=""):
    results.append((name, passed, detail))
    status = "PASS" if passed else "FAIL"
    print(f"[{status}] {name}: {detail}")

# Step 1: Login
print("\n=== Step 1: POST /api/auth/login ===")
r = requests.post(f"{BASE}/auth/login", json={"email": EMAIL, "password": PASSWORD})
record("POST /api/auth/login -> 200", r.status_code == 200, f"status={r.status_code}")
if r.status_code != 200:
    print(f"Body: {r.text}")
    sys.exit(1)
data = r.json()
token = data["access_token"]
headers = {"Authorization": f"Bearer {token}"}
print(f"  Got token, user={data['user']['email']}")

# Verify /api/auth/me
print("\n=== Verify GET /api/auth/me ===")
r = requests.get(f"{BASE}/auth/me", headers=headers)
record("GET /api/auth/me -> 200 (with token)", r.status_code == 200, f"status={r.status_code}, email={r.json().get('email') if r.status_code==200 else 'N/A'}")

# Step 2: Create at least 2 alerts via POST /api/sos
print("\n=== Step 2: Create 2 SOS alerts ===")
sos_alert_ids = []
for i in range(2):
    r = requests.post(f"{BASE}/sos", headers=headers, json={"latitude": 37.7749, "longitude": -122.4194})
    ok = r.status_code == 200
    aid = r.json().get("alert_id") if ok else None
    if aid:
        sos_alert_ids.append(aid)
    record(f"POST /api/sos #{i+1} -> 200", ok, f"status={r.status_code}, alert_id={aid}")

# Step 3: GET /api/alerts -> confirm at least 2 alerts exist
print("\n=== Step 3: GET /api/alerts (pre-delete) ===")
r = requests.get(f"{BASE}/alerts", headers=headers)
pre_count = len(r.json()) if r.status_code == 200 else -1
record("GET /api/alerts -> 200 with >=2 alerts", r.status_code == 200 and pre_count >= 2,
       f"status={r.status_code}, count={pre_count}")
# Verify our new SOS alerts present
found_new = [a for a in (r.json() if r.status_code == 200 else []) if a["id"] in sos_alert_ids]
record("New SOS alerts present in list", len(found_new) == 2, f"found={len(found_new)}/2")

# Step 4: DELETE /api/alerts -> 200 with {ok:true, deleted:N>=2}
print("\n=== Step 4: DELETE /api/alerts ===")
r = requests.delete(f"{BASE}/alerts", headers=headers)
ok = r.status_code == 200
body = r.json() if ok else {}
record("DELETE /api/alerts -> 200", ok, f"status={r.status_code}, body={body}")
record("Response shape: ok=true", body.get("ok") is True, f"ok={body.get('ok')}")
record("Response shape: deleted>=2", isinstance(body.get("deleted"), int) and body["deleted"] >= 2,
       f"deleted={body.get('deleted')}")

# Step 5: GET /api/alerts again -> empty array (or no deleted alerts)
print("\n=== Step 5: GET /api/alerts (post-delete) ===")
r = requests.get(f"{BASE}/alerts", headers=headers)
post_count = len(r.json()) if r.status_code == 200 else -1
record("GET /api/alerts -> 200 after delete", r.status_code == 200, f"status={r.status_code}, count={post_count}")
# After deleting all alerts there could still be alerts from detect_missed_checkins if a member missed check-in.
# But none of our deleted SOS ids should be present.
remaining = r.json() if r.status_code == 200 else []
still_present = [a for a in remaining if a["id"] in sos_alert_ids]
record("Deleted SOS alerts no longer present", len(still_present) == 0,
       f"still_present={len(still_present)}, total_remaining={post_count}")

# Step 6: DELETE /api/alerts WITHOUT auth -> 401 (or 403 with HTTPBearer)
print("\n=== Step 6: DELETE /api/alerts (no auth) ===")
r = requests.delete(f"{BASE}/alerts")
# FastAPI HTTPBearer returns 403 by default when no creds; accept 401 or 403
record("DELETE /api/alerts without auth -> 401/403",
       r.status_code in (401, 403),
       f"status={r.status_code} (FastAPI HTTPBearer returns 403 for missing creds)")

# Summary
print("\n" + "=" * 60)
print("SUMMARY")
print("=" * 60)
passed = sum(1 for _, p, _ in results if p)
total = len(results)
for name, p, detail in results:
    print(f"  [{'PASS' if p else 'FAIL'}] {name}")
print(f"\n{passed}/{total} checks passed")
sys.exit(0 if passed == total else 1)
