"""Kinnship v6.4 focused regression test.

Validates:
  1. Timestamp UTC suffix on Alerts/Members/CheckIns/Reminders.
  2. SOS endpoint returns fast + new fanout_mode/sms_mode fields.
  3. Family escalation window (delta_min=17 → only FAMILY fires).
  4. DUE window 10-min cutoff + gap window 12-min (>10 <15 → nothing).
  5. Cleanup test reminders.
"""
import os
import re
import sys
import time
import json
import uuid
import requests
from datetime import datetime, timedelta, timezone

BASE = "https://family-guard-37.preview.emergentagent.com/api"
EMAIL = "demo@kinnship.app"
PASSWORD = "password123"

PASS = []
FAIL = []


def _ok(name, msg=""):
    PASS.append((name, msg))
    print(f"  PASS  {name}  {msg}")


def _fail(name, msg):
    FAIL.append((name, msg))
    print(f"  FAIL  {name}  {msg}")


def check_iso_utc(ts):
    if ts is None:
        return False, "is None"
    if not isinstance(ts, str):
        return False, f"not a string: {type(ts)}"
    if ts.endswith("+00:00") or ts.endswith("Z"):
        return True, ""
    return False, f"missing UTC suffix: {ts!r}"


def login():
    r = requests.post(f"{BASE}/auth/login", json={"email": EMAIL, "password": PASSWORD}, timeout=15)
    if r.status_code != 200:
        _fail("auth/login", f"status={r.status_code} body={r.text[:300]}")
        sys.exit(1)
    tok = r.json()["access_token"]
    _ok("auth/login", f"token len={len(tok)}")
    return tok


def auth_headers(tok):
    return {"Authorization": f"Bearer {tok}"}


# ---------------- Scenario 1: timestamps ----------------
def test_timestamps(tok):
    print("\n--- Scenario 1: UTC timestamp suffix ---")
    h = auth_headers(tok)

    r = requests.get(f"{BASE}/alerts", headers=h, timeout=15)
    if r.status_code != 200:
        _fail("GET /alerts", f"status={r.status_code}")
    else:
        alerts = r.json()
        bad = []
        for a in alerts:
            ok, msg = check_iso_utc(a.get("created_at"))
            if not ok:
                bad.append((a.get("id"), msg))
        if bad:
            _fail("alerts.created_at UTC suffix", f"{len(bad)}/{len(alerts)} bad. samples={bad[:3]}")
        else:
            _ok("alerts.created_at UTC suffix", f"all {len(alerts)} have +00:00/Z")

    r = requests.get(f"{BASE}/members", headers=h, timeout=15)
    if r.status_code != 200:
        _fail("GET /members", f"status={r.status_code}")
        return []
    members = r.json()
    bad = []
    for m in members:
        for k in ("created_at", "last_seen", "checkin_interval_started_at"):
            v = m.get(k)
            if v is None:
                continue
            ok, msg = check_iso_utc(v)
            if not ok:
                bad.append((m.get("id"), k, msg))
    if bad:
        _fail("members.* UTC suffix", f"bad={bad[:5]}")
    else:
        _ok("members.* UTC suffix", f"{len(members)} members; all dt fields suffixed")

    r = requests.get(f"{BASE}/checkins/recent", headers=h, timeout=15)
    if r.status_code != 200:
        _fail("GET /checkins/recent", f"status={r.status_code}")
    else:
        cis = r.json()
        bad = []
        for c in cis:
            ok, msg = check_iso_utc(c.get("created_at"))
            if not ok:
                bad.append((c.get("id"), msg))
        if bad:
            _fail("checkins.created_at UTC suffix", f"bad={bad[:3]}")
        else:
            _ok("checkins.created_at UTC suffix", f"{len(cis)} entries OK")

    r = requests.get(f"{BASE}/reminders", headers=h, timeout=15)
    if r.status_code != 200:
        _fail("GET /reminders", f"status={r.status_code}")
    else:
        rems = r.json()
        bad = []
        for rem in rems:
            for k in ("created_at", "last_marked_at", "last_refill_at", "run_out_at"):
                v = rem.get(k)
                if v is None:
                    continue
                ok, msg = check_iso_utc(v)
                if not ok:
                    bad.append((rem.get("id"), k, msg))
        if bad:
            _fail("reminders.* UTC suffix", f"bad={bad[:5]}")
        else:
            _ok("reminders.* UTC suffix", f"{len(rems)} reminders OK")

    return members


# ---------------- Scenario 2: SOS ----------------
def test_sos(tok):
    print("\n--- Scenario 2: SOS fast + background fanout ---")
    h = auth_headers(tok)

    t0 = time.perf_counter()
    r = requests.post(
        f"{BASE}/sos",
        headers=h,
        json={"latitude": 33.4, "longitude": -112.0},
        timeout=15,
    )
    elapsed = (time.perf_counter() - t0) * 1000.0
    if r.status_code != 200:
        _fail("POST /sos", f"status={r.status_code} body={r.text[:300]}")
        return None
    body = r.json()
    _ok("POST /sos", f"{elapsed:.0f}ms, alert_id={(body.get('alert_id') or '')[:8]}…")

    if elapsed < 500:
        _ok("SOS <500ms", f"{elapsed:.0f}ms")
    else:
        _fail("SOS <500ms", f"took {elapsed:.0f}ms (>=500ms threshold)")

    if body.get("fanout_mode") == "background":
        _ok("SOS fanout_mode=background", "")
    else:
        _fail("SOS fanout_mode=background", f"got {body.get('fanout_mode')!r}")

    sms_mode = body.get("sms_mode")
    if sms_mode == "mock":
        _ok("SOS sms_mode=mock (MOCKED)", "")
    elif sms_mode == "live":
        _ok("SOS sms_mode=live", "")
    else:
        _fail("SOS sms_mode present", f"got {sms_mode!r}")

    for k in ("devices_notified", "sms_sent"):
        if k in body:
            _fail(f"SOS no {k} field", f"unexpectedly present: {body.get(k)!r}")
        else:
            _ok(f"SOS no {k} field", "removed as expected")

    target_id = body.get("alert_id")
    found = False
    deadline = time.time() + 5.0
    while time.time() < deadline:
        r2 = requests.get(f"{BASE}/alerts", headers=h, timeout=15)
        if r2.status_code == 200:
            for a in r2.json():
                if a["id"] == target_id:
                    found = True
                    break
        if found:
            break
        time.sleep(0.4)
    if found:
        _ok("SOS alert appears <5s", f"alert_id={target_id[:8]}…")
    else:
        _fail("SOS alert appears <5s", f"alert_id {target_id} not seen in GET /alerts")

    return target_id


# ---------------- Helpers ----------------
def create_reminder(tok, member_id, title, delta_min):
    h = auth_headers(tok)
    when = datetime.now(timezone.utc) - timedelta(minutes=delta_min)
    hhmm = when.strftime("%H:%M")
    body = {
        "member_id": member_id,
        "title": title,
        "category": "medication",
        "dosage": "Test 1pill",
        "times": [{"time": hhmm, "label": "TestSlot"}],
    }
    r = requests.post(f"{BASE}/reminders", headers=h, json=body, timeout=15)
    if r.status_code != 200:
        return None, f"create_reminder failed: {r.status_code} {r.text[:200]}"
    return r.json(), None


def tick(tok):
    h = auth_headers(tok)
    r = requests.post(f"{BASE}/medications/_tick", headers=h, timeout=15)
    if r.status_code != 200:
        return None, f"tick failed: {r.status_code} {r.text[:200]}"
    return r.json(), None


def stages_for(tok, rid):
    r = requests.get(f"{BASE}/medications/_stages/{rid}", headers=auth_headers(tok), timeout=15)
    if r.status_code != 200:
        return []
    return [s["stage"] for s in r.json().get("stages", [])]


# ---------------- Scenarios 3 & 4 ----------------
def test_scheduler(tok, members):
    print("\n--- Scenario 3 & 4: scheduler stages ---")
    if not members:
        _fail("scheduler", "no members available")
        return []
    target = members[0]
    member_id = target["id"]
    print(f"  Using member: {target.get('name')} ({member_id[:8]}…)")
    created = []

    # ---- 4a: slot 5 min in past → DUE only
    print("\n  [4a] slot at -5 min: expect fired_due=1, fired_family=0")
    rem, err = create_reminder(tok, member_id, f"KSTest-DUE-{uuid.uuid4().hex[:6]}", 5)
    if err:
        _fail("create DUE rem", err)
    else:
        created.append(rem["id"])
        c, err = tick(tok)
        if err:
            _fail("tick DUE", err)
        else:
            st = stages_for(tok, rem["id"])
            if "due" in st and "family_alert" not in st:
                _ok("4a DUE-only fired", f"stages={st}; tick_counters={c}")
            else:
                _fail("4a DUE-only fired", f"stages={st}; tick_counters={c}")

            c2, _ = tick(tok)
            st2 = stages_for(tok, rem["id"])
            if st2 == st:
                _ok("4a second tick idempotent", f"stages stable={st2}")
            else:
                _fail("4a second tick idempotent", f"before={st} after={st2}; counters={c2}")

    # ---- 4b: slot 12 min in past → nothing (gap)
    print("\n  [4b] slot at -12 min: expect fired_due=0, fired_family=0 (gap)")
    rem, err = create_reminder(tok, member_id, f"KSTest-GAP-{uuid.uuid4().hex[:6]}", 12)
    if err:
        _fail("create GAP rem", err)
    else:
        created.append(rem["id"])
        c, err = tick(tok)
        if err:
            _fail("tick GAP", err)
        else:
            st = stages_for(tok, rem["id"])
            if not st:
                _ok("4b gap → no stage fired", f"tick_counters={c}")
            else:
                _fail("4b gap → no stage fired", f"stages={st}; tick_counters={c}")

    # ---- 3: slot 17 min in past → FAMILY only
    print("\n  [3] slot at -17 min: expect fired_due=0, fired_family_alert=1")
    rem, err = create_reminder(tok, member_id, f"KSTest-FAM-{uuid.uuid4().hex[:6]}", 17)
    if err:
        _fail("create FAM rem", err)
    else:
        created.append(rem["id"])
        c, err = tick(tok)
        if err:
            _fail("tick FAM", err)
        else:
            st = stages_for(tok, rem["id"])
            if "family_alert" in st and "due" not in st:
                _ok("3 family-only fired", f"stages={st}; tick_counters={c}")
            else:
                _fail("3 family-only fired", f"stages={st}; tick_counters={c}")

            c2, _ = tick(tok)
            st2 = stages_for(tok, rem["id"])
            if st2 == st:
                _ok("3 family second tick idempotent", f"stages stable={st2}")
            else:
                _fail("3 family second tick idempotent", f"before={st} after={st2}; counters={c2}")

    return created


# ---------------- Scenario 5 ----------------
def cleanup(tok, reminder_ids):
    print("\n--- Scenario 5: cleanup ---")
    h = auth_headers(tok)
    deleted = 0
    for rid in reminder_ids:
        try:
            r = requests.delete(f"{BASE}/reminders/{rid}", headers=h, timeout=15)
            if r.status_code == 200:
                deleted += 1
        except Exception:
            pass
    if deleted == len(reminder_ids):
        _ok("cleanup", f"{deleted}/{len(reminder_ids)} reminders deleted")
    else:
        _fail("cleanup", f"only {deleted}/{len(reminder_ids)} deleted")


def main():
    print(f"Base URL: {BASE}")
    tok = login()
    members = test_timestamps(tok)
    test_sos(tok)
    rids = test_scheduler(tok, members)
    cleanup(tok, rids)

    print("\n" + "=" * 60)
    print(f"SUMMARY: {len(PASS)} PASS, {len(FAIL)} FAIL")
    for n, m in FAIL:
        print(f"  FAIL: {n}  {m}")
    print("=" * 60)
    return 0 if not FAIL else 1


if __name__ == "__main__":
    sys.exit(main())
