"""
Kinnship rebrand smoke test.
Verifies:
1. GET /api/ -> 200 message "Kinnship API"
2. POST /api/auth/login (demo@kinnship.app/password123) -> 200 + token
3. GET /api/auth/me -> 200, full_name present
4. GET /api/summary -> 200 with members array
5. GET /api/members -> 200
6. GET /api/billing/status -> 200; paid_plan.product_name == "Kinnship Family Plan"
7. POST /api/sos lat/lng -> 200 + ISO timestamp/member_name/coords/devices_notified
8. POST /api/checkins with member_id+lat/lng -> 200
9. Regression: POST /api/auth/login old demo@kinnectcare.app -> 401
"""

import os
import sys
import json
from datetime import datetime
import requests

BASE = "https://family-guard-37.preview.emergentagent.com/api"

PASS = "\033[92mPASS\033[0m"
FAIL = "\033[91mFAIL\033[0m"

results = []


def check(name, ok, info=""):
    results.append((name, ok, info))
    tag = PASS if ok else FAIL
    print(f"{tag}: {name}" + (f"  -- {info}" if info else ""))


def main():
    # 1. Root
    try:
        r = requests.get(f"{BASE}/", timeout=15)
        ok = r.status_code == 200 and r.json().get("message") == "Kinnship API"
        check("1. GET /api/ -> 200 'Kinnship API'", ok, f"status={r.status_code} body={r.text[:200]}")
    except Exception as e:
        check("1. GET /api/", False, f"exception {e}")
        return

    # 2. Login new email
    token = None
    try:
        r = requests.post(
            f"{BASE}/auth/login",
            json={"email": "demo@kinnship.app", "password": "password123"},
            timeout=20,
        )
        body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
        token = body.get("access_token")
        ok = r.status_code == 200 and bool(token)
        check("2. POST /api/auth/login (new demo) -> 200 + token", ok,
              f"status={r.status_code} token_present={bool(token)}")
    except Exception as e:
        check("2. login", False, f"exception {e}")
        return

    if not token:
        print("Cannot continue without token.")
        return

    H = {"Authorization": f"Bearer {token}"}

    # 3. /auth/me
    try:
        r = requests.get(f"{BASE}/auth/me", headers=H, timeout=15)
        body = r.json() if r.ok else {}
        ok = r.status_code == 200 and bool(body.get("full_name"))
        check("3. GET /api/auth/me -> 200 with full_name", ok,
              f"status={r.status_code} full_name={body.get('full_name')!r} email={body.get('email')!r}")
    except Exception as e:
        check("3. /auth/me", False, str(e))

    # 4. /summary
    member_id = None
    try:
        r = requests.get(f"{BASE}/summary", headers=H, timeout=20)
        body = r.json() if r.ok else {}
        members = body.get("members", [])
        ok = r.status_code == 200 and isinstance(members, list)
        check("4. GET /api/summary -> 200 with members[]", ok,
              f"status={r.status_code} members_count={len(members)}")
        if members:
            member_id = members[0].get("id") or members[0].get("member_id")
    except Exception as e:
        check("4. /summary", False, str(e))

    # 5. /members
    try:
        r = requests.get(f"{BASE}/members", headers=H, timeout=20)
        body = r.json() if r.ok else []
        ok = r.status_code == 200 and isinstance(body, list)
        check("5. GET /api/members -> 200", ok, f"status={r.status_code} count={len(body) if isinstance(body, list) else 'n/a'}")
        if not member_id and isinstance(body, list) and body:
            member_id = body[0].get("id")
    except Exception as e:
        check("5. /members", False, str(e))

    # 6. /billing/status — product_name should be "Kinnship Family Plan"
    try:
        r = requests.get(f"{BASE}/billing/status", headers=H, timeout=20)
        body = r.json() if r.ok else {}
        paid = body.get("paid_plan") or {}
        product_name = paid.get("product_name")
        ok = r.status_code == 200 and product_name == "Kinnship Family Plan"
        check("6. GET /api/billing/status -> paid_plan.product_name == 'Kinnship Family Plan'", ok,
              f"status={r.status_code} product_name={product_name!r} amount_cents={paid.get('amount_cents')}")
    except Exception as e:
        check("6. /billing/status", False, str(e))

    # 7. /sos
    try:
        r = requests.post(
            f"{BASE}/sos",
            headers=H,
            json={"latitude": 1.0, "longitude": 1.0},
            timeout=20,
        )
        body = r.json() if r.ok else {}
        ts = body.get("timestamp")
        mname = body.get("member_name")
        coords = body.get("coordinates")
        dn = body.get("devices_notified")
        iso_ok = False
        if isinstance(ts, str):
            try:
                datetime.fromisoformat(ts.replace("Z", "+00:00"))
                iso_ok = True
            except Exception:
                iso_ok = False
        ok = (
            r.status_code == 200
            and iso_ok
            and isinstance(mname, str) and mname
            and isinstance(coords, dict)
            and coords.get("latitude") == 1.0 and coords.get("longitude") == 1.0
            and isinstance(dn, int)
        )
        check(
            "7. POST /api/sos {lat:1.0, lng:1.0} -> 200 ts/member_name/coords/devices_notified",
            ok,
            f"status={r.status_code} ts={ts} member_name={mname!r} coords={coords} devices_notified={dn}",
        )
    except Exception as e:
        check("7. /sos", False, str(e))

    # 8. /checkins
    if member_id:
        try:
            r = requests.post(
                f"{BASE}/checkins",
                headers=H,
                json={
                    "member_id": member_id,
                    "latitude": 12.97,
                    "longitude": 77.59,
                    "location_name": "Kinnship Smoke",
                },
                timeout=20,
            )
            body = r.json() if r.ok else {}
            ok = (
                r.status_code == 200
                and body.get("member_id") == member_id
                and body.get("latitude") == 12.97
                and body.get("longitude") == 77.59
            )
            check("8. POST /api/checkins -> 200", ok,
                  f"status={r.status_code} body={json.dumps(body)[:200]}")
        except Exception as e:
            check("8. /checkins", False, str(e))
    else:
        check("8. /checkins", False, "No member_id available from /summary or /members")

    # 9. Regression: old email returns 401
    try:
        r = requests.post(
            f"{BASE}/auth/login",
            json={"email": "demo@kinnectcare.app", "password": "password123"},
            timeout=20,
        )
        ok = r.status_code == 401
        check("9. OLD demo@kinnectcare.app login -> 401", ok,
              f"status={r.status_code} body={r.text[:200]}")
    except Exception as e:
        check("9. old login", False, str(e))

    # Summary
    total = len(results)
    passed = sum(1 for _, ok, _ in results if ok)
    print(f"\n=== {passed}/{total} checks passed ===")
    if passed != total:
        sys.exit(1)


if __name__ == "__main__":
    main()
