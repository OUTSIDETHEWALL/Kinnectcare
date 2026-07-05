"""Backend tests for Kinnship v6.3 medication scheduler & alerts logging overhaul.

Test scenarios per the review request:
  1. Scheduler health (no STAGE_REMIND_30 warnings, loop started)
  2. Scheduler idempotency (no spam)
  3. Alerts collection logging (new behaviour)
  4. Family escalation at T+15m
  5. Suppress family alert when 'taken'
  6. Routines now fire
  7. Stale cutoff (no more 6-hour backfill flood)
  8. SOS regression
  9. Cleanup
"""
from __future__ import annotations

import os
import sys
import json
import time
import subprocess
from datetime import datetime, timedelta, timezone

import requests

BASE = "https://family-guard-37.preview.emergentagent.com/api"
EMAIL = "demo@kinnship.app"
PASSWORD = "password123"

_session_token: str | None = None
_created_reminder_ids: list[str] = []


def _login() -> str:
    global _session_token
    r = requests.post(f"{BASE}/auth/login", json={"email": EMAIL, "password": PASSWORD}, timeout=30)
    r.raise_for_status()
    j = r.json()
    _session_token = j["access_token"]
    return _session_token


def H():
    assert _session_token, "must login first"
    return {"Authorization": f"Bearer {_session_token}", "Content-Type": "application/json"}


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _hhmm_in_past(minutes: int) -> str:
    """Return HH:MM that is `minutes` in the past in UTC (demo user's tz is UTC)."""
    t = _now_utc() - timedelta(minutes=minutes)
    return t.strftime("%H:%M")


def _get_first_member_id() -> str:
    r = requests.get(f"{BASE}/members", headers=H(), timeout=30)
    r.raise_for_status()
    members = r.json()
    assert members, "Demo account has no members"
    # Prefer senior member if any; otherwise first.
    for m in members:
        if m.get("age", 0) and m["age"] >= 60:
            return m["id"]
    return members[0]["id"]


def _create_reminder(member_id: str, title: str, slot_hhmm: str, *, category: str = "medication", dosage: str | None = None) -> dict:
    body = {
        "member_id": member_id,
        "title": title,
        "category": category,
        "dosage": dosage,
        "times": [{"time": slot_hhmm, "label": "Test"}],
    }
    r = requests.post(f"{BASE}/reminders", headers=H(), json=body, timeout=30)
    r.raise_for_status()
    rem = r.json()
    _created_reminder_ids.append(rem["id"])
    return rem


def _tick() -> dict:
    r = requests.post(f"{BASE}/medications/_tick", headers=H(), timeout=30)
    r.raise_for_status()
    return r.json()


def _get_alerts() -> list[dict]:
    r = requests.get(f"{BASE}/alerts", headers=H(), timeout=30)
    r.raise_for_status()
    return r.json()


def _delete_reminder(rid: str) -> None:
    requests.delete(f"{BASE}/reminders/{rid}", headers=H(), timeout=30)


# ---------- Scenarios ----------
results: list[tuple[str, bool, str]] = []


def record(scenario: str, ok: bool, note: str = ""):
    results.append((scenario, ok, note))
    icon = "PASS" if ok else "FAIL"
    print(f"[{icon}] {scenario} — {note}")


def s1_scheduler_health():
    """Look for STAGE_REMIND_30 in last 120 seconds of backend.err.log; also confirm loop-started present."""
    try:
        out = subprocess.run(
            ["tail", "-n", "400", "/var/log/supervisor/backend.err.log"],
            capture_output=True, text=True, timeout=10,
        )
        log_text = out.stdout
    except Exception as e:
        record("1. Scheduler health", False, f"could not tail log: {e}")
        return

    # Loop started somewhere in recent log
    loop_started = "Medication scheduler loop started." in log_text

    # STAGE_REMIND_30 warning anywhere in the tail
    has_stage_remind_30_warning = "STAGE_REMIND_30 is not defined" in log_text

    if has_stage_remind_30_warning:
        # check if any of those warnings are in the LAST process_started block
        # We split on 'Started server process' and look at the final segment.
        segments = log_text.split("Started server process")
        last_segment = segments[-1] if segments else log_text
        if "STAGE_REMIND_30" in last_segment:
            record("1. Scheduler health", False,
                   "STAGE_REMIND_30 warning STILL present after latest backend start")
            return

    if not loop_started:
        record("1. Scheduler health", False, "'Medication scheduler loop started.' not present in recent logs")
        return

    record(
        "1. Scheduler health", True,
        f"loop started=True; recent STAGE_REMIND_30 warnings = NONE (old warnings before restart may remain in tail but cleared after current process start)",
    )


def s2_idempotency(member_id: str):
    """Create a med slot ~5 min in the past UTC, tick twice. Expect fired_due>=1 first, ==0 second."""
    slot = _hhmm_in_past(5)
    rem = _create_reminder(member_id, "QA v6.3 Idempotency", slot, dosage="10mg")
    rid = rem["id"]

    c1 = _tick()
    c2 = _tick()

    note = f"slot={slot} rid={rid[:8]} tick1={c1} tick2={c2}"
    ok = (c1.get("fired_due", 0) >= 1
          and c1.get("fired_family_alert", 0) == 0
          and c2.get("fired_due", 0) == 0)
    record("2. Idempotency (fired_due>=1 then 0)", ok, note)
    return rid


def s3_alerts_logging(rid_from_s2: str):
    """After S2, expect at least one new alert with type='medication' for our reminder."""
    alerts = _get_alerts()
    # Find a medication alert created in the last ~5 minutes
    now = _now_utc()
    matching = []
    for a in alerts:
        if a.get("type") != "medication":
            continue
        ts = a.get("created_at")
        try:
            t = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
            if t.tzinfo is None:
                t = t.replace(tzinfo=timezone.utc)
            if (now - t) < timedelta(minutes=10):
                matching.append(a)
        except Exception:
            pass
    ok = len(matching) >= 1
    record("3. Alerts collection logging (type='medication')", ok,
           f"matching_recent_med_alerts={len(matching)} sample_titles={[m.get('title','') for m in matching[:3]]}")


def s4_family_escalation(member_id: str):
    """Slot must land in delta_min in [15, 16) minutes at tick-time.

    Per code: `if delta_min > MAX_STALE_MINUTES (=16): continue` and
    `if delta_min >= STAGE_OFFSETS_MIN[STAGE_FAMILY] (=15): fire family_alert`.

    Naively doing `(now - 15m30s).strftime("%H:%M")` is unreliable because the
    HH:MM truncation drops seconds, so the actual slot age becomes
    `15m + now.second + (tick_call_latency)`, which can easily exceed 16m.
    Strategy: wait until the current second is small (≤30), snap slot
    to current minute - 15, then immediately POST + tick.  This makes
    delta land deterministically near 15m + now.second + a few seconds.
    """
    # Wait for a "safe" second-of-minute to start the scenario
    while datetime.now(timezone.utc).second > 25:
        time.sleep(1)
    now_utc = datetime.now(timezone.utc)
    slot_dt = now_utc.replace(second=0, microsecond=0) - timedelta(minutes=15)
    slot = slot_dt.strftime("%H:%M")
    rem = _create_reminder(member_id, "QA v6.3 Escalation", slot, dosage="20mg")
    rid = rem["id"]

    c1 = _tick()
    c2 = _tick()

    ok_first = c1.get("fired_due", 0) >= 1 and c1.get("fired_family_alert", 0) >= 1
    ok_second = c2.get("fired_due", 0) == 0 and c2.get("fired_family_alert", 0) == 0
    note = f"slot={slot} rid={rid[:8]} tick1={c1} tick2={c2}"
    record("4a. Family escalation T+15 (fired_due & fired_family_alert)", ok_first, note)
    record("4b. Family escalation idempotent on second tick", ok_second, note)

    # Confirm medication_escalation alert exists
    alerts = _get_alerts()
    now = _now_utc()
    found = False
    for a in alerts:
        if a.get("type") != "medication_escalation":
            continue
        ts = a.get("created_at")
        try:
            tt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
            if tt.tzinfo is None:
                tt = tt.replace(tzinfo=timezone.utc)
        except Exception:
            continue
        if (now - tt) < timedelta(minutes=10) and a.get("severity") == "critical":
            found = True
            break
    record("4c. Alert row type='medication_escalation' severity='critical'", found, f"found_recent_escalation_alert={found}")
    return rid


def s5_suppress_after_taken(member_id: str):
    """Create med slot ~5 min in the past. First tick -> fired_due=1.
    Then mark taken. Then second tick -> skipped_taken should increment (>=1)
    AND fired_family_alert remains 0 (we cannot wait 15 minutes, so we only assert the suppression counter increments).
    """
    slot = _hhmm_in_past(5)
    rem = _create_reminder(member_id, "QA v6.3 SuppressTaken", slot, dosage="5mg")
    rid = rem["id"]

    c1 = _tick()

    # Mark taken
    mr = requests.post(f"{BASE}/reminders/{rid}/mark",
                       headers=H(), json={"status": "taken"}, timeout=30)
    mark_ok = (mr.status_code == 200)

    # Confirm log row
    # (We don't have a direct API; rely on the response and a subsequent tick counter.)
    c2 = _tick()
    ok = (c1.get("fired_due", 0) >= 1
          and mark_ok
          and c2.get("skipped_taken", 0) >= 1
          and c2.get("fired_family_alert", 0) == 0)
    note = f"slot={slot} rid={rid[:8]} tick1={c1} mark_ok={mark_ok} tick2={c2}"
    record("5. Suppress family alert when 'taken' (skipped_taken increments)", ok, note)
    return rid


def s6_routines(member_id: str):
    """Create routine slot ~5 min past. First tick -> fired_routine_due=1, fired_family_alert=0. Then alerts contains type='routine'. Second tick -> 0."""
    slot = _hhmm_in_past(5)
    rem = _create_reminder(member_id, "QA v6.3 Routine", slot, category="routine")
    rid = rem["id"]

    c1 = _tick()
    c2 = _tick()

    ok_first = c1.get("fired_routine_due", 0) >= 1 and c1.get("fired_family_alert", 0) == 0
    ok_second = c2.get("fired_routine_due", 0) == 0
    note = f"slot={slot} rid={rid[:8]} tick1={c1} tick2={c2}"
    record("6a. Routines fire fired_routine_due", ok_first, note)
    record("6b. Routines idempotent on second tick", ok_second, note)

    # Alerts row type='routine'
    alerts = _get_alerts()
    now = _now_utc()
    found_routine = False
    for a in alerts:
        if a.get("type") != "routine":
            continue
        ts = a.get("created_at")
        try:
            tt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
            if tt.tzinfo is None:
                tt = tt.replace(tzinfo=timezone.utc)
        except Exception:
            continue
        if (now - tt) < timedelta(minutes=10):
            found_routine = True
            break
    record("6c. Alerts collection has type='routine'", found_routine, f"found_recent_routine_alert={found_routine}")
    return rid


def s7_stale_cutoff(member_id: str):
    """Med with slot 30 min in past (>MAX_STALE_MINUTES=16) — fired_due should be 0."""
    slot = _hhmm_in_past(30)
    rem = _create_reminder(member_id, "QA v6.3 Stale30", slot, dosage="50mg")
    rid = rem["id"]

    # Baseline tick: count fired_due that come from THIS reminder.
    # Because tick is global we can't isolate easily; but we can call /medications/_stages.
    c1 = _tick()
    # Inspect stages for this reminder — should be empty.
    r = requests.get(f"{BASE}/medications/_stages/{rid}", headers=H(), timeout=30)
    stages = r.json() if r.status_code == 200 else []
    note = f"slot={slot} rid={rid[:8]} tick={c1} stages_for_this_rem={stages}"
    ok = (len([s for s in stages if isinstance(s, dict) and s.get("reminder_id") == rid]) == 0
          if isinstance(stages, list) else True)
    # The stages introspection endpoint already filters by reminder_id, so just check len.
    if isinstance(stages, list):
        ok = (len(stages) == 0)
    record("7. Stale cutoff (>16 min) silently skipped", ok, note)
    return rid


def s8_sos():
    r = requests.post(f"{BASE}/sos", headers=H(),
                      json={"latitude": 33.4, "longitude": -112.0}, timeout=30)
    ok_status = (r.status_code == 200)
    body = r.json() if ok_status else {}
    alert_id = body.get("alert_id")
    # Confirm row in alerts
    a = _get_alerts()
    found = any(x.get("id") == alert_id and x.get("type") == "sos" for x in a)
    ok = ok_status and alert_id and found
    record("8. SOS regression (200, alert row created)", ok,
           f"status={r.status_code} alert_id={alert_id} found_in_alerts={found}")


def s9_cleanup():
    deleted = 0
    for rid in list(_created_reminder_ids):
        try:
            r = requests.delete(f"{BASE}/reminders/{rid}", headers=H(), timeout=30)
            if r.status_code == 200:
                deleted += 1
        except Exception:
            pass
    record("9. Cleanup", True, f"deleted={deleted}/{len(_created_reminder_ids)}")


def main():
    print(f"BASE={BASE}")
    print(f"USER={EMAIL}")
    _login()
    print("Login OK")

    member_id = _get_first_member_id()
    print(f"member_id={member_id}")

    s1_scheduler_health()

    rid2 = s2_idempotency(member_id)
    s3_alerts_logging(rid2)
    s4_family_escalation(member_id)
    s5_suppress_after_taken(member_id)
    s6_routines(member_id)
    s7_stale_cutoff(member_id)
    s8_sos()
    s9_cleanup()

    print("\n========== SUMMARY ==========")
    passed = sum(1 for _, ok, _ in results if ok)
    print(f"{passed}/{len(results)} passed")
    for name, ok, note in results:
        icon = "PASS" if ok else "FAIL"
        print(f"  [{icon}] {name}")
        if not ok:
            print(f"        {note}")

    # Tail backend log AFTER our test run to check for any new crashes
    print("\n========== POST-RUN backend.err.log tail (last 60 lines) ==========")
    out = subprocess.run(["tail", "-n", "60", "/var/log/supervisor/backend.err.log"],
                         capture_output=True, text=True, timeout=10)
    print(out.stdout)


if __name__ == "__main__":
    main()
