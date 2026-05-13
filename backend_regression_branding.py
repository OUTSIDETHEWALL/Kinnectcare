"""KinnectCare backend regression suite — post-branding refresh.

Validates that the FastAPI backend behavior is intact after a frontend-only
branding update (new logo assets and app.json changes).

Reads EXPO_PUBLIC_BACKEND_URL from /app/frontend/.env and appends /api.
Uses demo credentials from /app/memory/test_credentials.md.
"""
from __future__ import annotations

import os
import sys
import uuid
from pathlib import Path
from typing import Any, Dict

import requests


def _read_backend_base() -> str:
    env_path = Path("/app/frontend/.env")
    base: str = ""
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if line.startswith("EXPO_PUBLIC_BACKEND_URL="):
            base = line.split("=", 1)[1].strip().strip('"').strip("'")
            break
    if not base:
        raise RuntimeError("EXPO_PUBLIC_BACKEND_URL not found in /app/frontend/.env")
    return base.rstrip("/") + "/api"


BASE = _read_backend_base()
DEMO_EMAIL = "demo@kinnectcare.app"
DEMO_PASSWORD = "password123"

results: list[tuple[str, bool, str]] = []


def record(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    status = "PASS" if ok else "FAIL"
    print(f"[{status}] {name} :: {detail}")


def auth_headers(token: str) -> Dict[str, str]:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def main() -> int:
    print(f"BASE = {BASE}")

    # 1) POST /auth/login (demo)
    r = requests.post(
        f"{BASE}/auth/login",
        json={"email": DEMO_EMAIL, "password": DEMO_PASSWORD},
        timeout=20,
    )
    ok = r.status_code == 200 and "access_token" in r.json()
    record(
        "POST /auth/login (demo)",
        ok,
        f"status={r.status_code} user_email={r.json().get('user', {}).get('email') if r.ok else r.text[:120]}",
    )
    if not ok:
        return _finish()
    token = r.json()["access_token"]
    H = auth_headers(token)

    # 2) GET /auth/me
    r = requests.get(f"{BASE}/auth/me", headers=H, timeout=20)
    record(
        "GET /auth/me",
        r.status_code == 200 and r.json().get("email") == DEMO_EMAIL,
        f"status={r.status_code} body={r.text[:120]}",
    )

    # 3) GET /summary
    r = requests.get(f"{BASE}/summary", headers=H, timeout=30)
    summary_ok = False
    summary_detail = f"status={r.status_code}"
    if r.status_code == 200:
        body = r.json()
        members = body.get("members") or []
        required = {
            "member_id",
            "name",
            "role",
            "status",
            "medication_total",
            "medication_taken",
            "medication_missed",
            "routine_total",
            "weekly_compliance_percent",
        }
        if members:
            missing = [
                f for f in required if f not in members[0].keys()
            ]
            summary_ok = not missing
            summary_detail += f" members={len(members)} missing_fields={missing}"
        else:
            summary_detail += " (no members)"
    else:
        summary_detail += f" body={r.text[:160]}"
    record("GET /summary", summary_ok, summary_detail)

    # 4) GET /members
    r = requests.get(f"{BASE}/members", headers=H, timeout=20)
    members_ok = r.status_code == 200 and isinstance(r.json(), list)
    record(
        "GET /members",
        members_ok,
        f"status={r.status_code} count={len(r.json()) if members_ok else 'n/a'}",
    )
    if not members_ok:
        return _finish()

    # 5) POST /members + GET /members/{id}
    new_member_payload = {
        "name": f"Eleanor QA {uuid.uuid4().hex[:6]}",
        "age": 72,
        "phone": "+1-555-0190",
        "gender": "Female",
        "role": "senior",
    }
    r = requests.post(f"{BASE}/members", headers=H, json=new_member_payload, timeout=20)
    create_ok = r.status_code == 200 and "id" in r.json()
    record(
        "POST /members",
        create_ok,
        f"status={r.status_code} name={r.json().get('name') if create_ok else r.text[:120]}",
    )
    if not create_ok:
        return _finish()
    new_member_id: str = r.json()["id"]

    r = requests.get(f"{BASE}/members/{new_member_id}", headers=H, timeout=20)
    record(
        "GET /members/{id}",
        r.status_code == 200 and r.json().get("id") == new_member_id,
        f"status={r.status_code}",
    )

    # 6) POST /reminders (TimeSlot shape) + GET /reminders/member/{id}
    reminder_payload: Dict[str, Any] = {
        "member_id": new_member_id,
        "title": "Vitamin D",
        "dosage": "1000 IU",
        "category": "medication",
        "times": [
            {"time": "07:30", "label": "Morning"},
            {"time": "21:00"},
        ],
    }
    r = requests.post(f"{BASE}/reminders", headers=H, json=reminder_payload, timeout=20)
    rem_ok = r.status_code == 200 and "id" in r.json()
    record(
        "POST /reminders (TimeSlot)",
        rem_ok,
        f"status={r.status_code} times={r.json().get('times') if rem_ok else r.text[:160]}",
    )
    if not rem_ok:
        return _finish()
    reminder_id: str = r.json()["id"]

    r = requests.get(f"{BASE}/reminders/member/{new_member_id}", headers=H, timeout=20)
    list_rem_ok = (
        r.status_code == 200
        and isinstance(r.json(), list)
        and any(x.get("id") == reminder_id for x in r.json())
        and all(isinstance(x.get("times"), list) for x in r.json())
    )
    record(
        "GET /reminders/member/{id}",
        list_rem_ok,
        f"status={r.status_code} count={len(r.json()) if r.status_code == 200 else 'n/a'}",
    )

    # 7) PUT /reminders/{id}
    update_payload = {
        "title": "Vitamin D3",
        "dosage": "2000 IU",
        "times": [{"time": "08:15", "label": "Morning"}],
    }
    r = requests.put(
        f"{BASE}/reminders/{reminder_id}", headers=H, json=update_payload, timeout=20
    )
    put_ok = (
        r.status_code == 200
        and r.json().get("title") == "Vitamin D3"
        and r.json().get("dosage") == "2000 IU"
        and r.json().get("times")
        and r.json()["times"][0]["time"] == "08:15"
    )
    record(
        "PUT /reminders/{id}",
        put_ok,
        f"status={r.status_code} body={r.text[:160]}",
    )

    # 8) POST /reminders/{id}/mark (taken)
    r = requests.post(
        f"{BASE}/reminders/{reminder_id}/mark",
        headers=H,
        json={"status": "taken"},
        timeout=20,
    )
    record(
        "POST /reminders/{id}/mark taken",
        r.status_code == 200 and r.json().get("status") == "taken",
        f"status={r.status_code} body={r.text[:120]}",
    )

    # 9) POST /sos + GET /alerts
    r = requests.post(
        f"{BASE}/sos",
        headers=H,
        json={"latitude": 37.7749, "longitude": -122.4194},
        timeout=20,
    )
    sos_ok = r.status_code == 200 and "alert_id" in r.json()
    record(
        "POST /sos",
        sos_ok,
        f"status={r.status_code} alert_id={r.json().get('alert_id') if sos_ok else r.text[:120]}",
    )
    sos_alert_id = r.json().get("alert_id") if sos_ok else None

    r = requests.get(f"{BASE}/alerts", headers=H, timeout=20)
    alerts_ok = (
        r.status_code == 200
        and isinstance(r.json(), list)
        and (sos_alert_id is None or any(a.get("id") == sos_alert_id for a in r.json()))
    )
    record(
        "GET /alerts",
        alerts_ok,
        f"status={r.status_code} count={len(r.json()) if r.status_code == 200 else 'n/a'} sos_present={any(a.get('id') == sos_alert_id for a in r.json()) if r.status_code == 200 else 'n/a'}",
    )

    # 10) POST /checkins + GET /checkins/recent
    r = requests.post(
        f"{BASE}/checkins",
        headers=H,
        json={
            "member_id": new_member_id,
            "location_name": "Home",
            "latitude": 37.7749,
            "longitude": -122.4194,
        },
        timeout=20,
    )
    ci_ok = r.status_code == 200 and r.json().get("member_id") == new_member_id
    record(
        "POST /checkins",
        ci_ok,
        f"status={r.status_code} body={r.text[:140]}",
    )

    r = requests.get(f"{BASE}/checkins/recent", headers=H, timeout=20)
    recent_ok = r.status_code == 200 and isinstance(r.json(), list)
    record(
        "GET /checkins/recent",
        recent_ok,
        f"status={r.status_code} count={len(r.json()) if recent_ok else 'n/a'}",
    )

    # 11) GET /history/member/{id}?days=7
    r = requests.get(
        f"{BASE}/history/member/{new_member_id}?days=7", headers=H, timeout=20
    )
    hist_ok = (
        r.status_code == 200
        and "series" in r.json()
        and len(r.json()["series"]) == 7
        and "totals" in r.json()
        and "compliance_percent" in r.json()
    )
    record(
        "GET /history/member/{id}?days=7",
        hist_ok,
        f"status={r.status_code} series_len={len(r.json().get('series', [])) if r.status_code == 200 else 'n/a'} compliance={r.json().get('compliance_percent') if r.status_code == 200 else 'n/a'}",
    )

    # Cleanup: remove created member (cascades reminders/checkins/logs).
    requests.delete(f"{BASE}/members/{new_member_id}", headers=H, timeout=20)
    return _finish()


def _finish() -> int:
    print("\n=== SUMMARY ===")
    passed = sum(1 for _, ok, _ in results if ok)
    total = len(results)
    for name, ok, detail in results:
        status = "PASS" if ok else "FAIL"
        print(f"  {status:4s} {name}")
    print(f"\n{passed}/{total} checks passed")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
