"""Backend tests for Kinnship medication self-alerts with 3-stage escalation.

Tests T1-T8 from /app/test_result.md.
"""
import os
import uuid
import json
import time
import requests
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

BASE = "https://family-guard-37.preview.emergentagent.com/api"

results = []
def record(name, ok, detail=""):
    status = "PASS" if ok else "FAIL"
    print(f"[{status}] {name} :: {detail}"[:500])
    results.append((name, ok, detail))


def auth_headers(token):
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def hhmm_offset(tz_name, minutes_offset):
    """Return HH:MM in the given timezone at (now + minutes_offset minutes)."""
    try:
        tz = ZoneInfo(tz_name or "UTC")
    except Exception:
        tz = ZoneInfo("UTC")
    t = datetime.now(timezone.utc).astimezone(tz) + timedelta(minutes=minutes_offset)
    return f"{t.hour:02d}:{t.minute:02d}"


def main():
    # ---------- Demo login (kept for T1 + T8 regression) ----------
    r = requests.post(f"{BASE}/auth/login", json={
        "email": "demo@kinnship.app", "password": "password123"
    }, timeout=30)
    record("Demo login (T8.1)", r.status_code == 200, f"status={r.status_code}")
    if r.status_code != 200:
        print("Cannot continue without demo login")
        return
    demo_token = r.json()["access_token"]

    # T1) push-token
    r = requests.post(f"{BASE}/auth/push-token",
                      headers=auth_headers(demo_token),
                      json={"token": "ExponentPushToken[FAKE_MED_TEST]"}, timeout=30)
    ok = r.status_code == 200 and r.json().get("ok") is True
    record("T1 POST /auth/push-token returns {ok:true}", ok, f"status={r.status_code} body={r.text[:200]}")

    # T2) Create fresh user
    fresh_email = f"medtick_{uuid.uuid4().hex[:8]}@example.com"
    r = requests.post(f"{BASE}/auth/signup", json={
        "email": fresh_email, "password": "password123",
        "full_name": "Med Tick Tester", "timezone": "UTC",
    }, timeout=30)
    record("T2 Fresh signup", r.status_code == 200, f"status={r.status_code} body={r.text[:300]}")
    if r.status_code != 200:
        return
    fresh_token = r.json()["access_token"]

    r = requests.get(f"{BASE}/auth/me", headers=auth_headers(fresh_token), timeout=30)
    me = r.json() if r.status_code == 200 else {}
    fresh_tz = me.get("timezone") or "UTC"
    record("T2 GET /auth/me for fresh user", r.status_code == 200, f"tz={fresh_tz}")

    # also register a push token for the fresh user (so push_to_user has somewhere to send)
    requests.post(f"{BASE}/auth/push-token",
                  headers=auth_headers(fresh_token),
                  json={"token": "ExponentPushToken[FAKE_MED_FRESH_TEST]"}, timeout=30)

    # Get members (seeded Gregory + James)
    r = requests.get(f"{BASE}/members", headers=auth_headers(fresh_token), timeout=30)
    members = r.json() if r.status_code == 200 else []
    record("T2 GET /members fresh user", r.status_code == 200 and len(members) >= 1,
           f"count={len(members)}, names={[m.get('name') for m in members]}")
    james = next((m for m in members if "james" in (m.get("name", "").lower())), None)
    if not james:
        james = members[0] if members else None
    if not james:
        record("T2 find James", False, "no member to test against")
        return
    james_id = james["id"]

    # ---------- T3) Stage 1 only: slot 1 minute in the past ----------
    slot_t3 = hhmm_offset(fresh_tz, -1)
    r = requests.post(f"{BASE}/reminders", headers=auth_headers(fresh_token), json={
        "member_id": james_id,
        "title": "TickTest1",
        "dosage": "10mg",
        "category": "medication",
        "times": [{"time": slot_t3, "label": None}],
    }, timeout=30)
    record("T3 create medication slot 1 min in past", r.status_code == 200,
           f"status={r.status_code} slot={slot_t3} body={r.text[:200]}")
    if r.status_code != 200:
        return
    rem_t3 = r.json()
    rem_t3_id = rem_t3["id"]

    # tick
    r = requests.post(f"{BASE}/medications/_tick", headers=auth_headers(fresh_token), timeout=120)
    tick_t3 = r.json() if r.status_code == 200 else {}
    record("T3 _tick HTTP 200", r.status_code == 200, f"body={r.text[:400]}")
    record("T3 fired_due >= 1", tick_t3.get("fired_due", 0) >= 1, f"fired_due={tick_t3.get('fired_due')}")
    record("T3 fired_remind_30 == 0", tick_t3.get("fired_remind_30") == 0, f"fired_remind_30={tick_t3.get('fired_remind_30')}")
    record("T3 fired_escalate_2h == 0", tick_t3.get("fired_escalate_2h") == 0, f"fired_escalate_2h={tick_t3.get('fired_escalate_2h')}")

    r = requests.get(f"{BASE}/medications/_stages/{rem_t3_id}", headers=auth_headers(fresh_token), timeout=30)
    stages_t3 = r.json().get("stages", []) if r.status_code == 200 else []
    stages_t3_names = [s.get("stage") for s in stages_t3]
    record("T3 stages endpoint has exactly 1 stage 'due'",
           len(stages_t3) == 1 and stages_t3[0].get("stage") == "due",
           f"stages={stages_t3_names}")

    # ---------- T4) Stage 1+2: slot 35 minutes in the past ----------
    slot_t4 = hhmm_offset(fresh_tz, -35)
    r = requests.post(f"{BASE}/reminders", headers=auth_headers(fresh_token), json={
        "member_id": james_id,
        "title": "TickTest2",
        "dosage": "20mg",
        "category": "medication",
        "times": [{"time": slot_t4, "label": None}],
    }, timeout=30)
    record("T4 create medication slot 35 min in past", r.status_code == 200, f"status={r.status_code} slot={slot_t4}")
    if r.status_code != 200:
        return
    rem_t4_id = r.json()["id"]

    r = requests.post(f"{BASE}/medications/_tick", headers=auth_headers(fresh_token), timeout=120)
    tick_t4 = r.json() if r.status_code == 200 else {}
    record("T4 _tick HTTP 200", r.status_code == 200, f"body={r.text[:400]}")
    record("T4 fired_due >= 1", tick_t4.get("fired_due", 0) >= 1, f"fired_due={tick_t4.get('fired_due')}")
    record("T4 fired_remind_30 >= 1", tick_t4.get("fired_remind_30", 0) >= 1, f"fired_remind_30={tick_t4.get('fired_remind_30')}")
    record("T4 fired_escalate_2h == 0", tick_t4.get("fired_escalate_2h") == 0, f"fired_escalate_2h={tick_t4.get('fired_escalate_2h')}")

    r = requests.get(f"{BASE}/medications/_stages/{rem_t4_id}", headers=auth_headers(fresh_token), timeout=30)
    stages_t4 = r.json().get("stages", []) if r.status_code == 200 else []
    stages_t4_names = sorted([s.get("stage") for s in stages_t4])
    record("T4 stages endpoint has 2 stages (due + remind_30)",
           stages_t4_names == ["due", "remind_30"],
           f"stages={stages_t4_names}")

    # ---------- T5) All 3 stages: slot 130 minutes in the past ----------
    slot_t5 = hhmm_offset(fresh_tz, -130)
    r = requests.post(f"{BASE}/reminders", headers=auth_headers(fresh_token), json={
        "member_id": james_id,
        "title": "TickTest3",
        "dosage": "30mg",
        "category": "medication",
        "times": [{"time": slot_t5, "label": None}],
    }, timeout=30)
    record("T5 create medication slot 130 min in past", r.status_code == 200, f"status={r.status_code} slot={slot_t5}")
    if r.status_code != 200:
        return
    rem_t5_id = r.json()["id"]

    r = requests.post(f"{BASE}/medications/_tick", headers=auth_headers(fresh_token), timeout=120)
    tick_t5 = r.json() if r.status_code == 200 else {}
    record("T5 _tick HTTP 200", r.status_code == 200, f"body={r.text[:400]}")
    record("T5 fired_due >= 1", tick_t5.get("fired_due", 0) >= 1, f"fired_due={tick_t5.get('fired_due')}")
    record("T5 fired_remind_30 >= 1", tick_t5.get("fired_remind_30", 0) >= 1, f"fired_remind_30={tick_t5.get('fired_remind_30')}")
    record("T5 fired_escalate_2h >= 1", tick_t5.get("fired_escalate_2h", 0) >= 1, f"fired_escalate_2h={tick_t5.get('fired_escalate_2h')}")

    r = requests.get(f"{BASE}/alerts", headers=auth_headers(fresh_token), timeout=30)
    alerts = r.json() if r.status_code == 200 else []
    med_esc = [a for a in alerts if a.get("type") == "medication_escalation" and "TickTest3" in (a.get("title") or "")]
    record("T5 GET /alerts has medication_escalation for TickTest3", len(med_esc) >= 1,
           f"found={len(med_esc)} total_alerts={len(alerts)}")
    if med_esc:
        a = med_esc[0]
        record("T5 alert severity=='critical'", a.get("severity") == "critical", f"severity={a.get('severity')}")
        record("T5 alert title contains 'hasn't taken TickTest'",
               "hasn't taken TickTest" in (a.get("title") or ""),
               f"title={a.get('title')}")
        msg = a.get("message") or ""
        record("T5 alert message contains 'after 2 hours' and 'KINNSHIP ALERT'",
               "after 2 hours" in msg and "KINNSHIP ALERT" in msg,
               f"message={msg[:200]}")

    r = requests.get(f"{BASE}/medications/_stages/{rem_t5_id}", headers=auth_headers(fresh_token), timeout=30)
    stages_t5 = r.json().get("stages", []) if r.status_code == 200 else []
    stages_t5_names = sorted([s.get("stage") for s in stages_t5])
    record("T5 stages endpoint has all 3 stages",
           stages_t5_names == ["due", "escalate_2h", "remind_30"],
           f"stages={stages_t5_names}")

    # ---------- T6) Idempotency ----------
    r = requests.post(f"{BASE}/medications/_tick", headers=auth_headers(fresh_token), timeout=120)
    tick_t6 = r.json() if r.status_code == 200 else {}
    record("T6 _tick HTTP 200", r.status_code == 200, f"body={r.text[:400]}")
    record("T6 fired_due == 0 (idempotency)", tick_t6.get("fired_due") == 0, f"fired_due={tick_t6.get('fired_due')}")
    record("T6 fired_remind_30 == 0", tick_t6.get("fired_remind_30") == 0, f"fired_remind_30={tick_t6.get('fired_remind_30')}")
    record("T6 fired_escalate_2h == 0", tick_t6.get("fired_escalate_2h") == 0, f"fired_escalate_2h={tick_t6.get('fired_escalate_2h')}")
    record("T6 scanned_reminders > 0", tick_t6.get("scanned_reminders", 0) > 0, f"scanned={tick_t6.get('scanned_reminders')}")

    r = requests.get(f"{BASE}/medications/_stages/{rem_t5_id}", headers=auth_headers(fresh_token), timeout=30)
    stages_t6 = r.json().get("stages", []) if r.status_code == 200 else []
    record("T6 stages for T5 reminder still exactly 3", len(stages_t6) == 3, f"count={len(stages_t6)}")

    # ---------- T7) Cancel-on-taken ----------
    slot_t7 = hhmm_offset(fresh_tz, -130)
    r = requests.post(f"{BASE}/reminders", headers=auth_headers(fresh_token), json={
        "member_id": james_id,
        "title": "TickTest4",
        "dosage": "40mg",
        "category": "medication",
        "times": [{"time": slot_t7, "label": None}],
    }, timeout=30)
    record("T7 create medication slot 130 min in past", r.status_code == 200, f"status={r.status_code} slot={slot_t7}")
    if r.status_code != 200:
        return
    rem_t7_id = r.json()["id"]

    # Mark taken immediately
    r = requests.post(f"{BASE}/reminders/{rem_t7_id}/mark",
                      headers=auth_headers(fresh_token),
                      json={"status": "taken"}, timeout=30)
    record("T7 mark taken", r.status_code == 200, f"status={r.status_code} body={r.text[:200]}")

    r = requests.post(f"{BASE}/medications/_tick", headers=auth_headers(fresh_token), timeout=120)
    tick_t7 = r.json() if r.status_code == 200 else {}
    record("T7 _tick HTTP 200", r.status_code == 200, f"body={r.text[:400]}")
    record("T7 skipped_taken >= 1", tick_t7.get("skipped_taken", 0) >= 1,
           f"skipped_taken={tick_t7.get('skipped_taken')}")

    r = requests.get(f"{BASE}/medications/_stages/{rem_t7_id}", headers=auth_headers(fresh_token), timeout=30)
    stages_t7 = r.json().get("stages", []) if r.status_code == 200 else []
    record("T7 stages endpoint returns empty for taken reminder",
           len(stages_t7) == 0,
           f"stages={[s.get('stage') for s in stages_t7]}")

    # ---------- T8) Regression on demo user ----------
    r = requests.get(f"{BASE}/family-group", headers=auth_headers(demo_token), timeout=30)
    record("T8 GET /family-group", r.status_code == 200, f"status={r.status_code}")
    r = requests.get(f"{BASE}/members", headers=auth_headers(demo_token), timeout=30)
    demo_members = r.json() if r.status_code == 200 else []
    record("T8 GET /members", r.status_code == 200, f"status={r.status_code} count={len(demo_members)}")
    r = requests.get(f"{BASE}/summary", headers=auth_headers(demo_token), timeout=30)
    record("T8 GET /summary", r.status_code == 200, f"status={r.status_code}")
    r = requests.get(f"{BASE}/billing/status", headers=auth_headers(demo_token), timeout=30)
    record("T8 GET /billing/status", r.status_code == 200, f"status={r.status_code}")
    r = requests.get(f"{BASE}/alerts", headers=auth_headers(demo_token), timeout=30)
    record("T8 GET /alerts", r.status_code == 200,
           f"status={r.status_code} count={len(r.json()) if r.status_code==200 else 'NA'}")

    if demo_members:
        mid = demo_members[0]["id"]
        r = requests.post(f"{BASE}/sos", headers=auth_headers(demo_token),
                          json={"member_id": mid, "latitude": 1.0, "longitude": 2.0}, timeout=30)
        record("T8 POST /sos", r.status_code == 200, f"status={r.status_code} body={r.text[:200]}")
        r = requests.get(f"{BASE}/reminders/member/{mid}", headers=auth_headers(demo_token), timeout=30)
        record("T8 GET /reminders/member/{id}", r.status_code == 200,
               f"status={r.status_code} count={len(r.json()) if r.status_code==200 else 'NA'}")

    # ---------- Summary ----------
    print("\n=== SUMMARY ===")
    passed = sum(1 for _, ok, _ in results if ok)
    print(f"{passed}/{len(results)} checks passed")
    failed = [(n, d) for n, ok, d in results if not ok]
    if failed:
        print("\nFAILURES:")
        for n, d in failed:
            print(f"  - {n} :: {d}")


if __name__ == "__main__":
    main()
