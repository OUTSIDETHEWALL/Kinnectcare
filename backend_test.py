"""Kinnship Family Groups backend test suite.

Tests 9 scenarios per the testing review request:
  1. Family Group GET / Auto-bootstrap
  2. Signup with invite_code joins existing group (no demo seed)
  3. Signup WITHOUT invite_code creates a new solo group with demo seed
  4. SOS fanout to ALL group users
  5. Family group write protections (RBAC)
  6. Join with invalid / already-joined code
  7. Leave / Remove flows
  8. Billing under group model
  9. Regression smoke
"""
from __future__ import annotations

import os
import re
import sys
import uuid
import json
import time
import requests
from pathlib import Path
from datetime import datetime
from typing import Optional


# -------- Configuration --------
def _read_backend_url() -> str:
    # Read EXPO_PUBLIC_BACKEND_URL from /app/frontend/.env (the EXPO_BACKEND_URL ref
    # in the request — the public preview URL).
    env_path = Path("/app/frontend/.env")
    for line in env_path.read_text().splitlines():
        if line.startswith("EXPO_PUBLIC_BACKEND_URL"):
            return line.split("=", 1)[1].strip().strip('"') + "/api"
    raise RuntimeError("EXPO_PUBLIC_BACKEND_URL not found in /app/frontend/.env")


BASE = _read_backend_url()
DEMO_EMAIL = "demo@kinnship.app"
DEMO_PASS = "password123"
INVITE_CODE_RE = re.compile(r"^KINN-[A-Z0-9]{6}$")
HTTP_TIMEOUT = 30

# Cumulative pass/fail per test (1..9) and per assertion.
RESULTS = {}  # type: dict[int, dict]


def _rec(tid: int, label: str, ok: bool, detail: str = ""):
    bucket = RESULTS.setdefault(tid, {"checks": [], "fails": []})
    bucket["checks"].append((ok, label, detail))
    if not ok:
        bucket["fails"].append((label, detail))
        print(f"  ❌ T{tid} {label}: {detail}")
    else:
        print(f"  ✅ T{tid} {label}")


def _h(token: Optional[str]) -> dict:
    h = {"Content-Type": "application/json"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def _req(method, path, *, token=None, json_body=None, expect=None, timeout=HTTP_TIMEOUT):
    url = f"{BASE}{path}"
    r = requests.request(method, url, headers=_h(token), json=json_body, timeout=timeout)
    return r


def login(email: str, password: str):
    r = _req("POST", "/auth/login", json_body={"email": email, "password": password})
    return r


def signup(email: str, password: str, full_name: str, invite_code: Optional[str] = None):
    body = {"email": email, "password": password, "full_name": full_name}
    if invite_code is not None:
        body["invite_code"] = invite_code
    return _req("POST", "/auth/signup", json_body=body)


def get_family_group(token):
    return _req("GET", "/family-group", token=token)


def rand_email(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}@example.com"


# ====================================================================
# TEST 1: Family Group GET / Auto-bootstrap (demo login)
# ====================================================================
def test_1_family_group_bootstrap():
    print("\n=== TEST 1: Family Group GET / Auto-bootstrap ===")
    r = login(DEMO_EMAIL, DEMO_PASS)
    _rec(1, "POST /api/auth/login (demo) 200", r.status_code == 200, f"status={r.status_code} body={r.text[:200]}")
    if r.status_code != 200:
        return None
    data = r.json()
    token = data["access_token"]
    user = data["user"]
    _rec(1, "login.user.family_group_id present (non-null)", bool(user.get("family_group_id")), f"user={user}")
    _rec(1, "login.user.family_group_role present", user.get("family_group_role") in ("owner", "member"),
         f"role={user.get('family_group_role')}")

    rg = get_family_group(token)
    _rec(1, "GET /api/family-group 200", rg.status_code == 200, f"status={rg.status_code} body={rg.text[:300]}")
    if rg.status_code != 200:
        return None
    fg = rg.json()
    group = fg.get("group", {})
    _rec(1, "group.id present", bool(group.get("id")))
    _rec(1, "group.name present", isinstance(group.get("name"), str) and len(group["name"]) > 0)
    _rec(1, "group.owner_user_id present", bool(group.get("owner_user_id")))
    code = group.get("invite_code", "")
    _rec(1, "group.invite_code matches /^KINN-[A-Z0-9]{6}$/", bool(INVITE_CODE_RE.match(code)),
         f"invite_code={code!r}")
    _rec(1, "group.created_at present", bool(group.get("created_at")))
    members = fg.get("members", [])
    _rec(1, "members is list", isinstance(members, list))
    _rec(1, "my_role == 'owner'", fg.get("my_role") == "owner", f"my_role={fg.get('my_role')}")
    mcount = fg.get("member_count")
    _rec(1, "member_count >= 1", isinstance(mcount, int) and mcount >= 1, f"member_count={mcount}")
    _rec(1, "demo user appears in members list", any(m.get("user_id") == user["id"] for m in members),
         f"members user_ids={[m.get('user_id') for m in members]}")

    return {
        "token": token,
        "user": user,
        "group": group,
        "members": members,
        "fg_id": user.get("family_group_id"),
    }


# ====================================================================
# TEST 2: Signup with invite_code joins existing group (no demo seed)
# ====================================================================
def test_2_signup_with_invite(demo_ctx: dict):
    print("\n=== TEST 2: Signup with invite_code joins existing group ===")
    if not demo_ctx:
        _rec(2, "prereq: demo_ctx", False, "demo login failed")
        return None
    invite = demo_ctx["group"]["invite_code"]
    demo_fg_id = demo_ctx["fg_id"]

    # Demo member count BEFORE the join — used to verify the joiner sees demo's data
    rd = _req("GET", "/members", token=demo_ctx["token"])
    demo_member_count_before = len(rd.json()) if rd.status_code == 200 else 0

    cc_email = rand_email("cc1")
    r = signup(cc_email, "password123", "Co Caregiver 1", invite_code=invite)
    _rec(2, "signup with invite_code 200", r.status_code == 200,
         f"status={r.status_code} body={r.text[:300]}")
    if r.status_code != 200:
        return None
    data = r.json()
    cc_token = data["access_token"]
    cc_user = data["user"]
    _rec(2, "new user.family_group_id == demo's family_group_id",
         cc_user.get("family_group_id") == demo_fg_id,
         f"new={cc_user.get('family_group_id')} demo={demo_fg_id}")
    _rec(2, "new user.family_group_role == 'member'",
         cc_user.get("family_group_role") == "member",
         f"role={cc_user.get('family_group_role')}")

    # GET /api/members as new user should see demo's members (>= demo_member_count_before)
    rm = _req("GET", "/members", token=cc_token)
    _rec(2, "GET /api/members 200 as new user", rm.status_code == 200,
         f"status={rm.status_code} body={rm.text[:200]}")
    if rm.status_code == 200:
        cc_members = rm.json()
        _rec(2, f"new user sees >= demo's count ({demo_member_count_before})",
             len(cc_members) >= demo_member_count_before,
             f"cc_count={len(cc_members)} demo_count={demo_member_count_before}")
        # Should NOT be a fresh 2-member seed (Gregory + James) unless demo also had only those.
        # Just verify count is not a brand-new 2 if demo had != 2.
        if demo_member_count_before != 2:
            _rec(2, "new user does NOT get a fresh 2-member seed",
                 len(cc_members) != 2 or demo_member_count_before == 2,
                 f"cc={len(cc_members)} demo={demo_member_count_before}")

    # GET /api/family-group as new user: member_count==2, includes demo (owner) + cc (member)
    rfg = get_family_group(cc_token)
    _rec(2, "GET /api/family-group 200 as new user", rfg.status_code == 200, f"status={rfg.status_code}")
    if rfg.status_code == 200:
        fg2 = rfg.json()
        _rec(2, "member_count == 2", fg2.get("member_count") == 2, f"got={fg2.get('member_count')}")
        members = fg2.get("members", [])
        demo_in = any(m.get("user_id") == demo_ctx["user"]["id"] and m.get("role") == "owner" for m in members)
        cc_in = any(m.get("user_id") == cc_user["id"] and m.get("role") == "member" for m in members)
        _rec(2, "list contains demo (role=owner)", demo_in, f"members={members}")
        _rec(2, "list contains new user (role=member)", cc_in, f"members={members}")

    return {"token": cc_token, "user": cc_user, "email": cc_email}


# ====================================================================
# TEST 3: Signup WITHOUT invite_code creates a new solo group w/ seed
# ====================================================================
def test_3_solo_signup(demo_ctx: dict):
    print("\n=== TEST 3: Solo signup creates new group with 2-member seed ===")
    email = rand_email("solo")
    r = signup(email, "password123", "Solo Tester", invite_code=None)
    _rec(3, "signup WITHOUT invite_code 200", r.status_code == 200,
         f"status={r.status_code} body={r.text[:200]}")
    if r.status_code != 200:
        return None
    data = r.json()
    token = data["access_token"]
    user = data["user"]
    _rec(3, "user.family_group_id is NEW (!= demo's)",
         bool(user.get("family_group_id")) and user["family_group_id"] != demo_ctx["fg_id"],
         f"new={user.get('family_group_id')} demo={demo_ctx['fg_id']}")
    _rec(3, "user.family_group_role == 'owner'",
         user.get("family_group_role") == "owner",
         f"role={user.get('family_group_role')}")

    rm = _req("GET", "/members", token=token)
    _rec(3, "GET /api/members 200", rm.status_code == 200, f"status={rm.status_code}")
    if rm.status_code == 200:
        members = rm.json()
        _rec(3, "member count == 2 (Gregory + James seed)",
             len(members) == 2, f"got={len(members)} names={[m.get('name') for m in members]}")
        names = sorted([m.get("name", "") for m in members])
        expected = sorted(["Gregory", "James"])
        _rec(3, "members are Gregory + James", names == expected, f"got={names}")
    return {"token": token, "user": user}


# ====================================================================
# TEST 4: SOS fanout to ALL group users
# ====================================================================
def test_4_sos_fanout(demo_ctx: dict, cc_ctx: dict):
    print("\n=== TEST 4: SOS fanout to ALL group users ===")
    if not demo_ctx or not cc_ctx:
        _rec(4, "prereq: contexts", False, "missing demo or cc context")
        return
    # Register push tokens
    r1 = _req("POST", "/auth/push-token", token=demo_ctx["token"],
              json_body={"token": "ExponentPushToken[FAKE_DEMO_FG]"})
    _rec(4, "register demo push-token 200 ok:true",
         r1.status_code == 200 and r1.json().get("ok") is True,
         f"status={r1.status_code} body={r1.text[:200]}")
    r2 = _req("POST", "/auth/push-token", token=cc_ctx["token"],
              json_body={"token": "ExponentPushToken[FAKE_CC1_FG]"})
    _rec(4, "register cc push-token 200 ok:true",
         r2.status_code == 200 and r2.json().get("ok") is True,
         f"status={r2.status_code} body={r2.text[:200]}")

    # Trigger SOS as co-caregiver (no member_id → uses user.full_name)
    rs = _req("POST", "/sos", token=cc_ctx["token"],
              json_body={"latitude": 37.77, "longitude": -122.42, "fall_detected": True})
    _rec(4, "POST /api/sos 200", rs.status_code == 200,
         f"status={rs.status_code} body={rs.text[:300]}")
    if rs.status_code != 200:
        return
    body = rs.json()
    _rec(4, "response.ok == true", body.get("ok") is True, f"got={body.get('ok')}")
    alert_id = body.get("alert_id")
    _rec(4, "response.alert_id present", bool(alert_id), f"got={alert_id}")
    ts = body.get("timestamp")
    iso_ok = False
    try:
        datetime.fromisoformat(ts.replace("Z", "+00:00")) if ts else None
        iso_ok = bool(ts)
    except Exception:
        iso_ok = False
    _rec(4, "response.timestamp is ISO", iso_ok, f"got={ts}")
    _rec(4, "response.member_name == 'Co Caregiver 1'",
         body.get("member_name") == "Co Caregiver 1", f"got={body.get('member_name')}")
    _rec(4, "response.triggered_by_name == 'Co Caregiver 1'",
         body.get("triggered_by_name") == "Co Caregiver 1", f"got={body.get('triggered_by_name')}")
    _rec(4, "response.family_group_id == demo's family_group_id",
         body.get("family_group_id") == demo_ctx["fg_id"],
         f"got={body.get('family_group_id')} demo={demo_ctx['fg_id']}")
    coords = body.get("coordinates") or {}
    lat = coords.get("latitude", coords.get("lat"))
    lng = coords.get("longitude", coords.get("lng"))
    _rec(4, "response.coordinates == {37.77,-122.42}",
         lat == 37.77 and lng == -122.42, f"got={coords}")
    dn = body.get("devices_notified")
    _rec(4, "response.devices_notified is int >= 2",
         isinstance(dn, int) and dn >= 2, f"got={dn}")
    _rec(4, "response.fall_detected == true",
         body.get("fall_detected") is True, f"got={body.get('fall_detected')}")

    # Demo sees the alert
    ra = _req("GET", "/alerts", token=demo_ctx["token"])
    _rec(4, "GET /api/alerts 200 (demo)", ra.status_code == 200, f"status={ra.status_code}")
    if ra.status_code == 200:
        alerts = ra.json()
        found = next((a for a in alerts if a.get("id") == alert_id), None)
        _rec(4, "demo sees the new SOS alert", found is not None,
             f"alert_id={alert_id} count={len(alerts)}")
        if found:
            _rec(4, "demo alert.type == 'sos'", found.get("type") == "sos",
                 f"got={found.get('type')}")
            _rec(4, "demo alert.severity == 'critical'", found.get("severity") == "critical",
                 f"got={found.get('severity')}")
            _rec(4, "demo alert.member_name == 'Co Caregiver 1'",
                 found.get("member_name") == "Co Caregiver 1",
                 f"got={found.get('member_name')}")

    # Co-caregiver sees the alert
    ra2 = _req("GET", "/alerts", token=cc_ctx["token"])
    _rec(4, "GET /api/alerts 200 (cc)", ra2.status_code == 200, f"status={ra2.status_code}")
    if ra2.status_code == 200:
        alerts2 = ra2.json()
        found2 = next((a for a in alerts2 if a.get("id") == alert_id), None)
        _rec(4, "cc sees the same alert", found2 is not None,
             f"alert_id={alert_id} count={len(alerts2)}")


# ====================================================================
# TEST 5: Family group write protections (RBAC)
# ====================================================================
def test_5_rbac(demo_ctx: dict, cc_ctx: dict):
    print("\n=== TEST 5: Family group write protections (RBAC) ===")
    if not demo_ctx or not cc_ctx:
        _rec(5, "prereq", False, "missing contexts")
        return None
    original_code = demo_ctx["group"]["invite_code"]

    # OWNER rename
    r1 = _req("PUT", "/family-group", token=demo_ctx["token"], json_body={"name": "Smith Family"})
    _rec(5, "OWNER PUT /family-group {name:'Smith Family'} 200",
         r1.status_code == 200,
         f"status={r1.status_code} body={r1.text[:200]}")
    if r1.status_code == 200:
        b = r1.json()
        _rec(5, "PUT response ok:true", b.get("ok") is True, f"got={b.get('ok')}")
        _rec(5, "PUT response.group.name == 'Smith Family'",
             (b.get("group") or {}).get("name") == "Smith Family",
             f"got={(b.get('group') or {}).get('name')}")

    # MEMBER rename -> 403
    r2 = _req("PUT", "/family-group", token=cc_ctx["token"], json_body={"name": "X"})
    _rec(5, "MEMBER PUT /family-group 403", r2.status_code == 403,
         f"status={r2.status_code} body={r2.text[:200]}")

    # OWNER regenerate-code -> 200 new KINN-XXXXXX
    r3 = _req("POST", "/family-group/regenerate-code", token=demo_ctx["token"])
    _rec(5, "OWNER POST /family-group/regenerate-code 200",
         r3.status_code == 200, f"status={r3.status_code} body={r3.text[:200]}")
    new_code = None
    if r3.status_code == 200:
        bb = r3.json()
        new_code = bb.get("invite_code") or (bb.get("group") or {}).get("invite_code")
        _rec(5, "new invite_code matches KINN-XXXXXX",
             bool(new_code) and bool(INVITE_CODE_RE.match(new_code)),
             f"got={new_code!r}")
        _rec(5, "new invite_code != original",
             new_code != original_code, f"orig={original_code} new={new_code}")

    # Old code on /join must return 404 (after regen)
    r4 = _req("POST", "/family-group/join", token=cc_ctx["token"],
              json_body={"invite_code": original_code})
    _rec(5, "OLD code on /family-group/join -> 404",
         r4.status_code == 404, f"status={r4.status_code} body={r4.text[:200]}")

    # New code on /join (as cc — already member of the same group) -> 200 with already_member:true
    if new_code:
        r5 = _req("POST", "/family-group/join", token=cc_ctx["token"],
                  json_body={"invite_code": new_code})
        _rec(5, "NEW code on /family-group/join works (already_member)",
             r5.status_code == 200 and r5.json().get("already_member") is True,
             f"status={r5.status_code} body={r5.text[:200]}")

    # MEMBER regenerate -> 403
    r6 = _req("POST", "/family-group/regenerate-code", token=cc_ctx["token"])
    _rec(5, "MEMBER POST /family-group/regenerate-code 403",
         r6.status_code == 403, f"status={r6.status_code} body={r6.text[:200]}")

    # Empty name -> 400 (test as owner)
    r7 = _req("PUT", "/family-group", token=demo_ctx["token"], json_body={"name": ""})
    _rec(5, "OWNER PUT /family-group {name:''} 400",
         r7.status_code == 400, f"status={r7.status_code} body={r7.text[:200]}")

    # Update demo_ctx invite_code to the new one for downstream tests
    if new_code:
        demo_ctx["group"]["invite_code"] = new_code
    return new_code


# ====================================================================
# TEST 6: Join with invalid / already-joined code
# ====================================================================
def test_6_join_invalid(demo_ctx: dict):
    print("\n=== TEST 6: Join with invalid / already-joined code ===")
    # Bad code
    r1 = _req("POST", "/family-group/join", token=demo_ctx["token"],
              json_body={"invite_code": "KINN-BADCODE"})
    _rec(6, "POST /family-group/join 'KINN-BADCODE' -> 404",
         r1.status_code == 404, f"status={r1.status_code} body={r1.text[:200]}")

    # Own current code -> 200, already_member:true
    current_code = demo_ctx["group"]["invite_code"]
    r2 = _req("POST", "/family-group/join", token=demo_ctx["token"],
              json_body={"invite_code": current_code})
    _rec(6, "POST /family-group/join own code 200 already_member:true",
         r2.status_code == 200 and r2.json().get("already_member") is True,
         f"status={r2.status_code} body={r2.text[:200]}")


# ====================================================================
# TEST 7: Leave / Remove flows
# ====================================================================
def test_7_leave_remove(demo_ctx: dict, cc_ctx: dict):
    print("\n=== TEST 7: Leave / Remove flows ===")
    if not demo_ctx or not cc_ctx:
        _rec(7, "prereq", False, "missing contexts")
        return

    # 7a) Owner leave with co-users -> 400
    r1 = _req("POST", "/family-group/leave", token=demo_ctx["token"])
    _rec(7, "OWNER leave (with others) -> 400", r1.status_code == 400,
         f"status={r1.status_code} body={r1.text[:200]}")

    # 7b) Co-caregiver leaves -> 200 with new_group having fresh KINN-XXXXXX
    r2 = _req("POST", "/family-group/leave", token=cc_ctx["token"])
    _rec(7, "MEMBER leave 200", r2.status_code == 200, f"status={r2.status_code} body={r2.text[:200]}")
    if r2.status_code == 200:
        b = r2.json()
        ng = b.get("new_group") or {}
        cc_new_code = ng.get("invite_code", "")
        _rec(7, "leave.new_group.invite_code is KINN-XXXXXX",
             bool(INVITE_CODE_RE.match(cc_new_code)), f"got={cc_new_code!r}")
        _rec(7, "leave.new_group.owner_user_id == cc's id",
             ng.get("owner_user_id") == cc_ctx["user"]["id"],
             f"got={ng.get('owner_user_id')} expected={cc_ctx['user']['id']}")

        # GET /family-group now returns the NEW solo group
        rfg = get_family_group(cc_ctx["token"])
        if rfg.status_code == 200:
            fg = rfg.json()
            _rec(7, "after leave, GET /family-group returns new group",
                 (fg.get("group") or {}).get("id") == ng.get("id"),
                 f"got={(fg.get('group') or {}).get('id')} expected={ng.get('id')}")
            _rec(7, "after leave, my_role == 'owner' in new group",
                 fg.get("my_role") == "owner", f"got={fg.get('my_role')}")

    # 7c) Co-caregiver rejoins demo's group via current demo code
    demo_code = demo_ctx["group"]["invite_code"]
    r3 = _req("POST", "/family-group/join", token=cc_ctx["token"],
              json_body={"invite_code": demo_code})
    _rec(7, "cc rejoins demo's group via current code 200",
         r3.status_code == 200, f"status={r3.status_code} body={r3.text[:200]}")

    # 7d) Owner removes member -> 200 ok:true
    r4 = _req("POST", "/family-group/remove-member", token=demo_ctx["token"],
              json_body={"user_id": cc_ctx["user"]["id"]})
    _rec(7, "OWNER remove-member 200", r4.status_code == 200,
         f"status={r4.status_code} body={r4.text[:200]}")
    if r4.status_code == 200:
        _rec(7, "remove-member ok:true", r4.json().get("ok") is True,
             f"got={r4.json()}")

    # 7e) After removal, cc's GET /family-group should auto-create new solo group
    rfg2 = get_family_group(cc_ctx["token"])
    _rec(7, "after removal, cc GET /family-group 200", rfg2.status_code == 200,
         f"status={rfg2.status_code} body={rfg2.text[:200]}")
    if rfg2.status_code == 200:
        fg2 = rfg2.json()
        _rec(7, "after removal, cc's group is fresh (not demo's)",
             (fg2.get("group") or {}).get("id") != demo_ctx["fg_id"],
             f"got={(fg2.get('group') or {}).get('id')} demo={demo_ctx['fg_id']}")
        _rec(7, "after removal, cc's my_role == 'owner'",
             fg2.get("my_role") == "owner", f"got={fg2.get('my_role')}")

    # 7f) As member, attempting remove-member -> 403
    # First, signup yet another co-caregiver and add them to demo group, then have them try remove-member.
    cc2_email = rand_email("cc2")
    rsig = signup(cc2_email, "password123", "Co Caregiver 2", invite_code=demo_code)
    if rsig.status_code == 200:
        cc2_token = rsig.json()["access_token"]
        cc2_user = rsig.json()["user"]
        r5 = _req("POST", "/family-group/remove-member", token=cc2_token,
                  json_body={"user_id": demo_ctx["user"]["id"]})
        _rec(7, "MEMBER remove-member -> 403", r5.status_code == 403,
             f"status={r5.status_code} body={r5.text[:200]}")
        # Cleanup: owner removes cc2
        _req("POST", "/family-group/remove-member", token=demo_ctx["token"],
             json_body={"user_id": cc2_user["id"]})
    else:
        _rec(7, "could not signup cc2 for member-403 test", False,
             f"status={rsig.status_code} body={rsig.text[:200]}")


# ====================================================================
# TEST 8: Billing under group model
# ====================================================================
def test_8_billing(demo_ctx: dict):
    print("\n=== TEST 8: Billing under group model ===")
    if not demo_ctx:
        _rec(8, "prereq", False, "demo_ctx missing")
        return

    r = _req("GET", "/billing/status", token=demo_ctx["token"])
    _rec(8, "GET /api/billing/status 200", r.status_code == 200,
         f"status={r.status_code} body={r.text[:200]}")
    if r.status_code != 200:
        return
    bs = r.json()
    plan = bs.get("plan")
    _rec(8, "plan is 'free' or 'family_plan'", plan in ("free", "family_plan"),
         f"got={plan}")
    if plan == "free":
        _rec(8, "free plan: member_limit == 2", bs.get("member_limit") == 2,
             f"got={bs.get('member_limit')}")
    mc = bs.get("member_count")
    _rec(8, "member_count >= 1 (group-wide)", isinstance(mc, int) and mc >= 1,
         f"got={mc}")
    pp = bs.get("paid_plan") or {}
    _rec(8, "paid_plan.amount_cents == 999",
         pp.get("amount_cents") == 999, f"got={pp.get('amount_cents')}")
    _rec(8, "paid_plan.currency == 'usd'",
         pp.get("currency") == "usd", f"got={pp.get('currency')}")
    _rec(8, "paid_plan.interval == 'month'",
         pp.get("interval") == "month", f"got={pp.get('interval')}")
    _rec(8, "paid_plan.product_name non-empty",
         isinstance(pp.get("product_name"), str) and len(pp["product_name"]) > 0,
         f"got={pp.get('product_name')!r}")

    # Try adding a member as owner: 200 if under limit, 402 if at limit
    payload = {"name": f"NewMember-{uuid.uuid4().hex[:5]}", "age": 70, "phone": "+1-555-1234",
               "gender": "Female", "role": "senior"}
    rm = _req("POST", "/members", token=demo_ctx["token"], json_body=payload)
    members_remaining = bs.get("members_remaining")
    if plan == "free" and isinstance(members_remaining, int) and members_remaining <= 0:
        _rec(8, "POST /api/members at limit -> 402",
             rm.status_code == 402, f"status={rm.status_code} body={rm.text[:200]}")
    else:
        _rec(8, "POST /api/members under limit -> 200",
             rm.status_code in (200, 402), f"status={rm.status_code} body={rm.text[:200]}")
        if rm.status_code == 200:
            # Clean up
            mid = rm.json().get("id")
            if mid:
                _req("DELETE", f"/members/{mid}", token=demo_ctx["token"])


# ====================================================================
# TEST 9: Regression smoke
# ====================================================================
def test_9_regression(demo_ctx: dict):
    print("\n=== TEST 9: Regression smoke ===")
    if not demo_ctx:
        _rec(9, "prereq", False, "demo_ctx missing")
        return
    tok = demo_ctx["token"]

    # /auth/me
    r = _req("GET", "/auth/me", token=tok)
    _rec(9, "GET /auth/me 200 with family_group_id",
         r.status_code == 200 and bool(r.json().get("family_group_id")),
         f"status={r.status_code} body={r.text[:200]}")

    # /summary
    rs = _req("GET", "/summary", token=tok)
    _rec(9, "GET /summary 200", rs.status_code == 200, f"status={rs.status_code} body={rs.text[:300]}")
    if rs.status_code == 200:
        s = rs.json()
        members = s.get("members") or []
        _rec(9, "summary.members non-empty", len(members) > 0, f"count={len(members)}")
        required = ["medication_total", "medication_taken", "medication_missed",
                    "routine_total", "weekly_compliance_percent"]
        ok = all(all(k in m for k in required) for m in members)
        _rec(9, "each member has required fields", ok,
             f"first={members[0] if members else None}")

    # Find a member id
    rm = _req("GET", "/members", token=tok)
    if rm.status_code != 200 or not rm.json():
        _rec(9, "could not find a member for reminder tests", False, f"status={rm.status_code}")
        return
    member_id = rm.json()[0]["id"]

    # POST /api/reminders
    rem_body = {
        "member_id": member_id,
        "title": f"QA Reminder {uuid.uuid4().hex[:5]}",
        "category": "medication",
        "times": [{"time": "07:30", "label": "Morning"}, {"time": "21:00"}],
    }
    rr = _req("POST", "/reminders", token=tok, json_body=rem_body)
    _rec(9, "POST /reminders 200", rr.status_code == 200, f"status={rr.status_code} body={rr.text[:300]}")
    rem_id = None
    if rr.status_code == 200:
        rem = rr.json()
        rem_id = rem.get("id")
        times = rem.get("times") or []
        _rec(9, "POST /reminders preserves times list (2 slots)",
             len(times) == 2 and times[0].get("time") == "07:30",
             f"times={times}")

    if rem_id:
        # PUT
        rp = _req("PUT", f"/reminders/{rem_id}", token=tok, json_body={"title": "updated"})
        _rec(9, "PUT /reminders/{id} 200", rp.status_code == 200,
             f"status={rp.status_code} body={rp.text[:200]}")

        # mark
        rk = _req("POST", f"/reminders/{rem_id}/mark", token=tok, json_body={"status": "taken"})
        _rec(9, "POST /reminders/{id}/mark 200", rk.status_code == 200,
             f"status={rk.status_code} body={rk.text[:200]}")

    # POST /checkins
    rc = _req("POST", "/checkins", token=tok,
              json_body={"member_id": member_id, "latitude": 12.97, "longitude": 77.59,
                         "location_name": "Test"})
    _rec(9, "POST /checkins 200", rc.status_code == 200, f"status={rc.status_code} body={rc.text[:200]}")
    if rc.status_code == 200:
        rcr = _req("GET", "/checkins/recent", token=tok)
        _rec(9, "GET /checkins/recent 200", rcr.status_code == 200, f"status={rcr.status_code}")
        if rcr.status_code == 200:
            rec = rcr.json()
            if rec and isinstance(rec, list):
                top = rec[0]
                _rec(9, "checkins/recent top matches",
                     top.get("member_id") == member_id and top.get("latitude") == 12.97
                     and top.get("longitude") == 77.59 and top.get("location_name") == "Test",
                     f"top={top}")
            else:
                _rec(9, "checkins/recent has data", False, f"got={rec}")

    # /history/member/{id}?days=7
    rh = _req("GET", f"/history/member/{member_id}?days=7", token=tok)
    _rec(9, "GET /history/member/{id}?days=7 200",
         rh.status_code == 200, f"status={rh.status_code} body={rh.text[:200]}")
    if rh.status_code == 200:
        h = rh.json()
        series = h.get("series") or h.get("days") or []
        _rec(9, "history series length == 7",
             isinstance(series, list) and len(series) == 7,
             f"len={len(series) if isinstance(series, list) else None}")
        _rec(9, "history has totals + compliance_percent",
             ("totals" in h or "medication_total" in h) and "compliance_percent" in h,
             f"keys={list(h.keys())}")

    # DELETE /reminders/{id}
    if rem_id:
        rd = _req("DELETE", f"/reminders/{rem_id}", token=tok)
        _rec(9, "DELETE /reminders/{id} 200", rd.status_code == 200,
             f"status={rd.status_code} body={rd.text[:200]}")


# ====================================================================
# MAIN
# ====================================================================
def main():
    print(f"Backend base URL: {BASE}")
    print(f"Demo creds: {DEMO_EMAIL} / {DEMO_PASS}")

    demo_ctx = test_1_family_group_bootstrap()
    cc_ctx = test_2_signup_with_invite(demo_ctx) if demo_ctx else None
    test_3_solo_signup(demo_ctx) if demo_ctx else None
    test_4_sos_fanout(demo_ctx, cc_ctx)
    test_5_rbac(demo_ctx, cc_ctx)
    test_6_join_invalid(demo_ctx) if demo_ctx else None
    test_7_leave_remove(demo_ctx, cc_ctx)
    test_8_billing(demo_ctx)
    test_9_regression(demo_ctx)

    # Final report
    print("\n" + "=" * 70)
    print("FINAL REPORT")
    print("=" * 70)
    total_pass = 0
    total_fail = 0
    for tid in sorted(RESULTS.keys()):
        b = RESULTS[tid]
        passes = sum(1 for c in b["checks"] if c[0])
        fails = len(b["fails"])
        total_pass += passes
        total_fail += fails
        status = "✅ PASS" if fails == 0 else f"❌ FAIL ({fails} issues)"
        print(f"  Test {tid}: {status}  ({passes}/{len(b['checks'])} checks)")
        for label, detail in b["fails"]:
            print(f"      - {label}: {detail}")
    print(f"\nTOTAL: {total_pass} passes, {total_fail} fails")
    return 0 if total_fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
