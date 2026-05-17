"""Backend tests for Kinnship Twilio SMS integration (MOCK mode).

Reads EXPO_PUBLIC_BACKEND_URL from /app/frontend/.env and exercises:
  1) PUT /api/members/{id} emergency_contact_phone normalization
  2) POST /api/members with emergency_contact_phone
  3) POST /api/sos full SMS fanout (mock mode)
  4) SOS without coords -> "GPS unavailable"
  5) SOS with no EC contacts -> sms_contacts_count==0
  6) SOS dedupes EC numbers across members
  7) SOS push + SMS independence
  8) Regression smoke

Run:  python /app/backend_test.py
"""
from __future__ import annotations
import os
import sys
import time
import uuid
import requests

# ---------------- config ----------------
ENV_FILE = "/app/frontend/.env"
BASE = None
with open(ENV_FILE) as f:
    for line in f:
        if line.startswith("EXPO_PUBLIC_BACKEND_URL"):
            BASE = line.split("=", 1)[1].strip().strip('"').rstrip("/")
            break
assert BASE, "EXPO_PUBLIC_BACKEND_URL not found in .env"
API = f"{BASE}/api"
BACKEND_LOG = "/var/log/supervisor/backend.err.log"
DEMO_EMAIL = "demo@kinnship.app"
DEMO_PASS = "password123"
ELEANOR_ID = "2eaac760-97a1-48d3-9f7e-4155beacd5e3"

results: list[tuple[str, bool, str]] = []


def record(name: str, ok: bool, detail: str = ""):
    status = "PASS" if ok else "FAIL"
    print(f"[{status}] {name}: {detail}")
    results.append((name, ok, detail))


def auth_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def login(email: str, password: str):
    r = requests.post(f"{API}/auth/login", json={"email": email, "password": password}, timeout=20)
    r.raise_for_status()
    data = r.json()
    return data["access_token"], data["user"]


def signup(email: str, password: str, full_name: str):
    r = requests.post(
        f"{API}/auth/signup",
        json={"email": email, "password": password, "full_name": full_name},
        timeout=30,
    )
    r.raise_for_status()
    data = r.json()
    return data["access_token"], data["user"]


def log_position() -> int:
    try:
        return os.path.getsize(BACKEND_LOG)
    except FileNotFoundError:
        return 0


def latest_sms_mock_block_after(start_pos: int) -> str:
    """Return the latest [SMS-MOCK] block (header + 'body:' line) after start_pos."""
    try:
        with open(BACKEND_LOG, "r", errors="ignore") as f:
            f.seek(start_pos)
            chunk = f.read()
    except FileNotFoundError:
        return ""
    blocks = []
    cur = []
    for ln in chunk.splitlines():
        if "[SMS-MOCK]" in ln and "\u2192" in ln:  # → arrow
            if cur:
                blocks.append("\n".join(cur))
                cur = []
            cur.append(ln)
        elif cur:
            cur.append(ln)
    if cur:
        blocks.append("\n".join(cur))
    return blocks[-1] if blocks else ""


def chunk_after(start_pos: int) -> str:
    try:
        with open(BACKEND_LOG, "r", errors="ignore") as f:
            f.seek(start_pos)
            return f.read()
    except FileNotFoundError:
        return ""


# ---------------- TEST 1: PUT /members/{id} EC phone ----------------
def test_put_ec_phone():
    print("\n=== TEST 1: PUT /api/members/{id} emergency_contact_phone ===")
    tok, user = login(DEMO_EMAIL, DEMO_PASS)
    h = auth_headers(tok)
    eid = ELEANOR_ID

    r = requests.get(f"{API}/members/{eid}", headers=h, timeout=15)
    if r.status_code != 200:
        record("1.precheck Eleanor present", False, f"GET /members/{eid} -> {r.status_code} {r.text[:200]}")
        return tok, h
    record("1.precheck Eleanor present", True, f"name={r.json().get('name')}")

    r = requests.put(f"{API}/members/{eid}", headers=h, json={"emergency_contact_phone": "(555) 234-5678"}, timeout=15)
    ok = r.status_code == 200 and r.json().get("emergency_contact_phone") == "+15552345678"
    record("1a parenthesized 10-digit US -> +15552345678", ok,
           f"status={r.status_code} ec={r.json().get('emergency_contact_phone') if r.status_code==200 else r.text[:200]}")

    r = requests.put(f"{API}/members/{eid}", headers=h, json={"emergency_contact_phone": "555.234.5678"}, timeout=15)
    ok = r.status_code == 200 and r.json().get("emergency_contact_phone") == "+15552345678"
    record("1b dotted 10-digit US -> +15552345678", ok,
           f"status={r.status_code} ec={r.json().get('emergency_contact_phone') if r.status_code==200 else r.text[:200]}")

    r = requests.put(f"{API}/members/{eid}", headers=h, json={"emergency_contact_phone": "+447911 123456"}, timeout=15)
    ok = r.status_code == 200 and r.json().get("emergency_contact_phone") == "+447911123456"
    record("1c UK +447911 123456 -> +447911123456", ok,
           f"status={r.status_code} ec={r.json().get('emergency_contact_phone') if r.status_code==200 else r.text[:200]}")

    r = requests.put(f"{API}/members/{eid}", headers=h, json={"emergency_contact_phone": "555-5678"}, timeout=15)
    ok = r.status_code == 400
    record("1d 7-digit too-short -> 400", ok, f"status={r.status_code} body={r.text[:200]}")

    r = requests.put(f"{API}/members/{eid}", headers=h, json={"emergency_contact_phone": ""}, timeout=15)
    ok = r.status_code == 200 and r.json().get("emergency_contact_phone") is None
    record("1e empty string -> 200 and ec is null", ok,
           f"status={r.status_code} ec={r.json().get('emergency_contact_phone') if r.status_code==200 else r.text[:200]}")

    r = requests.put(f"{API}/members/{eid}", headers=h, json={"name": "Eleanor V."}, timeout=15)
    if r.status_code == 200:
        body = r.json()
        ok = body.get("name") == "Eleanor V." and body.get("emergency_contact_phone") is None
        record("1f update name only preserves ec=null", ok,
               f"name={body.get('name')} ec={body.get('emergency_contact_phone')}")
    else:
        record("1f update name only preserves ec=null", False, f"status={r.status_code} body={r.text[:200]}")

    r = requests.put(f"{API}/members/{eid}", headers=h,
                     json={"emergency_contact_phone": "+15552345678", "name": "Eleanor Vance"}, timeout=15)
    if r.status_code == 200:
        body = r.json()
        ok = body.get("name") == "Eleanor Vance" and body.get("emergency_contact_phone") == "+15552345678"
        record("1g restore Eleanor", ok, f"name={body.get('name')} ec={body.get('emergency_contact_phone')}")
    else:
        record("1g restore Eleanor", False, f"status={r.status_code} body={r.text[:200]}")

    rand_id = str(uuid.uuid4())
    r = requests.put(f"{API}/members/{rand_id}", headers=h,
                     json={"emergency_contact_phone": "+15550001111"}, timeout=15)
    body_text = r.text or ""
    try:
        detail = r.json().get("detail") if r.headers.get("content-type", "").startswith("application/json") else body_text
    except Exception:
        detail = body_text
    ok = r.status_code == 404 and "Member not found" in str(detail)
    record("1h random uuid -> 404 Member not found", ok, f"status={r.status_code} body={body_text[:200]}")

    fresh_email = f"sms_xgroup_{uuid.uuid4().hex[:10]}@example.com"
    f_tok, _ = signup(fresh_email, "password123", "X Group User")
    fh = auth_headers(f_tok)
    r = requests.put(f"{API}/members/{eid}", headers=fh,
                     json={"emergency_contact_phone": "+15550001111"}, timeout=15)
    ok = r.status_code == 404
    record("1i cross-group PUT -> 404 (group isolation)", ok, f"status={r.status_code} body={r.text[:200]}")

    return tok, h


# ---------------- TEST 2: POST /members EC phone ----------------
def test_post_member_ec_phone():
    print("\n=== TEST 2: POST /api/members emergency_contact_phone ===")
    fresh_email = f"sms_addmember_{uuid.uuid4().hex[:10]}@example.com"
    tok, _ = signup(fresh_email, "password123", "Add Member User")
    h = auth_headers(tok)

    members = requests.get(f"{API}/members", headers=h, timeout=15).json()
    print(f"   (fresh group has {len(members)} seed members: {[m['name'] for m in members]})")
    # Free plan member_limit=2. We need to make room.
    if len(members) >= 2:
        del_r = requests.delete(f"{API}/members/{members[0]['id']}", headers=h, timeout=15)
        if del_r.status_code != 200:
            record("2.precheck make room (delete seed)", False, f"DELETE -> {del_r.status_code} {del_r.text[:200]}")
            return
        record("2.precheck make room (delete seed)", True, f"deleted={members[0]['name']}")

    body = {"name": "Test Person", "age": 35, "phone": "+15551234567",
            "gender": "Male", "emergency_contact_phone": "(555) 111-2222"}
    r = requests.post(f"{API}/members", headers=h, json=body, timeout=20)
    if r.status_code != 200:
        record("2a POST member with ec phone", False, f"status={r.status_code} body={r.text[:300]}")
        return
    out = r.json()
    ok = out.get("emergency_contact_phone") == "+15551112222"
    record("2a POST /members returns normalized ec='+15551112222'", ok,
           f"ec={out.get('emergency_contact_phone')}")

    r = requests.get(f"{API}/members", headers=h, timeout=15)
    new_m = next((m for m in r.json() if m["id"] == out["id"]), None)
    ok = new_m is not None and new_m.get("emergency_contact_phone") == "+15551112222"
    record("2b GET /members shows new member with normalized ec", ok,
           f"found={bool(new_m)} ec={new_m and new_m.get('emergency_contact_phone')}")


# ---------------- TEST 3: SOS full fanout ----------------
def test_sos_full_fanout(demo_tok: str):
    print("\n=== TEST 3: SOS with Eleanor's EC set (mock mode) ===")
    h = auth_headers(demo_tok)
    requests.put(f"{API}/members/{ELEANOR_ID}", headers=h,
                 json={"emergency_contact_phone": "+15552345678", "name": "Eleanor Vance"}, timeout=15)

    start_pos = log_position()
    payload = {"member_id": ELEANOR_ID, "latitude": 37.7849, "longitude": -122.4094, "fall_detected": True}
    r = requests.post(f"{API}/sos", headers=h, json=payload, timeout=30)
    if r.status_code != 200:
        record("3 POST /sos status 200", False, f"status={r.status_code} body={r.text[:300]}")
        return
    body = r.json()
    record("3 POST /sos status 200", True, f"alert_id={body.get('alert_id')}")

    checks = [
        ("3.sms_mode==mock", body.get("sms_mode") == "mock", str(body.get("sms_mode"))),
        ("3.sms_sent==1", body.get("sms_sent") == 1, str(body.get("sms_sent"))),
        ("3.sms_failed==0", body.get("sms_failed") == 0, str(body.get("sms_failed"))),
        ("3.sms_contacts_count==1", body.get("sms_contacts_count") == 1, str(body.get("sms_contacts_count"))),
        ("3.ok==true", body.get("ok") is True, str(body.get("ok"))),
        ("3.alert_id present", bool(body.get("alert_id")), str(body.get("alert_id"))),
        ("3.timestamp ISO", isinstance(body.get("timestamp"), str) and "T" in body.get("timestamp", ""),
         str(body.get("timestamp"))),
        ("3.member_name=='Eleanor Vance'", body.get("member_name") == "Eleanor Vance",
         str(body.get("member_name"))),
        ("3.triggered_by_name present", bool(body.get("triggered_by_name")),
         str(body.get("triggered_by_name"))),
        ("3.family_group_id present", bool(body.get("family_group_id")),
         str(body.get("family_group_id"))),
        ("3.coordinates dict matches",
         isinstance(body.get("coordinates"), dict)
         and body["coordinates"].get("latitude") == 37.7849
         and body["coordinates"].get("longitude") == -122.4094,
         str(body.get("coordinates"))),
        ("3.devices_notified int", isinstance(body.get("devices_notified"), int),
         str(body.get("devices_notified"))),
        ("3.fall_detected==True", body.get("fall_detected") is True, str(body.get("fall_detected"))),
    ]
    for name, ok, det in checks:
        record(name, ok, det)

    time.sleep(0.5)
    block = latest_sms_mock_block_after(start_pos)
    record("3.log [SMS-MOCK] block exists", bool(block), block[:200])
    record("3.log contains \u2192+15552345678", "\u2192+15552345678" in block, "")
    expected_body_substr = (
        "\U0001f198 KINNSHIP ALERT: Eleanor Vance has triggered an emergency SOS. "
        "Last known location: 37.78490, -122.40940. "
        "Please check on them immediately or call 911."
    )
    record("3.log SMS body matches spec", expected_body_substr in block,
           f"have={block!r}\n want_substr={expected_body_substr!r}")


# ---------------- TEST 4: SOS without coords ----------------
def test_sos_no_coords(demo_tok: str):
    print("\n=== TEST 4: SOS without coords -> 'GPS unavailable' ===")
    h = auth_headers(demo_tok)
    start_pos = log_position()
    r = requests.post(f"{API}/sos", headers=h, json={"member_id": ELEANOR_ID, "fall_detected": False}, timeout=30)
    if r.status_code != 200:
        record("4 POST /sos no-coords 200", False, f"status={r.status_code} body={r.text[:300]}")
        return
    body = r.json()
    record("4 POST /sos no-coords 200", True, "")
    record("4.coordinates is None", body.get("coordinates") is None, str(body.get("coordinates")))
    record("4.sms_mode==mock", body.get("sms_mode") == "mock", str(body.get("sms_mode")))
    record("4.sms_sent==1", body.get("sms_sent") == 1, str(body.get("sms_sent")))
    record("4.sms_contacts_count==1", body.get("sms_contacts_count") == 1, str(body.get("sms_contacts_count")))

    time.sleep(0.5)
    block = latest_sms_mock_block_after(start_pos)
    record("4.log contains 'Last known location: GPS unavailable'",
           "Last known location: GPS unavailable" in block, block[:300])


# ---------------- TEST 5: SOS with no EC contacts ----------------
def test_sos_no_ec():
    print("\n=== TEST 5: SOS with no EC contacts in group ===")
    fresh_email = f"sms_noec_{uuid.uuid4().hex[:10]}@example.com"
    tok, _ = signup(fresh_email, "password123", "NoEC User")
    h = auth_headers(tok)
    members = requests.get(f"{API}/members", headers=h, timeout=15).json()
    any_ec = any(m.get("emergency_contact_phone") for m in members)
    record("5.precheck no seed member has ec phone", not any_ec,
           f"members_with_ec={[m['name'] for m in members if m.get('emergency_contact_phone')]}")

    start_pos = log_position()
    r = requests.post(f"{API}/sos", headers=h, json={"latitude": 1.0, "longitude": 2.0}, timeout=30)
    if r.status_code != 200:
        record("5 POST /sos 200", False, f"status={r.status_code} body={r.text[:300]}")
        return None
    body = r.json()
    record("5 POST /sos 200", True, "")
    record("5.sms_mode==mock", body.get("sms_mode") == "mock", str(body.get("sms_mode")))
    record("5.sms_sent==0", body.get("sms_sent") == 0, str(body.get("sms_sent")))
    record("5.sms_failed==0", body.get("sms_failed") == 0, str(body.get("sms_failed")))
    record("5.sms_contacts_count==0", body.get("sms_contacts_count") == 0,
           str(body.get("sms_contacts_count")))

    time.sleep(0.5)
    block = latest_sms_mock_block_after(start_pos)
    # OK if there is no [SMS-MOCK] block since send_sms_to_many returned [].
    record("5.no [SMS-MOCK] line for this SOS", block == "",
           f"block_first_200={block[:200]}")
    return tok, h, members


# ---------------- TEST 6: SOS dedupe ----------------
def test_sos_dedupe(fresh_tok: str, fresh_h: dict, members: list):
    print("\n=== TEST 6: SOS dedupes EC phones across members ===")
    for m in members:
        r = requests.put(f"{API}/members/{m['id']}", headers=fresh_h,
                         json={"emergency_contact_phone": "+15558881111"}, timeout=15)
        if r.status_code != 200:
            record(f"6.precheck set ec on {m['name']}", False, f"status={r.status_code} body={r.text[:200]}")
            return
    record("6.precheck set ec on both members to +15558881111", True, "")

    start_pos = log_position()
    r = requests.post(f"{API}/sos", headers=fresh_h, json={"latitude": 10.0, "longitude": 20.0}, timeout=30)
    if r.status_code != 200:
        record("6 POST /sos 200", False, f"status={r.status_code} body={r.text[:300]}")
        return
    body = r.json()
    record("6 POST /sos 200", True, "")
    record("6.sms_sent==1 (deduped)", body.get("sms_sent") == 1, f"sms_sent={body.get('sms_sent')}")
    record("6.sms_contacts_count==1 (deduped)",
           body.get("sms_contacts_count") == 1, f"sms_contacts_count={body.get('sms_contacts_count')}")

    time.sleep(0.5)
    chunk = chunk_after(start_pos)
    arrows = chunk.count("\u2192+15558881111")
    record("6.log has exactly one \u2192+15558881111 arrow", arrows == 1,
           f"arrows_count={arrows} chunk_first_300={chunk[:300]}")


# ---------------- TEST 7: Push + SMS ----------------
def test_sos_push_and_sms(demo_tok: str):
    print("\n=== TEST 7: SOS sends push notifications AND SMS ===")
    h = auth_headers(demo_tok)
    rt = requests.post(f"{API}/auth/push-token", headers=h,
                       json={"token": "ExponentPushToken[FAKE_SMS_TEST]", "platform": "ios"}, timeout=15)
    record("7.register fake push token",
           rt.status_code == 200 and (rt.json().get("ok") is True),
           f"status={rt.status_code} body={rt.text[:200]}")

    members = requests.get(f"{API}/members", headers=h, timeout=15).json()
    ec_unique = len({m["emergency_contact_phone"] for m in members if m.get("emergency_contact_phone")})
    print(f"   (demo group has {ec_unique} unique EC numbers; member count={len(members)})")

    r = requests.post(f"{API}/sos", headers=h,
                      json={"member_id": ELEANOR_ID, "latitude": 5.0, "longitude": 6.0}, timeout=30)
    if r.status_code != 200:
        record("7 POST /sos 200", False, f"status={r.status_code} body={r.text[:300]}")
        return
    body = r.json()
    record("7 POST /sos 200", True, "")
    record("7.devices_notified >= 1",
           isinstance(body.get("devices_notified"), int) and body["devices_notified"] >= 1,
           f"devices_notified={body.get('devices_notified')}")
    record("7.sms_sent equals unique EC count in group",
           body.get("sms_sent") == ec_unique,
           f"sms_sent={body.get('sms_sent')} expected={ec_unique}")


# ---------------- TEST 8: Regression ----------------
def test_regression(demo_tok: str):
    print("\n=== TEST 8: Regression sanity ===")
    h = auth_headers(demo_tok)

    r = requests.get(f"{API}/family-group", headers=h, timeout=15)
    ok = r.status_code == 200
    body = r.json() if ok else {}
    record("8.GET /family-group 200", ok, f"status={r.status_code}")
    if ok:
        record("8.family-group has group/members/my_role",
               isinstance(body.get("group"), dict)
               and isinstance(body.get("members"), list)
               and "my_role" in body,
               f"keys={list(body.keys())} my_role={body.get('my_role')}")

    r = requests.get(f"{API}/billing/status", headers=h, timeout=15)
    ok = r.status_code == 200
    body = r.json() if ok else {}
    record("8.GET /billing/status 200", ok, f"status={r.status_code}")
    if ok:
        pp = body.get("paid_plans") or body.get("paid_plan") or {}
        if isinstance(pp, dict) and "month" in pp and "year" in pp:
            record("8.paid_plans has month+year", True, f"keys={list(pp.keys())}")
        else:
            # Fallback: prior contract used a flat paid_plan dict
            record("8.paid_plans has month+year",
                   False,
                   f"actual keys: paid_plans={body.get('paid_plans')} paid_plan={body.get('paid_plan')}")

    r = requests.get(f"{API}/summary", headers=h, timeout=20)
    ok = r.status_code == 200
    body = r.json() if ok else {}
    record("8.GET /summary 200", ok, f"status={r.status_code}")
    if ok:
        members = body.get("members") or []
        compliance_fields = ["medication_total", "medication_taken", "medication_missed",
                             "routine_total", "weekly_compliance_percent"]
        if members:
            present = [f for f in compliance_fields if f in members[0]]
            record("8.summary member has compliance fields",
                   len(present) == len(compliance_fields),
                   f"present={present}")
        else:
            record("8.summary member has compliance fields", False, "no members in summary")

    r = requests.get(f"{API}/alerts", headers=h, timeout=15)
    ok = r.status_code == 200
    body = r.json() if ok else []
    record("8.GET /alerts 200", ok, f"status={r.status_code} count={len(body) if isinstance(body, list) else 0}")
    if ok and body:
        valid_types = {"sos", "missed_checkin", "missed_medication", "health"}
        record("8.alerts first item has valid type",
               body[0].get("type") in valid_types,
               f"first_type={body[0].get('type')}")


def main():
    print(f"Backend: {API}")
    demo_tok, _ = test_put_ec_phone()
    test_post_member_ec_phone()
    test_sos_full_fanout(demo_tok)
    test_sos_no_coords(demo_tok)
    out5 = test_sos_no_ec()
    if isinstance(out5, tuple) and len(out5) == 3:
        fresh_tok, fresh_h, members = out5
        test_sos_dedupe(fresh_tok, fresh_h, members)
    test_sos_push_and_sms(demo_tok)
    test_regression(demo_tok)

    print("\n" + "=" * 60)
    passed = sum(1 for _, ok, _ in results if ok)
    total = len(results)
    print(f"SUMMARY: {passed}/{total} passed")
    failed = [(n, d) for n, ok, d in results if not ok]
    if failed:
        print("FAILED tests:")
        for n, d in failed:
            print(f"  - {n}  ({d[:300]})")
    sys.exit(0 if passed == total else 1)


if __name__ == "__main__":
    main()
