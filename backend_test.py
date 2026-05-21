#!/usr/bin/env python3
"""
Kinnship Backend Test — EC-N (emergency_contact_name) + RF (medication refill reminder)
Targets: https://family-guard-37.preview.emergentagent.com/api
Demo creds: demo@kinnship.app / password123
"""
import json
import os
import sys
import time
import uuid
from datetime import datetime, timezone, timedelta

import requests

BASE = "https://family-guard-37.preview.emergentagent.com/api"
EMAIL = "demo@kinnship.app"
PASS = "password123"

results = []  # list of (name, ok, detail)


def log(name, ok, detail=""):
    status = "PASS" if ok else "FAIL"
    print(f"[{status}] {name}: {detail}")
    results.append((name, ok, detail))


def login():
    r = requests.post(f"{BASE}/auth/login", json={"email": EMAIL, "password": PASS}, timeout=30)
    r.raise_for_status()
    return r.json()["access_token"]


def H(tok):
    return {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}


def iso_parse(s):
    if s is None:
        return None
    if isinstance(s, str):
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    else:
        dt = s
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def main():
    token = login()
    headers = H(token)
    print(f"\n=== Logged in as {EMAIL} ===\n")

    # ==================== Group EC-N ====================
    print("\n--- Group EC-N: Emergency contact name ---")

    # Create a fresh member for isolated testing
    member_payload = {
        "name": "EC Test Member",
        "age": 70,
        "role": "senior",
        "gender": "female",
        "phone": "+15550001111",
    }
    r = requests.post(f"{BASE}/members", json=member_payload, headers=headers, timeout=30)
    if r.status_code != 200:
        log("EC-N setup: create member", False, f"{r.status_code} {r.text}")
        rr = requests.get(f"{BASE}/members", headers=headers, timeout=30)
        members = rr.json()
        if not members:
            print("No members available, aborting")
            return False
        member_id = members[0]["id"]
    else:
        member_id = r.json()["id"]
        print(f"  Created member id={member_id}")

    # EC-N1: Set both name and phone
    body = {
        "emergency_contact_name": "Jane Smith",
        "emergency_contact_phone": "+15551234567",
    }
    r = requests.put(f"{BASE}/members/{member_id}", json=body, headers=headers, timeout=30)
    ok1 = r.status_code == 200
    if ok1:
        rg = requests.get(f"{BASE}/members/{member_id}", headers=headers, timeout=30)
        d = rg.json()
        ok1 = (
            d.get("emergency_contact_name") == "Jane Smith"
            and d.get("emergency_contact_phone") == "+15551234567"
        )
        log("EC-N1", ok1, f"name={d.get('emergency_contact_name')!r} phone={d.get('emergency_contact_phone')!r}")
    else:
        log("EC-N1", False, f"PUT {r.status_code} {r.text}")

    # EC-N2: Clear just name
    body = {"emergency_contact_name": None}
    r = requests.put(f"{BASE}/members/{member_id}", json=body, headers=headers, timeout=30)
    ok2 = r.status_code == 200
    if ok2:
        rg = requests.get(f"{BASE}/members/{member_id}", headers=headers, timeout=30)
        d = rg.json()
        ok2 = (
            d.get("emergency_contact_name") is None
            and d.get("emergency_contact_phone") == "+15551234567"
        )
        log("EC-N2", ok2, f"name={d.get('emergency_contact_name')!r} phone(unchanged)={d.get('emergency_contact_phone')!r}")
    else:
        log("EC-N2", False, f"PUT {r.status_code} {r.text}")

    # EC-N3: backwards compat (phone only, no name)
    body = {"emergency_contact_phone": "+15559998888"}
    r = requests.put(f"{BASE}/members/{member_id}", json=body, headers=headers, timeout=30)
    ok3 = r.status_code == 200
    if ok3:
        rg = requests.get(f"{BASE}/members/{member_id}", headers=headers, timeout=30)
        d = rg.json()
        ok3 = (
            d.get("emergency_contact_phone") == "+15559998888"
            and d.get("emergency_contact_name") is None
        )
        log("EC-N3", ok3, f"phone={d.get('emergency_contact_phone')!r} name(unchanged-null)={d.get('emergency_contact_name')!r}")
    else:
        log("EC-N3", False, f"PUT {r.status_code} {r.text}")

    # ==================== Group RF ====================
    print("\n--- Group RF: Medication refill reminder ---")

    test_member_id = member_id

    # RF-1: Create medication WITH refill tracking
    rf1_payload = {
        "member_id": test_member_id,
        "title": "Lisinopril",
        "category": "medication",
        "times": [{"time": "08:00", "label": "Morning"}],
        "days_supply": 30,
        "refill_reminder_days": 7,
    }
    t0 = datetime.now(timezone.utc)
    r = requests.post(f"{BASE}/reminders", json=rf1_payload, headers=headers, timeout=30)
    rf1_id = None
    if r.status_code != 200:
        log("RF-1", False, f"{r.status_code} {r.text}")
    else:
        d = r.json()
        rf1_id = d["id"]
        ds = d.get("days_supply")
        lead = d.get("refill_reminder_days")
        lra = iso_parse(d.get("last_refill_at"))
        roa = iso_parse(d.get("run_out_at"))
        ok = ds == 30 and lead == 7
        ok_lra = lra is not None and abs((lra - t0).total_seconds()) < 30
        ok_roa = roa is not None and abs((roa - (t0 + timedelta(days=30))).total_seconds()) < 120
        ok = ok and ok_lra and ok_roa
        log("RF-1", ok, f"ds={ds} lead={lead} lra_ok={ok_lra} roa_ok={ok_roa} lra={lra} roa={roa}")

    # RF-2: invalid days_supply > 365
    rf2_payload = {
        "member_id": test_member_id,
        "title": "BadMed1",
        "category": "medication",
        "times": [{"time": "09:00"}],
        "days_supply": 400,
    }
    r = requests.post(f"{BASE}/reminders", json=rf2_payload, headers=headers, timeout=30)
    detail = ""
    try:
        detail = r.json().get("detail", "")
    except Exception:
        detail = r.text
    ok = r.status_code == 400 and "1 and 365" in str(detail)
    log("RF-2", ok, f"status={r.status_code} detail={detail!r}")

    # RF-3: lead > days_supply
    rf3_payload = {
        "member_id": test_member_id,
        "title": "BadMed2",
        "category": "medication",
        "times": [{"time": "09:00"}],
        "days_supply": 30,
        "refill_reminder_days": 40,
    }
    r = requests.post(f"{BASE}/reminders", json=rf3_payload, headers=headers, timeout=30)
    try:
        detail = r.json().get("detail", "")
    except Exception:
        detail = r.text
    ok = r.status_code == 400 and "between 1 and days_supply" in str(detail)
    log("RF-3", ok, f"status={r.status_code} detail={detail!r}")

    # RF-4: create medication WITHOUT refill
    rf4_payload = {
        "member_id": test_member_id,
        "title": "Metformin",
        "category": "medication",
        "times": [{"time": "12:00"}],
    }
    r = requests.post(f"{BASE}/reminders", json=rf4_payload, headers=headers, timeout=30)
    rf4_id = None
    if r.status_code != 200:
        log("RF-4", False, f"{r.status_code} {r.text}")
    else:
        d = r.json()
        rf4_id = d["id"]
        ok = (
            d.get("days_supply") is None
            and d.get("refill_reminder_days") is None
            and d.get("last_refill_at") is None
            and d.get("run_out_at") is None
        )
        log("RF-4", ok, f"ds={d.get('days_supply')} lead={d.get('refill_reminder_days')} lra={d.get('last_refill_at')} roa={d.get('run_out_at')}")

    # RF-5: tick within refill window
    r = requests.post(
        f"{BASE}/auth/push-token",
        json={"token": "ExponentPushToken[FAKE_RF]"},
        headers=headers, timeout=30,
    )
    print(f"  RF-5a push-token register: {r.status_code} body={r.text[:150]}")

    rf5_payload = {
        "member_id": test_member_id,
        "title": "Lisinopril",
        "category": "medication",
        "times": [{"time": "08:00", "label": "Morning"}],
        "days_supply": 10,
        "refill_reminder_days": 3,
    }
    r = requests.post(f"{BASE}/reminders", json=rf5_payload, headers=headers, timeout=30)
    rf5_id = None
    rf5_ok = False
    if r.status_code != 200:
        log("RF-5", False, f"create failed {r.status_code} {r.text}")
    else:
        rf5_id = r.json()["id"]
        print(f"  RF-5b created reminder id={rf5_id}")

        # Backdate last_refill_at
        backdated = (datetime.now(timezone.utc) - timedelta(days=8)).isoformat()
        r = requests.put(
            f"{BASE}/reminders/{rf5_id}",
            json={"last_refill_at": backdated},
            headers=headers, timeout=30,
        )
        if r.status_code != 200:
            r = requests.put(
                f"{BASE}/reminders/{rf5_id}",
                json={"last_refill_at": backdated, "days_supply": 10},
                headers=headers, timeout=30,
            )
        backdate_ok = r.status_code == 200
        if backdate_ok:
            d = r.json()
            print(f"  RF-5c backdated: last_refill_at={d.get('last_refill_at')} run_out_at={d.get('run_out_at')}")
        else:
            print(f"  RF-5c backdate FAILED {r.status_code} {r.text}")

        # Tick
        r = requests.post(f"{BASE}/medications/_tick", headers=headers, timeout=60)
        tick1_ok = r.status_code == 200
        tick1 = r.json() if tick1_ok else {}
        scanned = tick1.get("scanned_refill", 0)
        fired = tick1.get("fired_refill", 0)
        print(f"  RF-5d tick1: status={r.status_code} full={tick1}")
        ok_d = tick1_ok and scanned >= 1 and fired >= 1

        # Alerts
        r = requests.get(f"{BASE}/alerts", headers=headers, timeout=30)
        alerts = r.json() if r.status_code == 200 else []
        refill_alerts = [a for a in alerts if a.get("type") == "medication_refill"]
        target_alert = None
        for a in refill_alerts:
            t = (a.get("title") or "")
            m = (a.get("message") or "")
            if "Refill" in t and "Lisinopril" in t:
                if ("may be running low" in m or "running low" in m) and "supply runs out" in m:
                    if a.get("severity") == "warning":
                        target_alert = a
                        break
        ok_e = target_alert is not None
        print(f"  RF-5e alerts: total medication_refill={len(refill_alerts)} matched={ok_e}")
        if target_alert:
            print(f"    matched alert: {target_alert}")
        elif refill_alerts:
            print(f"    sample refill alert: {refill_alerts[-1]}")

        # Tick again — idempotent
        r = requests.post(f"{BASE}/medications/_tick", headers=headers, timeout=60)
        tick2 = r.json() if r.status_code == 200 else {}
        fired2 = tick2.get("fired_refill", -1)
        ok_f = r.status_code == 200 and fired2 == 0
        print(f"  RF-5f tick2: status={r.status_code} fired_refill={fired2} (expect 0) full={tick2}")

        rf5_ok = ok_d and ok_e and ok_f
        log("RF-5", rf5_ok, f"tick1 fired={fired} scanned={scanned}; alert_matched={ok_e}; tick2 fired_refill={fired2}")

    # RF-6: mark-refilled resets cycle
    if rf5_id:
        t_now = datetime.now(timezone.utc)
        r = requests.post(f"{BASE}/reminders/{rf5_id}/mark-refilled", headers=headers, timeout=30)
        if r.status_code != 200:
            log("RF-6", False, f"mark-refilled {r.status_code} {r.text}")
        else:
            d = r.json()
            lra = iso_parse(d.get("last_refill_at"))
            roa = iso_parse(d.get("run_out_at"))
            ok_a = lra is not None and abs((lra - t_now).total_seconds()) < 30
            ok_b = roa is not None and abs((roa - (t_now + timedelta(days=10))).total_seconds()) < 60
            r = requests.post(f"{BASE}/medications/_tick", headers=headers, timeout=60)
            tick = r.json() if r.status_code == 200 else {}
            fired = tick.get("fired_refill", -1)
            ok_c = fired == 0
            ok = ok_a and ok_b and ok_c
            log("RF-6", ok, f"lra~now={ok_a} roa~now+10d={ok_b} tick3_fired_refill={fired} (expect 0)")

    # RF-7: mark-refilled on med with no days_supply
    if rf4_id:
        r = requests.post(f"{BASE}/reminders/{rf4_id}/mark-refilled", headers=headers, timeout=30)
        if r.status_code != 400:
            log("RF-7", False, f"expected 400 got {r.status_code} {r.text}")
        else:
            try:
                detail = r.json().get("detail", "")
            except Exception:
                detail = r.text
            ok = "days_supply" in str(detail)
            log("RF-7", ok, f"detail={detail!r}")

    # RF-8: disable refill on RF-1's reminder via days_supply=0
    if rf1_id:
        r = requests.put(f"{BASE}/reminders/{rf1_id}", json={"days_supply": 0}, headers=headers, timeout=30)
        if r.status_code != 200:
            log("RF-8", False, f"{r.status_code} {r.text}")
        else:
            d = r.json()
            ok = (
                d.get("days_supply") is None
                and d.get("refill_reminder_days") is None
                and d.get("last_refill_at") is None
                and d.get("run_out_at") is None
            )
            log("RF-8", ok, f"ds={d.get('days_supply')} lead={d.get('refill_reminder_days')} lra={d.get('last_refill_at')} roa={d.get('run_out_at')}")

    # RF-9: regression — fresh medication with slot 1 min in past (no refill) -> fired_due >= 1
    r = requests.get(f"{BASE}/auth/me", headers=headers, timeout=30)
    user_tz = "UTC"
    if r.status_code == 200:
        user_tz = r.json().get("timezone") or "UTC"
    print(f"  RF-9 user_tz={user_tz}")
    try:
        from zoneinfo import ZoneInfo
        now_local = datetime.now(ZoneInfo(user_tz))
    except Exception:
        now_local = datetime.now(timezone.utc)
    past = now_local - timedelta(minutes=1)
    slot_hhmm = f"{past.hour:02d}:{past.minute:02d}"
    print(f"  RF-9 slot={slot_hhmm}")

    rf9_payload = {
        "member_id": test_member_id,
        "title": f"RegressionMed_{uuid.uuid4().hex[:6]}",
        "category": "medication",
        "times": [{"time": slot_hhmm}],
    }
    r = requests.post(f"{BASE}/reminders", json=rf9_payload, headers=headers, timeout=30)
    if r.status_code != 200:
        log("RF-9", False, f"create {r.status_code} {r.text}")
    else:
        r = requests.post(f"{BASE}/medications/_tick", headers=headers, timeout=60)
        tick = r.json() if r.status_code == 200 else {}
        fired_due = tick.get("fired_due", -1)
        keys_needed = {"fired_due", "fired_remind_30", "fired_escalate_2h", "skipped_taken", "scanned_refill", "fired_refill"}
        keys_present = set(tick.keys()) & keys_needed
        ok = r.status_code == 200 and fired_due >= 1 and keys_present == keys_needed
        log("RF-9", ok, f"fired_due={fired_due} keys_present={sorted(keys_present)} full={tick}")

    # ==================== Regression sanity ====================
    print("\n--- Regression sanity ---")
    reg_ok = True
    reg_details = []
    for ep, method, payload in [
        ("/auth/login", "POST", {"email": EMAIL, "password": PASS}),
        ("/family-group", "GET", None),
        ("/members", "GET", None),
        ("/summary", "GET", None),
        ("/billing/status", "GET", None),
        ("/alerts", "GET", None),
    ]:
        if method == "POST":
            r = requests.post(f"{BASE}{ep}", json=payload, headers={"Content-Type": "application/json"}, timeout=30)
        else:
            r = requests.get(f"{BASE}{ep}", headers=headers, timeout=30)
        ok = r.status_code == 200
        reg_details.append(f"{method} {ep}={r.status_code}")
        reg_ok = reg_ok and ok

    r = requests.post(
        f"{BASE}/sos",
        json={"member_id": test_member_id, "latitude": 1.0, "longitude": 2.0},
        headers=headers, timeout=30,
    )
    sos_ok = r.status_code == 200
    reg_details.append(f"POST /sos={r.status_code}")
    reg_ok = reg_ok and sos_ok
    log("Regression sanity", reg_ok, " | ".join(reg_details))

    # ===== Summary =====
    print("\n========== SUMMARY ==========")
    passed = sum(1 for _, ok, _ in results if ok)
    failed = sum(1 for _, ok, _ in results if not ok)
    for name, ok, detail in results:
        print(f"[{'PASS' if ok else 'FAIL'}] {name} :: {detail}")
    print(f"\nTotal: {passed} passed, {failed} failed")
    return failed == 0


if __name__ == "__main__":
    try:
        ok = main()
        sys.exit(0 if ok else 1)
    except Exception as e:
        import traceback
        traceback.print_exc()
        sys.exit(2)
