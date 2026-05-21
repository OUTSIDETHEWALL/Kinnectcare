"""Backend tests for Kinnship UX upgrades.

Covers:
  CI-1..CI-9   — Custom check-in modes (fixed time + interval 2/4/6/8/12h)
  T-RBE-1..3   — Regression sanity (timezone, medication scheduler, general endpoints)

Target: https://family-guard-37.preview.emergentagent.com/api
"""
from __future__ import annotations

import json
import random
import string
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Tuple

import httpx

BASE_URL = "https://family-guard-37.preview.emergentagent.com/api"
DEMO_EMAIL = "demo@kinnship.app"
DEMO_PASSWORD = "password123"

results: list[Tuple[str, bool, str]] = []


def record(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    flag = "PASS" if ok else "FAIL"
    print(f"[{flag}] {name}{(' — ' + detail) if detail else ''}")


def auth_header(token: str) -> Dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def rand_email(prefix: str = "ci_test") -> str:
    suffix = "".join(random.choices(string.ascii_lowercase + string.digits, k=8))
    return f"{prefix}_{suffix}@example.com"


def login_demo(client: httpx.Client) -> str:
    r = client.post(f"{BASE_URL}/auth/login", json={"email": DEMO_EMAIL, "password": DEMO_PASSWORD})
    r.raise_for_status()
    return r.json()["access_token"]


def signup_fresh(client: httpx.Client, tz: str = "UTC") -> Tuple[str, Dict[str, Any]]:
    email = rand_email()
    r = client.post(
        f"{BASE_URL}/auth/signup",
        json={"email": email, "password": "password123", "full_name": "QA Tester", "timezone": tz},
    )
    r.raise_for_status()
    data = r.json()
    return data["access_token"], data["user"]


def create_member(client: httpx.Client, token: str, name: str = "QA Senior") -> Dict[str, Any]:
    r = client.post(
        f"{BASE_URL}/members",
        headers=auth_header(token),
        json={"name": name, "age": 72, "phone": "+1-555-0100", "gender": "Male", "role": "senior"},
    )
    r.raise_for_status()
    return r.json()


def get_member(client: httpx.Client, token: str, mid: str) -> Dict[str, Any]:
    r = client.get(f"{BASE_URL}/members/{mid}", headers=auth_header(token))
    r.raise_for_status()
    return r.json()


def parse_iso(s: str) -> datetime:
    dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


# =====================================================================
# CI-1 .. CI-9: Custom Check-in Modes
# =====================================================================

def test_checkin_modes(client: httpx.Client) -> None:
    token, _user = signup_fresh(client)
    h = auth_header(token)
    # Free plan caps members at 2 (signup already seeds 2). Reuse the senior.
    members = client.get(f"{BASE_URL}/members", headers=h).json()
    member = next((m for m in members if m.get("role") == "senior"), members[0])
    mid = member["id"]

    # ----- CI-1: Fixed daily time -----
    r = client.put(
        f"{BASE_URL}/members/{mid}/checkin-settings",
        headers=h,
        json={"daily_checkin_time": "08:30", "checkin_interval_hours": None},
    )
    ok = r.status_code == 200
    if ok:
        m = get_member(client, token, mid)
        ok = (
            m.get("daily_checkin_time") == "08:30"
            and m.get("checkin_interval_hours") is None
            and m.get("checkin_interval_started_at") is None
        )
        detail = "" if ok else f"GET member: {json.dumps(m)}"
    else:
        detail = f"status={r.status_code} body={r.text}"
    record("CI-1 fixed daily time '08:30'", ok, detail)

    # ----- CI-2: Interval mode (4h) -----
    before = datetime.now(timezone.utc)
    r = client.put(
        f"{BASE_URL}/members/{mid}/checkin-settings",
        headers=h,
        json={"daily_checkin_time": None, "checkin_interval_hours": 4},
    )
    after = datetime.now(timezone.utc)
    ok = r.status_code == 200
    detail = ""
    if ok:
        m = get_member(client, token, mid)
        anchor_str = m.get("checkin_interval_started_at")
        ok_fields = (
            m.get("daily_checkin_time") is None
            and m.get("checkin_interval_hours") == 4
            and anchor_str is not None
        )
        ok_anchor = False
        if ok_fields:
            anchor = parse_iso(anchor_str)
            ok_anchor = (before - timedelta(seconds=5)) <= anchor <= (after + timedelta(seconds=5))
        ok = ok_fields and ok_anchor
        if not ok:
            detail = f"GET member: {json.dumps(m)}"
    else:
        detail = f"status={r.status_code} body={r.text}"
    record("CI-2 interval=4 anchor~now", ok, detail)

    # ----- CI-3: Reject both modes at once -----
    r = client.put(
        f"{BASE_URL}/members/{mid}/checkin-settings",
        headers=h,
        json={"daily_checkin_time": "08:30", "checkin_interval_hours": 4},
    )
    ok = r.status_code == 400
    if ok:
        detail_msg = (r.json().get("detail") or "")
        ok = "not both" in detail_msg.lower() or "either" in detail_msg.lower()
        detail = f"detail={detail_msg!r}"
    else:
        detail = f"status={r.status_code} body={r.text}"
    record("CI-3 reject both modes at once (400)", ok, detail)

    # ----- CI-4: Reject invalid interval value -----
    r = client.put(
        f"{BASE_URL}/members/{mid}/checkin-settings",
        headers=h,
        json={"daily_checkin_time": None, "checkin_interval_hours": 5},
    )
    ok = r.status_code == 400
    detail = ""
    if ok:
        detail_msg = str(r.json().get("detail") or "")
        ok = all(str(n) in detail_msg for n in (2, 4, 6, 8, 12))
        detail = f"detail={detail_msg!r}"
    else:
        detail = f"status={r.status_code} body={r.text}"
    record("CI-4 reject interval=5 (400 mentions [2,4,6,8,12])", ok, detail)

    # ----- CI-5: Disable both -----
    r = client.put(
        f"{BASE_URL}/members/{mid}/checkin-settings",
        headers=h,
        json={"daily_checkin_time": None, "checkin_interval_hours": None},
    )
    ok = r.status_code == 200
    if ok:
        m = get_member(client, token, mid)
        ok = (
            m.get("daily_checkin_time") is None
            and m.get("checkin_interval_hours") is None
            and m.get("checkin_interval_started_at") is None
        )
        detail = "" if ok else f"GET member: {json.dumps(m)}"
    else:
        detail = f"status={r.status_code} body={r.text}"
    record("CI-5 disable both (all null)", ok, detail)

    # ----- CI-6: Mode switching cleanup -----
    r1 = client.put(
        f"{BASE_URL}/members/{mid}/checkin-settings",
        headers=h,
        json={"daily_checkin_time": None, "checkin_interval_hours": 6},
    )
    ok1 = r1.status_code == 200
    r2 = client.put(
        f"{BASE_URL}/members/{mid}/checkin-settings",
        headers=h,
        json={"daily_checkin_time": "07:15", "checkin_interval_hours": None},
    )
    ok2 = r2.status_code == 200
    detail = ""
    if ok1 and ok2:
        m = get_member(client, token, mid)
        ok = (
            m.get("daily_checkin_time") == "07:15"
            and m.get("checkin_interval_hours") is None
            and m.get("checkin_interval_started_at") is None
        )
        detail = "" if ok else f"GET member: {json.dumps(m)}"
    else:
        ok = False
        detail = f"interval-put={r1.status_code}/{r1.text}; fixed-put={r2.status_code}/{r2.text}"
    record("CI-6 mode switch interval→fixed cleans anchor", ok, detail)

    # ----- CI-7: General PUT /members/{id} accepts interval & clears fixed -----
    pre = client.put(
        f"{BASE_URL}/members/{mid}/checkin-settings",
        headers=h,
        json={"daily_checkin_time": "09:00", "checkin_interval_hours": None},
    )
    if pre.status_code != 200:
        record("CI-7 general PUT with interval (precondition)", False, f"pre status={pre.status_code} body={pre.text}")
    else:
        before = datetime.now(timezone.utc)
        r = client.put(
            f"{BASE_URL}/members/{mid}",
            headers=h,
            json={"checkin_interval_hours": 2},
        )
        after = datetime.now(timezone.utc)
        ok = r.status_code == 200
        detail = ""
        if ok:
            m = get_member(client, token, mid)
            anchor_str = m.get("checkin_interval_started_at")
            ok_fields = (
                m.get("daily_checkin_time") is None
                and m.get("checkin_interval_hours") == 2
                and anchor_str is not None
            )
            ok_anchor = False
            if ok_fields:
                anchor = parse_iso(anchor_str)
                ok_anchor = (before - timedelta(seconds=5)) <= anchor <= (after + timedelta(seconds=5))
            ok = ok_fields and ok_anchor
            if not ok:
                detail = f"GET member: {json.dumps(m)}"
        else:
            detail = f"status={r.status_code} body={r.text}"
        record("CI-7 general PUT /members/{id} interval=2 clears fixed", ok, detail)

    # ----- CI-8: Reject invalid HH:MM -----
    r = client.put(
        f"{BASE_URL}/members/{mid}/checkin-settings",
        headers=h,
        json={"daily_checkin_time": "25:99", "checkin_interval_hours": None},
    )
    ok = r.status_code == 400
    detail = ""
    if ok:
        detail_msg = str(r.json().get("detail") or "")
        ok = "HH:MM" in detail_msg
        detail = f"detail={detail_msg!r}"
    else:
        detail = f"status={r.status_code} body={r.text}"
    record("CI-8 reject invalid HH:MM '25:99'", ok, detail)

    # ----- CI-9: Interval missed-checkin detection -----
    r = client.put(
        f"{BASE_URL}/members/{mid}/checkin-settings",
        headers=h,
        json={"daily_checkin_time": None, "checkin_interval_hours": 2},
    )
    if r.status_code != 200:
        record("CI-9 interval missed-checkin", False, f"failed to set interval=2: {r.status_code} {r.text}")
        return

    # Standalone PUT to backdate anchor (avoids the auto-reset branch since we don't
    # pass checkin_interval_hours in this update).
    # NOTE: backdating 4h exactly puts the test right on the slot boundary
    # (anchor+slot*2h == now → still inside the 15-min grace). Backdate by 5h
    # to be solidly past the most recent slot's grace window.
    backdated = (datetime.now(timezone.utc) - timedelta(hours=5)).isoformat()
    r_back = client.put(
        f"{BASE_URL}/members/{mid}",
        headers=h,
        json={"checkin_interval_started_at": backdated},
    )
    if r_back.status_code != 200:
        record("CI-9 interval missed-checkin", False, f"BLOCKED — backdate PUT failed: {r_back.status_code} {r_back.text}")
        return

    m = get_member(client, token, mid)
    anchor_after = m.get("checkin_interval_started_at")
    if anchor_after is None:
        record("CI-9 interval missed-checkin", False, "BLOCKED — anchor cleared by backdate update")
        return
    anchor_dt = parse_iso(anchor_after)
    age_hours = (datetime.now(timezone.utc) - anchor_dt).total_seconds() / 3600.0
    if age_hours < 3:
        record(
            "CI-9 interval missed-checkin",
            False,
            f"BLOCKED — anchor not backdated (age={age_hours:.2f}h). m={json.dumps(m)}",
        )
        return

    r1 = client.get(f"{BASE_URL}/alerts", headers=h)
    if r1.status_code != 200:
        record("CI-9 interval missed-checkin", False, f"GET /alerts #1: {r1.status_code} {r1.text}")
        return
    alerts1 = r1.json()
    missed1 = [a for a in alerts1 if a.get("type") == "missed_checkin" and a.get("member_id") == mid]
    if not missed1:
        record(
            "CI-9 interval missed-checkin",
            False,
            f"no missed_checkin alert produced. anchor age={age_hours:.2f}h.",
        )
        return

    count1 = len(missed1)
    r2 = client.get(f"{BASE_URL}/alerts", headers=h)
    alerts2 = r2.json()
    missed2 = [a for a in alerts2 if a.get("type") == "missed_checkin" and a.get("member_id") == mid]
    count2 = len(missed2)
    ok = (count1 >= 1) and (count2 == count1)
    detail = f"first={count1} second={count2}"
    record("CI-9 interval missed-checkin detected & idempotent", ok, detail)


# =====================================================================
# T-RBE-1..3 Regression sanity
# =====================================================================

def test_regression_sanity(client: httpx.Client) -> None:
    token = login_demo(client)
    h = auth_header(token)

    r = client.put(
        f"{BASE_URL}/auth/timezone",
        headers=h,
        json={"timezone": "America/New_York"},
    )
    ok1 = r.status_code == 200
    detail = ""
    if ok1:
        me = client.get(f"{BASE_URL}/auth/me", headers=h).json()
        ok1 = me.get("timezone") == "America/New_York"
        detail = "" if ok1 else f"me={json.dumps(me)}"
    else:
        detail = f"status={r.status_code} body={r.text}"
    record("T-RBE-1 PUT /auth/timezone America/New_York", ok1, detail)
    client.put(f"{BASE_URL}/auth/timezone", headers=h, json={"timezone": "UTC"})

    # ----- T-RBE-2: medication scheduler -----
    tok2, _user2 = signup_fresh(client, tz="UTC")
    h2 = auth_header(tok2)

    r = client.post(
        f"{BASE_URL}/auth/push-token",
        headers=h2,
        json={"token": f"ExponentPushToken[QA_{uuid.uuid4().hex[:10]}]", "platform": "ios"},
    )
    pushed_ok = r.status_code == 200 and r.json().get("ok") is True

    members = client.get(f"{BASE_URL}/members", headers=h2).json()
    senior = next((m for m in members if m.get("role") == "senior"), members[0] if members else None)
    if not senior:
        record("T-RBE-2 medication scheduler", False, "no seed members found")
    else:
        past = datetime.now(timezone.utc) - timedelta(minutes=1)
        slot = past.strftime("%H:%M")
        r = client.post(
            f"{BASE_URL}/reminders",
            headers=h2,
            json={
                "member_id": senior["id"],
                "title": "QA Test Med",
                "category": "medication",
                "dosage": "10mg",
                "times": [{"time": slot, "label": "QA"}],
            },
        )
        if r.status_code != 200:
            record("T-RBE-2 medication scheduler", False, f"create reminder: {r.status_code} {r.text}")
        else:
            r = client.post(f"{BASE_URL}/medications/_tick", headers=h2)
            ok2 = r.status_code == 200
            detail = ""
            if ok2:
                body = r.json()
                fired = body.get("fired_due", 0)
                ok2 = fired >= 1
                detail = f"push_token_ok={pushed_ok} tick body={json.dumps(body)}"
            else:
                detail = f"status={r.status_code} body={r.text}"
            record("T-RBE-2 medication scheduler fired_due>=1", ok2, detail)

    # ----- T-RBE-3: General endpoints still 200 -----
    r = client.post(f"{BASE_URL}/auth/login", json={"email": DEMO_EMAIL, "password": DEMO_PASSWORD})
    ok = r.status_code == 200
    record("T-RBE-3 POST /auth/login (demo)", ok, "" if ok else f"{r.status_code} {r.text}")
    if not ok:
        return
    token = r.json()["access_token"]
    h = auth_header(token)

    for path in ("/family-group", "/members", "/summary", "/billing/status", "/alerts"):
        rr = client.get(f"{BASE_URL}{path}", headers=h)
        record(
            f"T-RBE-3 GET {path}",
            rr.status_code == 200,
            "" if rr.status_code == 200 else f"{rr.status_code} {rr.text[:300]}",
        )

    members = client.get(f"{BASE_URL}/members", headers=h).json()
    if members:
        mid = members[0]["id"]
        rr = client.post(
            f"{BASE_URL}/sos",
            headers=h,
            json={"member_id": mid, "latitude": 1.0, "longitude": 2.0},
        )
        record(
            "T-RBE-3 POST /sos {member_id, lat:1.0, lng:2.0}",
            rr.status_code == 200,
            "" if rr.status_code == 200 else f"{rr.status_code} {rr.text}",
        )
        rr = client.get(f"{BASE_URL}/reminders/member/{mid}", headers=h)
        record(
            "T-RBE-3 GET /reminders/member/{id}",
            rr.status_code == 200,
            "" if rr.status_code == 200 else f"{rr.status_code} {rr.text}",
        )


def main() -> int:
    with httpx.Client(timeout=30.0) as client:
        print("=" * 60)
        print("Custom check-in modes — CI-1..CI-9")
        print("=" * 60)
        test_checkin_modes(client)

        print()
        print("=" * 60)
        print("Regression sanity — T-RBE-1..3")
        print("=" * 60)
        test_regression_sanity(client)

    total = len(results)
    failed = [r for r in results if not r[1]]
    print()
    print("=" * 60)
    print(f"RESULTS: {total - len(failed)}/{total} passed")
    if failed:
        print("FAILED:")
        for n, _, d in failed:
            print(f"  - {n}: {d}")
    print("=" * 60)
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
