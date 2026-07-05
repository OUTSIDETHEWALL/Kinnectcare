#!/usr/bin/env python3
"""
RF-8 retest + smoke check after fix.
"""
import json
import sys
import requests

BASE = "https://family-guard-37.preview.emergentagent.com/api"
EMAIL = "demo@kinnship.app"
PASSWORD = "password123"


def dump(label, resp):
    try:
        body = resp.json()
    except Exception:
        body = resp.text
    print(f"\n=== {label} ===")
    print(f"HTTP {resp.status_code}")
    print(json.dumps(body, indent=2, default=str))
    return body


def main():
    s = requests.Session()
    # 1) Login
    r = s.post(f"{BASE}/auth/login", json={"email": EMAIL, "password": PASSWORD}, timeout=30)
    body = dump("login", r)
    if r.status_code != 200:
        print("LOGIN FAILED")
        sys.exit(1)
    token = body["access_token"]
    s.headers.update({"Authorization": f"Bearer {token}"})

    # Get an existing member
    r = s.get(f"{BASE}/members", timeout=30)
    members = dump("members", r)
    if r.status_code != 200 or not members:
        print("NO MEMBERS")
        sys.exit(1)
    member_id = members[0]["id"]
    print(f"\nUsing member_id={member_id}")

    # Step 1 — Create medication with refill tracking
    create_body = {
        "member_id": member_id,
        "title": "RF8RetestMed",
        "category": "medication",
        "times": [{"time": "08:00", "label": None}],
        "days_supply": 30,
        "refill_reminder_days": 7,
    }
    r = s.post(f"{BASE}/reminders", json=create_body, timeout=30)
    rb = dump("STEP1: POST /reminders (with refill)", r)
    step1_pass = (
        r.status_code == 200
        and rb.get("days_supply") == 30
        and rb.get("run_out_at") is not None
    )
    print(f"\n>> STEP 1: {'PASS' if step1_pass else 'FAIL'}")
    if not step1_pass:
        sys.exit(1)
    rid = rb["id"]

    # Step 2 — Disable refill tracking with days_supply=0
    r = s.put(f"{BASE}/reminders/{rid}", json={"days_supply": 0}, timeout=30)
    rb2 = dump("STEP2: PUT /reminders/{id} {days_supply:0} (DISABLE)", r)
    step2_pass = (
        r.status_code == 200
        and rb2.get("days_supply") is None
        and rb2.get("refill_reminder_days") is None
        and rb2.get("last_refill_at") is None
        and rb2.get("run_out_at") is None
    )
    print(f"\n>> STEP 2: {'PASS' if step2_pass else 'FAIL'}")
    if r.status_code == 200:
        print(f"   days_supply           = {rb2.get('days_supply')}")
        print(f"   refill_reminder_days  = {rb2.get('refill_reminder_days')}")
        print(f"   last_refill_at        = {rb2.get('last_refill_at')}")
        print(f"   run_out_at            = {rb2.get('run_out_at')}")

    # Step 3 — Smoke: medications/_tick
    r = s.post(f"{BASE}/medications/_tick", timeout=30)
    rb3 = dump("STEP3: POST /medications/_tick", r)
    step3_pass = (
        r.status_code == 200
        and isinstance(rb3, dict)
        # 3-stage scheduler counters
        and "fired_due" in rb3
        # refill counters
        and "scanned_refill" in rb3
        and "fired_refill" in rb3
    )
    print(f"\n>> STEP 3: {'PASS' if step3_pass else 'FAIL'}")

    # Cleanup
    try:
        s.delete(f"{BASE}/reminders/{rid}", timeout=15)
    except Exception:
        pass

    print("\n================ SUMMARY ================")
    print(f" Step 1 (create with refill):     {'PASS' if step1_pass else 'FAIL'}")
    print(f" Step 2 (disable via days_supply=0): {'PASS' if step2_pass else 'FAIL'}")
    print(f" Step 3 (medications/_tick smoke): {'PASS' if step3_pass else 'FAIL'}")
    all_pass = step1_pass and step2_pass and step3_pass
    print(f" OVERALL: {'PASS' if all_pass else 'FAIL'}")
    sys.exit(0 if all_pass else 1)


if __name__ == "__main__":
    main()
