#!/usr/bin/env python3
"""Re-test ONLY the two scenarios that previously failed in the
family-invite-by-email backend due to the naive-vs-aware datetime
comparison bug. Fix applied at:
  - /app/backend/family_group.py:resolve_invite_code (~L150)
  - /app/backend/family_group.py:list_invites          (~L635)

Per review instructions:
  1) GET /api/family-group/invites with >=1 pending invite -> 200 (was 500)
  2) POST /api/auth/verify-otp with INV-XXXXXX token -> joins inviter's
     family group, marks invite accepted, second use of token -> 404.

Runs against http://localhost:8001/api only. Does NOT touch Atlas.
"""
from __future__ import annotations

import os
import sys
import time
import uuid
from typing import Optional

import requests
from pymongo import MongoClient
from passlib.context import CryptContext
from dotenv import load_dotenv

load_dotenv("/app/backend/.env")

API = "http://localhost:8001/api"
MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]

mc = MongoClient(MONGO_URL)
db = mc[DB_NAME]
ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")

PASSES: list[str] = []
FAILS: list[str] = []


def _p(name: str, ok: bool, detail: str = ""):
    bucket = PASSES if ok else FAILS
    bucket.append(f"{'✅' if ok else '❌'} {name}{(' — ' + detail) if detail else ''}")
    print(bucket[-1])


def rand_email(label: str) -> str:
    return f"kinn-invite-retest-{label}-{uuid.uuid4().hex[:8]}@example.com"


KNOWN_CODE = "654321"


def signup_via_otp(email: str, full_name: str, invite_code: Optional[str] = None) -> dict:
    """Run /auth/request-otp signup then inject a known code and verify.
    Returns the verify-otp response (or raises on error)."""
    body = {
        "email": email,
        "purpose": "signup",
        "full_name": full_name,
        "timezone": "UTC",
    }
    if invite_code:
        body["invite_code"] = invite_code
    r = requests.post(f"{API}/auth/request-otp", json=body, timeout=15)
    if r.status_code != 200:
        raise RuntimeError(f"request-otp failed {r.status_code}: {r.text}")

    # Inject a known code_hash so we don't need SMTP.
    upd = db.otp_codes.update_one(
        {"email": email},
        {"$set": {"code_hash": ctx.hash(KNOWN_CODE), "attempts": 0}},
    )
    if upd.matched_count != 1:
        raise RuntimeError(f"OTP record not found in db for {email}")

    r2 = requests.post(
        f"{API}/auth/verify-otp",
        json={"email": email, "code": KNOWN_CODE},
        timeout=15,
    )
    return {"status": r2.status_code, "body": _try_json(r2), "raw": r2}


def login_via_otp(email: str) -> dict:
    r = requests.post(
        f"{API}/auth/request-otp",
        json={"email": email, "purpose": "login"},
        timeout=15,
    )
    if r.status_code != 200:
        raise RuntimeError(f"login request-otp failed {r.status_code}: {r.text}")
    db.otp_codes.update_one(
        {"email": email},
        {"$set": {"code_hash": ctx.hash(KNOWN_CODE), "attempts": 0}},
    )
    r2 = requests.post(
        f"{API}/auth/verify-otp",
        json={"email": email, "code": KNOWN_CODE},
        timeout=15,
    )
    return {"status": r2.status_code, "body": _try_json(r2)}


def _try_json(r):
    try:
        return r.json()
    except Exception:
        return {"_raw": r.text}


def auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def tail_err_log(n: int = 80) -> str:
    try:
        with open("/var/log/supervisor/backend.err.log", "r", errors="ignore") as f:
            data = f.read().splitlines()
        return "\n".join(data[-n:])
    except Exception as e:
        return f"<could not read err log: {e}>"


# Snapshot the err log size BEFORE the run so we can find any traceback
# emitted DURING the run.
ERR_LOG_PATH = "/var/log/supervisor/backend.err.log"
try:
    ERR_LOG_START = os.path.getsize(ERR_LOG_PATH)
except Exception:
    ERR_LOG_START = 0


def err_log_delta() -> str:
    try:
        with open(ERR_LOG_PATH, "rb") as f:
            f.seek(ERR_LOG_START)
            return f.read().decode("utf-8", errors="ignore")
    except Exception as e:
        return f"<could not read err log delta: {e}>"


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------
r = requests.get(f"{API}/health", timeout=5)
_p("health endpoint reachable", r.status_code == 200 and r.json().get("ok") is True,
   f"status={r.status_code} body={r.text[:120]}")


# ---------------------------------------------------------------------------
# Scenario 1 (and the GET /invites verification piece of Scenario 2/A.e):
# 1) Alice signs up as owner of a new family group.
# 2) Alice creates an invite for Bob (this leaves >=1 pending invite).
# 3) Alice GETs /api/family-group/invites — expect 200 (was 500), with
#    invites list including ISO datetime strings.
# ---------------------------------------------------------------------------

alice_email = rand_email("alice")
print(f"\n[+] Creating Alice as owner: {alice_email}")
res = signup_via_otp(alice_email, "Alice QA")
if res["status"] != 200:
    _p("Alice signup via OTP", False, f"{res['status']} {res['body']}")
    print("Cannot proceed without Alice — aborting.")
    sys.exit(1)
alice_token = res["body"]["access_token"]
alice_user = res["body"]["user"]
alice_fg_id = alice_user.get("family_group_id")
_p("Alice signup via OTP -> 200 owner",
   alice_user.get("family_group_role") == "owner" and bool(alice_fg_id),
   f"role={alice_user.get('family_group_role')} fg_id={alice_fg_id}")

# Create the invite for Bob.
bob_email = rand_email("bob")
print(f"\n[+] Alice creates invite for Bob: {bob_email}")
r = requests.post(
    f"{API}/family-group/invite",
    json={"name": "Bob QA", "email": bob_email},
    headers=auth(alice_token),
    timeout=15,
)
if r.status_code != 200:
    _p("POST /family-group/invite", False, f"{r.status_code} {r.text[:300]}")
    sys.exit(1)
invite_payload = r.json()
inv_token = invite_payload.get("invite", {}).get("token")
inv_id = invite_payload.get("invite", {}).get("id")
_p("POST /family-group/invite -> 200 and INV- token returned",
   bool(inv_token) and inv_token.startswith("INV-"),
   f"token={inv_token} id={inv_id}")

# Scenario 1: GET /api/family-group/invites with >=1 pending invite.
print("\n[+] Scenario 1: GET /api/family-group/invites (>=1 pending)")
r = requests.get(
    f"{API}/family-group/invites",
    headers=auth(alice_token),
    timeout=15,
)
print(f"    status={r.status_code} body={r.text[:400]}")
if r.status_code != 200:
    _p("GET /family-group/invites returns 200 (NOT 500)", False,
       f"status={r.status_code} body={r.text[:600]}")
    print("\n--- backend.err.log delta ---")
    print(err_log_delta())
    sys.exit(1)

body = r.json()
_p("GET /family-group/invites returns 200 (NOT 500)", True,
   f"count={body.get('count')}")

invites = body.get("invites") or []
_p("Response shape: {invites:[...], count:N}",
   isinstance(invites, list) and isinstance(body.get("count"), int) and body["count"] == len(invites),
   f"invites_len={len(invites)} count={body.get('count')}")

# Check ISO datetime strings.
target_row = next((i for i in invites if i.get("token") == inv_token), None)
if not target_row:
    _p("Bob's invite present in GET /invites", False,
       f"tokens_found={[i.get('token') for i in invites]}")
else:
    _p("Bob's invite present in GET /invites", True,
       f"status={target_row.get('status')}")
    exp_str = target_row.get("expires_at")
    cre_str = target_row.get("created_at")

    def _is_iso(s):
        if not isinstance(s, str):
            return False
        try:
            from datetime import datetime as _dt
            _dt.fromisoformat(s.replace("Z", "+00:00"))
            return True
        except Exception:
            return False

    _p("expires_at is ISO-8601 string", _is_iso(exp_str), f"expires_at={exp_str!r}")
    _p("created_at is ISO-8601 string", _is_iso(cre_str), f"created_at={cre_str!r}")

# Check err log delta for any traceback during this call.
delta = err_log_delta()
has_tb_get = (
    ("Traceback" in delta and "list_invites" in delta)
    or ("can't compare offset-naive and offset-aware datetimes" in delta)
)
_p("No traceback for list_invites in backend.err.log during/after GET /invites",
   not has_tb_get,
   "(see err log delta above)" if has_tb_get else "")

if has_tb_get:
    print("\n--- backend.err.log delta (after GET /invites) ---")
    print(delta[-3000:])


# ---------------------------------------------------------------------------
# Scenario 2 (Scenario A end-to-end, plus Scenario B single-use check):
#  a) Alice already created above (owner).
#  b) Invite for Bob already created above.
#  c) Bob signs up via OTP passing invite_code=<INV- token>. -> 200 JWT.
#  d) Bob's family_group_id == Alice's family_group_id.
#  e) Alice GET /family-group/invites shows Bob's invite as accepted with
#     accepted_by_user_id == Bob's id.
#  f) Try a third user with the SAME (now accepted) INV- token -> 404
#     "Invite code not found".
# ---------------------------------------------------------------------------

print(f"\n[+] Scenario 2.c: Bob signs up via OTP with invite_code={inv_token}")
res = signup_via_otp(bob_email, "Bob QA", invite_code=inv_token)
print(f"    status={res['status']} body={str(res['body'])[:400]}")
bob_ok_200 = res["status"] == 200 and bool(res["body"].get("access_token"))
_p("Scenario 2.c — POST /auth/verify-otp with INV- token -> 200 + JWT",
   bob_ok_200,
   f"status={res['status']} body={str(res['body'])[:300]}")

if not bob_ok_200:
    print("\n--- backend.err.log delta (after Bob's verify-otp) ---")
    print(err_log_delta()[-3000:])
    sys.exit(1)

bob_user = res["body"]["user"]
bob_id = bob_user["id"]
bob_token = res["body"]["access_token"]

# d) Bob's family_group_id == Alice's family_group_id.
_p("Scenario 2.d — Bob.family_group_id == Alice.family_group_id",
   bob_user.get("family_group_id") == alice_fg_id and bob_user.get("family_group_role") == "member",
   f"bob.fg={bob_user.get('family_group_id')} alice.fg={alice_fg_id} bob.role={bob_user.get('family_group_role')}")

# e) Alice's GET /family-group/invites should now show Bob's invite as
#    accepted with accepted_by_user_id == Bob's id.
print("\n[+] Scenario 2.e: Re-fetch Alice's /family-group/invites — should show accepted")
r = requests.get(
    f"{API}/family-group/invites",
    headers=auth(alice_token),
    timeout=15,
)
print(f"    status={r.status_code} body={r.text[:500]}")
if r.status_code != 200:
    _p("GET /family-group/invites (post-accept) -> 200", False,
       f"status={r.status_code} body={r.text[:400]}")
else:
    _p("GET /family-group/invites (post-accept) -> 200", True)
    body2 = r.json()
    row2 = next((i for i in (body2.get("invites") or []) if i.get("token") == inv_token), None)
    if not row2:
        _p("Bob's invite still listed (any status)", False,
           f"tokens={[i.get('token') for i in (body2.get('invites') or [])]}")
    else:
        _p("Bob's invite status == 'accepted'",
           row2.get("status") == "accepted",
           f"status={row2.get('status')}")
        _p("Bob's invite accepted_by_user_id == Bob.id",
           row2.get("accepted_by_user_id") == bob_id,
           f"accepted_by={row2.get('accepted_by_user_id')} bob_id={bob_id}")

# f) Scenario B: try a third user with the same (now accepted) INV-
#    token -> 404 "Invite code not found".
charlie_email = rand_email("charlie")
print(f"\n[+] Scenario B (2.f): Charlie tries to reuse Bob's INV- token: {charlie_email}")
# We need to call request-otp + verify-otp; the 404 must come from
# verify-otp (because resolve_invite_code returns None for accepted).
r = requests.post(
    f"{API}/auth/request-otp",
    json={
        "email": charlie_email,
        "purpose": "signup",
        "full_name": "Charlie QA",
        "timezone": "UTC",
        "invite_code": inv_token,
    },
    timeout=15,
)
_p("request-otp for Charlie -> 200 (stashes invite_code)", r.status_code == 200,
   f"status={r.status_code} body={r.text[:200]}")
db.otp_codes.update_one(
    {"email": charlie_email},
    {"$set": {"code_hash": ctx.hash(KNOWN_CODE), "attempts": 0}},
)
r = requests.post(
    f"{API}/auth/verify-otp",
    json={"email": charlie_email, "code": KNOWN_CODE},
    timeout=15,
)
print(f"    Charlie verify-otp status={r.status_code} body={r.text[:300]}")
body_charlie = _try_json(r)
is_404 = r.status_code == 404
detail_match = isinstance(body_charlie, dict) and ("not found" in str(body_charlie.get("detail", "")).lower())
_p("Scenario 2.f — re-using accepted INV- token returns 404",
   is_404 and detail_match,
   f"status={r.status_code} detail={body_charlie.get('detail') if isinstance(body_charlie, dict) else body_charlie}")

# Confirm Charlie was NOT created in users.
charlie_in_db = db.users.find_one({"email": charlie_email})
_p("Charlie user NOT created (since token was rejected)", charlie_in_db is None,
   f"db_record={charlie_in_db}")

# Final err log check: NO new tracebacks for list_invites / resolve_invite_code.
delta = err_log_delta()
bad = (
    ("can't compare offset-naive and offset-aware datetimes" in delta)
    or ("resolve_invite_code" in delta and "Traceback" in delta)
)
_p("No naive-vs-aware datetime traceback in backend.err.log during entire run",
   not bad,
   "(see err log delta above)" if bad else "")

if bad:
    print("\n--- backend.err.log delta (full run) ---")
    print(delta[-4000:])

# ---------------------------------------------------------------------------
# SUMMARY
# ---------------------------------------------------------------------------
print("\n" + "=" * 70)
print(f"PASS: {len(PASSES)}   FAIL: {len(FAILS)}")
print("=" * 70)
for ln in PASSES:
    print(ln)
for ln in FAILS:
    print(ln)
sys.exit(0 if not FAILS else 1)
