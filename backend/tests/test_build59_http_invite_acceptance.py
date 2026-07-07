"""Build #59 HOTFIX — HTTP-level integration tests for
`ensure_self_member_row` on the two invitation acceptance paths.

Path A: existing user calls POST /api/family-group/join
Path B: brand-new user calls POST /api/auth/verify-otp with invite_code

Also covers:
  • Idempotency of double-accept
  • Auto-bind preservation (legacy placeholder rows survive the helper)
  • location_sharing_enabled defaults to True on the joiner's row

All tests seed users fresh via OTP signup (grep OTP from backend log).
Test data prefixed TEST_B59H_ for easy identification.
"""
import os
import re
import time
import uuid
import subprocess

import pytest
import requests
from pymongo import MongoClient
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

BASE_URL = "https://family-guard-37.preview.emergentagent.com"
API = f"{BASE_URL}/api"
BACKEND_LOG = "/var/log/supervisor/backend.err.log"
OTP_TIMEOUT_S = 25
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")


# ---------------------- helpers ----------------------

def _log_tail(n: int = 2000) -> str:
    try:
        out = subprocess.run(
            ["tail", "-n", str(n), BACKEND_LOG],
            capture_output=True, text=True, timeout=5,
        )
        return out.stdout
    except Exception:
        return ""


def _grep_otp_code(email: str) -> str | None:
    """Poll backend log for `Code for <email>: NNNNNN`.  Returns most
    recent code seen within OTP_TIMEOUT_S."""
    pat = re.compile(rf"Code for {re.escape(email)}:\s*(\d{{6}})")
    deadline = time.time() + OTP_TIMEOUT_S
    last_code = None
    while time.time() < deadline:
        log = _log_tail(3000)
        for m in pat.finditer(log):
            last_code = m.group(1)
        if last_code:
            return last_code
        time.sleep(1)
    return last_code


def _signup(email: str, full_name: str, invite_code: str | None = None) -> dict:
    """Full OTP signup — returns {token, user}."""
    payload = {"email": email, "purpose": "signup", "full_name": full_name}
    if invite_code:
        payload["invite_code"] = invite_code
    r = requests.post(f"{API}/auth/request-otp", json=payload, timeout=15)
    assert r.status_code == 200, f"request-otp failed: {r.status_code} {r.text}"
    code = _grep_otp_code(email)
    assert code, f"No OTP code found in backend log for {email}"
    v = requests.post(
        f"{API}/auth/verify-otp",
        json={"email": email, "code": code},
        timeout=15,
    )
    assert v.status_code == 200, f"verify-otp failed: {v.status_code} {v.text}"
    data = v.json()
    return {"token": data["access_token"], "user": data["user"], "email": email}


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _mint_invite(inviter_session: dict, invitee_name: str,
                 invitee_email: str, relationship: str | None = None,
                 role: str | None = None) -> str:
    body = {"name": invitee_name, "email": invitee_email}
    if relationship is not None:
        body["relationship"] = relationship
    if role is not None:
        body["role"] = role
    r = requests.post(
        f"{API}/family-group/invite",
        json=body,
        headers=_auth(inviter_session["token"]),
        timeout=15,
    )
    assert r.status_code == 200, f"invite mint failed: {r.status_code} {r.text}"
    data = r.json()
    token = data["invite"]["token"]
    assert token.startswith("INV-"), f"expected INV- token, got {token!r}"
    return token


def _get_members(session: dict) -> list[dict]:
    r = requests.get(f"{API}/members", headers=_auth(session["token"]), timeout=10)
    assert r.status_code == 200, f"GET /members failed: {r.status_code} {r.text}"
    return r.json()


def _mongo():
    """Direct DB handle for cross-verification (dupe counts, etc.)."""
    return MongoClient(MONGO_URL)[DB_NAME]


# ---------------------- Test 1 — Path A ----------------------

class TestPathA_ExistingUserJoin:
    """Existing user calls POST /api/family-group/join with an INV- token."""

    def test_path_a_end_to_end(self):
        db = _mongo()
        # 1. Sign up User A (Caregiver)
        a_email = f"test-b59h-a-{uuid.uuid4().hex[:8]}@example.com"
        a = _signup(a_email, "TEST_B59H Charles Caregiver")
        a_gid = a["user"]["family_group_id"]
        a_uid = a["user"]["id"]
        assert a_gid, "Caregiver A missing family_group_id"

        # 2. Invite Joyce (User B)
        b_email = f"test-b59h-b-{uuid.uuid4().hex[:8]}@example.com"
        inv_token = _mint_invite(a, "Joyce", b_email,
                                 relationship="Mom", role="senior")

        # 3. Sign up B WITHOUT invite_code (solo group)
        b = _signup(b_email, "Joyce Miller")
        b_uid = b["user"]["id"]
        b_solo_gid = b["user"]["family_group_id"]
        assert b_solo_gid and b_solo_gid != a_gid, \
            f"B should be in own solo group, got {b_solo_gid} vs A={a_gid}"

        # 4. B joins via /family-group/join
        join_r = requests.post(
            f"{API}/family-group/join",
            json={"invite_code": inv_token},
            headers=_auth(b["token"]),
            timeout=15,
        )
        assert join_r.status_code == 200, \
            f"join failed: {join_r.status_code} {join_r.text}"

        # 5. Immediately (NO restart) — A's /members must include Joyce row
        a_members = _get_members(a)
        joyce_rows = [
            m for m in a_members
            if m.get("user_id") == b_uid or m.get("name") == "Joyce Miller"
        ]
        assert len(joyce_rows) >= 1, \
            f"A's /members has no row for joiner. Members={a_members}"
        # The name may come from full_name (Joyce Miller) since helper
        # uses user.full_name, not the invite's invitee_name ("Joyce").
        joyce = next(
            (m for m in a_members if m.get("user_id") == b_uid), None
        )
        assert joyce is not None, \
            f"No members row with user_id={b_uid} for A. Members={a_members}"
        assert joyce.get("family_group_id") == a_gid
        assert joyce.get("role") == "senior", \
            f"role should be from invite; got {joyce.get('role')}"
        # DB-level check for `relationship` — the FamilyMember Pydantic
        # response model does NOT declare a `relationship` field, so it
        # is stripped from the API payload even though the helper
        # persists it correctly.  Report as a response-schema gap in
        # the test report; check DB directly here.
        db_row = db.members.find_one(
            {"family_group_id": a_gid, "user_id": b_uid}, {"_id": 0}
        )
        assert db_row is not None
        assert db_row.get("relationship") == "Mom", \
            f"DB row missing relationship=Mom (helper broken): {db_row}"
        # Helper uses user.full_name for display
        assert joyce.get("name") == "Joyce Miller", \
            f"name should be joiner's full_name; got {joyce.get('name')!r}"

        # 6. B's /members includes BOTH A's row AND B's own row.
        b_members = _get_members(b)
        b_uids = {m.get("user_id") for m in b_members}
        assert b_uid in b_uids, \
            f"B's own row missing from B's /members. {b_members}"
        # A must also be a member of the group — but A's self-row is
        # created lazily on ensure_family_group; check by gid match at
        # minimum.
        assert all(m.get("family_group_id") == a_gid for m in b_members), \
            "B seeing rows outside target group"

        # 7. Direct DB check: exactly ONE member row for (A.group, B.uid)
        dupe_count = db.members.count_documents(
            {"family_group_id": a_gid, "user_id": b_uid}
        )
        assert dupe_count == 1, \
            f"expected 1 row for B in A's group, got {dupe_count}"

        # 8. location_sharing_enabled default = True on joiner's row
        assert joyce.get("location_sharing_enabled") is True, \
            f"joiner location_sharing_enabled should default True; got {joyce.get('location_sharing_enabled')}"

        # Test 3 — Idempotency: retry the same token
        retry = requests.post(
            f"{API}/family-group/join",
            json={"invite_code": inv_token},
            headers=_auth(b["token"]),
            timeout=15,
        )
        # Accept either 404 (code consumed) OR 200 with already_member
        # OR 200 (idempotent no-op).  Anything else is a regression.
        assert retry.status_code in (200, 404, 400), \
            f"duplicate join returned unexpected {retry.status_code}: {retry.text}"
        dupe_after = db.members.count_documents(
            {"family_group_id": a_gid, "user_id": b_uid}
        )
        assert dupe_after == 1, \
            f"duplicate join created dupe rows: {dupe_after}"


# ---------------------- Test 2 — Path B ----------------------

class TestPathB_BrandNewSignupWithInvite:
    """Brand-new user signs up via verify-otp with invite_code."""

    def test_path_b_end_to_end(self):
        db = _mongo()
        a_email = f"test-b59h-a2-{uuid.uuid4().hex[:8]}@example.com"
        a = _signup(a_email, "TEST_B59H Charles PathB")
        a_gid = a["user"]["family_group_id"]
        a_uid = a["user"]["id"]

        c_email = f"test-b59h-c-{uuid.uuid4().hex[:8]}@example.com"
        inv_token = _mint_invite(a, "Priya", c_email,
                                 relationship="Sister", role="family")

        # C does fresh signup WITH invite_code
        c = _signup(c_email, "Priya Patel", invite_code=inv_token)
        c_uid = c["user"]["id"]
        c_gid = c["user"]["family_group_id"]
        assert c_gid == a_gid, \
            f"C's family_group_id should equal A's; got {c_gid} vs {a_gid}"

        # A's /members includes Priya row
        a_members = _get_members(a)
        priya = next(
            (m for m in a_members if m.get("user_id") == c_uid), None
        )
        assert priya is not None, \
            f"A's /members has no row for C={c_uid}. Members={a_members}"
        assert priya.get("name") == "Priya Patel"
        # Response-schema gap: `relationship` not in FamilyMember model.
        # Verify at DB level.
        db_row = _mongo().members.find_one(
            {"family_group_id": a_gid, "user_id": c_uid}, {"_id": 0}
        )
        assert db_row is not None
        assert db_row.get("relationship") == "Sister", \
            f"DB row missing relationship=Sister: {db_row}"
        assert priya.get("role") == "family"
        assert priya.get("location_sharing_enabled") is True

        # C's /members includes A's row and C's own row
        c_members = _get_members(c)
        assert any(m.get("user_id") == c_uid for m in c_members), \
            f"C's own row missing. {c_members}"

        # Only ONE row for C in A's group
        dupe = db.members.count_documents(
            {"family_group_id": a_gid, "user_id": c_uid}
        )
        assert dupe == 1, f"expected 1 row for C in A's group, got {dupe}"


# ---------------------- Test 4 — Auto-bind preservation ----------------------

class TestAutoBindPreservation:
    """Legacy placeholder pre-created by caregiver survives acceptance —
    ensure_self_member_row must NOT overwrite it, and no duplicate row
    should be inserted for the joiner."""

    def test_placeholder_row_preserved(self):
        db = _mongo()
        a_email = f"test-b59h-a3-{uuid.uuid4().hex[:8]}@example.com"
        a = _signup(a_email, "TEST_B59H Charles AutoBind")
        a_gid = a["user"]["family_group_id"]

        # Caregiver pre-creates a placeholder member ("Test User", age 78)
        placeholder_name = f"TEST_B59H AutoBind {uuid.uuid4().hex[:4]}"
        placeholder_r = requests.post(
            f"{API}/members",
            json={
                "name": placeholder_name,
                "age": 78,
                "phone": "+15551111",
                "gender": "female",
                "role": "senior",
            },
            headers=_auth(a["token"]),
            timeout=15,
        )
        assert placeholder_r.status_code == 200, \
            f"placeholder create failed: {placeholder_r.status_code} {placeholder_r.text}"
        placeholder = placeholder_r.json()
        placeholder_id = placeholder["id"]

        # Invite with the SAME name — auto-bind heuristic will pick it up
        d_email = f"test-b59h-d-{uuid.uuid4().hex[:8]}@example.com"
        inv_token = _mint_invite(a, placeholder_name, d_email,
                                 relationship="Mom", role="senior")

        # User D signs up with the invite + matching full_name
        d = _signup(d_email, placeholder_name, invite_code=inv_token)
        d_uid = d["user"]["id"]

        # As A, /members — ONE row named `placeholder_name`, retaining
        # age=78, phone=+15551111 (auto-bind bound user_id, helper did
        # NOT overwrite fields).
        a_members = _get_members(a)
        matching = [m for m in a_members if m.get("name") == placeholder_name]
        assert len(matching) == 1, \
            f"Expected 1 row named {placeholder_name}, got {len(matching)}: {matching}"
        row = matching[0]
        assert row["id"] == placeholder_id, \
            f"row id changed — helper created new row instead of preserving. Expected {placeholder_id}, got {row['id']}"
        assert row.get("user_id") == d_uid, \
            f"auto-bind failed to link user_id={d_uid}; got {row.get('user_id')}"
        assert row.get("age") == 78, \
            f"placeholder age clobbered: {row.get('age')}"
        assert row.get("phone") in ("+15551111", "+1 555-111-1"), \
            f"placeholder phone clobbered: {row.get('phone')}"

        # DB-side: only one row for (A.gid, D.uid)
        dupe = db.members.count_documents(
            {"family_group_id": a_gid, "user_id": d_uid}
        )
        assert dupe == 1, \
            f"duplicate rows created — helper did not detect bound row: {dupe}"


# ---------------------- Test 5 — location_sharing_enabled default ----------------------

class TestLocationSharingDefault:
    """Any joiner accepting an invite — location_sharing_enabled: true."""

    def test_default_true_on_join(self):
        a_email = f"test-b59h-a4-{uuid.uuid4().hex[:8]}@example.com"
        a = _signup(a_email, "TEST_B59H Charles LocShare")

        e_email = f"test-b59h-e-{uuid.uuid4().hex[:8]}@example.com"
        inv_token = _mint_invite(a, "LocDefault", e_email)

        e = _signup(e_email, "Location Default User",
                    invite_code=inv_token)
        e_uid = e["user"]["id"]

        a_members = _get_members(a)
        row = next((m for m in a_members if m.get("user_id") == e_uid), None)
        assert row is not None, f"Joiner row missing: {a_members}"
        assert row.get("location_sharing_enabled") is True, \
            f"location_sharing_enabled should default to True on join; got {row.get('location_sharing_enabled')}"
