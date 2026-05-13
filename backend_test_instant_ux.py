#!/usr/bin/env python3
"""Backend regression after the frontend-only 'instant UX' refactor for KinnectCare.

No backend code changed. We just re-verify:
  - POST /api/sos with coords
  - POST /api/sos without coords
  - POST /api/sos with a senior family member_id
  - POST /api/checkins with lat/lng/location_name
  - POST /api/checkins without lat/lng
  - GET  /api/checkins/recent shows the new checkin
  - Smoke: /auth/login, /auth/me, /summary, /members, /billing/status, /alerts
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime
from pathlib import Path

import requests


# -------- Locate backend base URL from frontend/.env --------
def load_base_url() -> str:
    env_path = Path("/app/frontend/.env")
    base = None
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k in ("EXPO_BACKEND_URL", "EXPO_PUBLIC_BACKEND_URL", "EXPO_PACKAGER_HOSTNAME"):
            if not base:
                base = v
            if k == "EXPO_PUBLIC_BACKEND_URL":
                base = v  # prefer the public one
    if not base:
        raise RuntimeError("Could not resolve backend base URL from /app/frontend/.env")
    return base.rstrip("/") + "/api"


BASE_URL = load_base_url()
DEMO_EMAIL = "demo@kinnectcare.app"
DEMO_PASSWORD = "password123"


# -------- Result tracking --------
PASS_COUNT = 0
FAIL_COUNT = 0
FAILURES: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    global PASS_COUNT, FAIL_COUNT
    if ok:
        PASS_COUNT += 1
        print(f"  ✅ {label}")
    else:
        FAIL_COUNT += 1
        FAILURES.append(f"{label}: {detail}")
        print(f"  ❌ {label} -- {detail}")


def section(title: str) -> None:
    print(f"\n=== {title} ===")


# -------- Helpers --------
def auth_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def is_iso8601(s: str) -> bool:
    try:
        datetime.fromisoformat(s)
        return True
    except Exception:
        return False


def main() -> int:
    print(f"Backend base URL: {BASE_URL}")

    # ---------- Login ----------
    section("Step A — POST /api/auth/login (demo)")
    r = requests.post(
        f"{BASE_URL}/auth/login",
        json={"email": DEMO_EMAIL, "password": DEMO_PASSWORD},
        timeout=30,
    )
    check("status == 200", r.status_code == 200, f"got {r.status_code} body={r.text[:200]}")
    if r.status_code != 200:
        print("FATAL: cannot continue without auth token.")
        return 1
    login_body = r.json()
    token = login_body["access_token"]
    user = login_body["user"]
    check("response has access_token + user.email", bool(token) and user.get("email") == DEMO_EMAIL)

    H = auth_headers(token)

    # ---------- /auth/me ----------
    section("Step B — GET /api/auth/me")
    r = requests.get(f"{BASE_URL}/auth/me", headers=H, timeout=20)
    check("status == 200", r.status_code == 200, f"got {r.status_code}")
    if r.status_code == 200:
        me = r.json()
        check("email matches", me.get("email") == DEMO_EMAIL, f"got {me.get('email')}")

    # ---------- /members ----------
    section("Step C — GET /api/members")
    r = requests.get(f"{BASE_URL}/members", headers=H, timeout=20)
    check("status == 200", r.status_code == 200, f"got {r.status_code}")
    members = r.json() if r.status_code == 200 else []
    check("members list non-empty", isinstance(members, list) and len(members) > 0,
          f"len={len(members) if isinstance(members, list) else 'n/a'}")

    # Find a senior member for SOS test 3
    senior = next((m for m in members if (m.get("role") == "senior" or m.get("age", 0) >= 60)), None)
    if not senior and members:
        senior = members[0]
    senior_id = senior.get("id") if senior else None
    senior_name = senior.get("name") if senior else None
    print(f"  Senior chosen: id={senior_id} name={senior_name} age={senior and senior.get('age')}")

    # Pick any member id for check-in test
    any_member = members[0] if members else None
    any_member_id = any_member.get("id") if any_member else None
    any_member_name = any_member.get("name") if any_member else None

    # ---------- /summary ----------
    section("Step D — GET /api/summary")
    r = requests.get(f"{BASE_URL}/summary", headers=H, timeout=30)
    check("status == 200", r.status_code == 200, f"got {r.status_code} body={r.text[:200]}")
    if r.status_code == 200:
        s = r.json()
        check("summary.members is a list", isinstance(s.get("members"), list))
        if isinstance(s.get("members"), list) and s["members"]:
            m0 = s["members"][0]
            required = {
                "medication_total", "medication_taken", "medication_missed",
                "routine_total", "weekly_compliance_percent",
            }
            missing = required - set(m0.keys())
            check("each member exposes required fields", not missing,
                  f"missing={missing}")

    # ---------- /billing/status ----------
    section("Step E — GET /api/billing/status")
    r = requests.get(f"{BASE_URL}/billing/status", headers=H, timeout=20)
    check("status == 200", r.status_code == 200, f"got {r.status_code} body={r.text[:200]}")
    if r.status_code == 200:
        bs = r.json()
        check("plan field present", "plan" in bs, f"keys={list(bs.keys())}")

    # ---------- Test 1: POST /api/sos WITH coords ----------
    section("Test 1 — POST /api/sos WITH coords (member_id=senior, lat/lng)")
    payload = {
        "member_id": senior_id,
        "latitude": 37.7749,
        "longitude": -122.4194,
    }
    r = requests.post(f"{BASE_URL}/sos", headers=H, json=payload, timeout=30)
    check("status == 200", r.status_code == 200, f"got {r.status_code} body={r.text[:300]}")
    sos1 = r.json() if r.status_code == 200 else {}
    check("ok == True", sos1.get("ok") is True, f"got {sos1.get('ok')}")
    check("timestamp present + ISO8601",
          isinstance(sos1.get("timestamp"), str) and is_iso8601(sos1["timestamp"]),
          f"got {sos1.get('timestamp')}")
    if senior_name:
        check("member_name == senior's name",
              sos1.get("member_name") == senior_name,
              f"expected {senior_name!r} got {sos1.get('member_name')!r}")
    check(
        "coordinates == {latitude:37.7749, longitude:-122.4194}",
        sos1.get("coordinates") == {"latitude": 37.7749, "longitude": -122.4194},
        f"got {sos1.get('coordinates')}",
    )
    check(
        "devices_notified is int",
        isinstance(sos1.get("devices_notified"), int) and sos1["devices_notified"] >= 0,
        f"got {sos1.get('devices_notified')!r}",
    )
    sos1_alert_id = sos1.get("alert_id")

    # ---------- Test 2: POST /api/sos WITHOUT coords ----------
    section("Test 2 — POST /api/sos WITHOUT coords ({})")
    r = requests.post(f"{BASE_URL}/sos", headers=H, json={}, timeout=30)
    check("status == 200", r.status_code == 200, f"got {r.status_code} body={r.text[:300]}")
    sos2 = r.json() if r.status_code == 200 else {}
    check("ok == True", sos2.get("ok") is True, f"got {sos2.get('ok')}")
    check("coordinates == null",
          sos2.get("coordinates") is None,
          f"got {sos2.get('coordinates')!r}")
    check("member_name falls back to user.full_name",
          sos2.get("member_name") == user.get("full_name"),
          f"expected {user.get('full_name')!r} got {sos2.get('member_name')!r}")
    check("alert_id present",
          bool(sos2.get("alert_id")),
          f"got {sos2.get('alert_id')!r}")
    sos2_alert_id = sos2.get("alert_id")

    # ---------- Test 3: POST /api/sos with senior member_id (explicit) ----------
    # Already exercised in Test 1; but per spec, do a third call to firmly verify name.
    section("Test 3 — POST /api/sos again with senior member_id (name verification)")
    r = requests.post(
        f"{BASE_URL}/sos",
        headers=H,
        json={"member_id": senior_id},
        timeout=30,
    )
    check("status == 200", r.status_code == 200, f"got {r.status_code} body={r.text[:300]}")
    sos3 = r.json() if r.status_code == 200 else {}
    if senior_name:
        check("member_name == senior's name",
              sos3.get("member_name") == senior_name,
              f"expected {senior_name!r} got {sos3.get('member_name')!r}")
    check("coordinates == null (none supplied)",
          sos3.get("coordinates") is None,
          f"got {sos3.get('coordinates')!r}")
    sos3_alert_id = sos3.get("alert_id")

    # ---------- /alerts should include the new SOS alerts ----------
    section("Step F — GET /api/alerts (must include the 3 new SOS alerts)")
    r = requests.get(f"{BASE_URL}/alerts", headers=H, timeout=30)
    check("status == 200", r.status_code == 200, f"got {r.status_code}")
    alerts = r.json() if r.status_code == 200 else []
    alert_ids = {a.get("id") for a in alerts if isinstance(a, dict)}
    for label, aid in [
        ("SOS#1 alert present in /alerts", sos1_alert_id),
        ("SOS#2 alert present in /alerts", sos2_alert_id),
        ("SOS#3 alert present in /alerts", sos3_alert_id),
    ]:
        check(label, aid in alert_ids if aid else False,
              f"alert_id={aid} not in returned alerts (count={len(alert_ids)})")
    sos_alerts_typed = [
        a for a in alerts
        if isinstance(a, dict) and a.get("id") in {sos1_alert_id, sos2_alert_id, sos3_alert_id}
    ]
    if sos_alerts_typed:
        check(
            "new SOS alerts have type=sos and severity=critical",
            all(a.get("type") == "sos" and a.get("severity") == "critical" for a in sos_alerts_typed),
            f"sample={sos_alerts_typed[0]}",
        )

    # ---------- Test 4: POST /api/checkins with lat/lng/location_name ----------
    section("Test 4 — POST /api/checkins with lat/lng/location_name")
    ci_payload = {
        "member_id": any_member_id,
        "latitude": 12.97,
        "longitude": 77.59,
        "location_name": "Test",
    }
    r = requests.post(f"{BASE_URL}/checkins", headers=H, json=ci_payload, timeout=30)
    check("status == 200", r.status_code == 200, f"got {r.status_code} body={r.text[:300]}")
    ci1 = r.json() if r.status_code == 200 else {}
    check("response has id", bool(ci1.get("id")), f"got id={ci1.get('id')!r}")
    check("response member_id matches", ci1.get("member_id") == any_member_id)
    check("response latitude == 12.97", ci1.get("latitude") == 12.97, f"got {ci1.get('latitude')}")
    check("response longitude == 77.59", ci1.get("longitude") == 77.59, f"got {ci1.get('longitude')}")
    check("response location_name == 'Test'", ci1.get("location_name") == "Test",
          f"got {ci1.get('location_name')!r}")

    # ---------- GET /api/checkins/recent — should include this checkin ----------
    section("Test 4b — GET /api/checkins/recent (most recent should match)")
    r = requests.get(f"{BASE_URL}/checkins/recent", headers=H, timeout=30)
    check("status == 200", r.status_code == 200, f"got {r.status_code}")
    recent = r.json() if r.status_code == 200 else []
    check("recent is a list", isinstance(recent, list))
    if isinstance(recent, list) and recent:
        # most recent first per backend .sort('created_at', -1)
        top = recent[0]
        check("most recent has location_name='Test'",
              top.get("location_name") == "Test",
              f"got {top.get('location_name')!r}")
        check("most recent has latitude==12.97 and longitude==77.59",
              top.get("latitude") == 12.97 and top.get("longitude") == 77.59,
              f"got lat={top.get('latitude')} lng={top.get('longitude')}")
        check("most recent member_id matches", top.get("member_id") == any_member_id)
    else:
        check("at least one recent checkin returned", False,
              f"recent list empty or wrong type: {type(recent).__name__}")

    # ---------- Test 5: POST /api/checkins WITHOUT lat/lng ----------
    section("Test 5 — POST /api/checkins WITHOUT lat/lng (still records)")
    r = requests.post(
        f"{BASE_URL}/checkins",
        headers=H,
        json={"member_id": any_member_id, "location_name": "Coord-less Test"},
        timeout=30,
    )
    check("status == 200", r.status_code == 200, f"got {r.status_code} body={r.text[:300]}")
    ci2 = r.json() if r.status_code == 200 else {}
    check("response has id", bool(ci2.get("id")), f"got id={ci2.get('id')!r}")
    check("latitude is None", ci2.get("latitude") is None, f"got {ci2.get('latitude')!r}")
    check("longitude is None", ci2.get("longitude") is None, f"got {ci2.get('longitude')!r}")
    check("location_name preserved", ci2.get("location_name") == "Coord-less Test")

    # ---------- Summary ----------
    print("\n" + "=" * 60)
    print(f"TOTAL: passed={PASS_COUNT}  failed={FAIL_COUNT}")
    if FAILURES:
        print("\nFailures:")
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    print("All checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
