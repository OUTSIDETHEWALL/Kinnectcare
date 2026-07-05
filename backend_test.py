"""
Backend test for the Family Invite-by-Email feature (Kinnship).

Covers scenarios A-H described in the review request:
  A) Happy path: Alice invites Bob, Bob accepts via INV- token.
  B) INV- token is single-use after acceptance.
  C) Legacy KINN- family-wide code still works.
  D) Revoke flow (idempotent).
  E) Validation/4xx behavior.
  F) Email delivery falls back gracefully (Resend env not set).
  G) Soft cap (51st invite -> 429).
  H) Tenant isolation: Alice's GET /invites cannot see Erin's.

Auth uses the passwordless OTP flow.  Since local SMTP delivery may be
slow/unreliable in CI, after calling /auth/request-otp we overwrite the
OTP record in MongoDB with a known bcrypt hash and then POST
/auth/verify-otp.

Run with:  python /app/backend_test.py
"""

import os
import sys
import time
import uuid
from typing import Optional, Tuple, Dict, Any

import requests
from pymongo import MongoClient
from passlib.context import CryptContext

# --- Config -----------------------------------------------------------------
BASE = "http://localhost:8001"
API = f"{BASE}/api"
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")

mongo = MongoClient(MONGO_URL)
db = mongo[DB_NAME]
pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")
KNOWN_CODE = "654321"
KNOWN_CODE_HASH = pwd_ctx.hash(KNOWN_CODE)

# --- Result tracking --------------------------------------------------------
results = []  # list of (scenario, name, passed, details)


def record(scn: str, name: str, ok: bool, details: str = "") -> bool:
    status = "PASS" if ok else "FAIL"
    print(f"  [{status}] {scn} :: {name}" + (f" — {details}" if details else ""))
    results.append((scn, name, ok, details))
    return ok


# --- Helpers ----------------------------------------------------------------
def rand_email(label: str = "alice") -> str:
    return f"kinn-invite-test-{label}-{uuid.uuid4().hex[:8]}@example.com"


def signup_user(email: str, full_name: str, invite_code: Optional[str] = None) -> Tuple[Optional[str], Optional[Dict[str, Any]], Optional[str]]:
    """Run a passwordless signup OTP flow end-to-end.

    Returns (jwt, user_dict, error).
    """
    body = {"email": email, "purpose": "signup", "full_name": full_name}
    if invite_code:
        body["invite_code"] = invite_code
    r = requests.post(f"{API}/auth/request-otp", json=body, timeout=15)
    if r.status_code != 200:
        return None, None, f"request-otp {r.status_code}: {r.text[:200]}"
    res = db.otp_codes.update_one(
        {"email": email.lower().strip()},
        {"$set": {"code_hash": KNOWN_CODE_HASH, "attempts": 0}},
    )
    if res.matched_count != 1:
        return None, None, f"otp_codes row not found after request-otp for {email}"
    v = requests.post(
        f"{API}/auth/verify-otp",
        json={"email": email, "code": KNOWN_CODE},
        timeout=15,
    )
    if v.status_code != 200:
        return None, None, f"verify-otp {v.status_code}: {v.text[:200]}"
    j = v.json()
    return j.get("access_token"), j.get("user"), None


def auth_headers(token: str) -> Dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def cleanup_user(email: str) -> None:
    email = email.lower().strip()
    user = db.users.find_one({"email": email})
    if user:
        uid = user.get("id")
        gid = user.get("family_group_id")
        db.users.delete_one({"email": email})
        if uid:
            for c in ("members", "reminders", "alerts", "checkins", "medication_logs"):
                db[c].delete_many({"owner_id": uid})
        if gid:
            remaining = db.users.count_documents({"family_group_id": gid})
            if remaining == 0:
                db.family_groups.delete_one({"id": gid})
                db.family_invites.delete_many({"family_group_id": gid})
    db.otp_codes.delete_many({"email": email})


# --- TESTS -----------------------------------------------------------------
def main() -> int:
    print("\n=== Family Invite-by-Email backend tests ===")
    print(f"BASE={BASE}  DB_NAME={DB_NAME}\n")

    r = requests.get(f"{API}/", timeout=5)
    if r.status_code != 200:
        print(f"FATAL: backend not reachable at {API} ({r.status_code})")
        return 1

    # ===== Setup =====
    alice_email = rand_email("alice")
    bob_email = rand_email("bob")
    charlie_email = rand_email("charlie")
    dave_email = rand_email("dave")
    erin_email = rand_email("erin")
    third_email = rand_email("third")
    for e in (alice_email, bob_email, charlie_email, dave_email, erin_email, third_email):
        cleanup_user(e)

    # ===== Scenario A: Happy path =====
    print("\n--- Scenario A: Happy path ---")
    alice_jwt, alice_user, err = signup_user(alice_email, "Alice Tester")
    if not record("A", "Alice signup via OTP", err is None, err or f"user_id={alice_user and alice_user.get('id')}"):
        return 1

    r = requests.get(f"{API}/family-group", headers=auth_headers(alice_jwt), timeout=10)
    record("A", "GET /family-group (Alice solo)", r.status_code == 200 and r.json().get("group", {}).get("invite_code", "").startswith("KINN-"), f"status={r.status_code}")
    alice_group = r.json()["group"]
    alice_gid = alice_group["id"]
    alice_kinn = alice_group["invite_code"]

    r = requests.post(
        f"{API}/family-group/invite",
        headers=auth_headers(alice_jwt),
        json={"name": "Bob", "email": bob_email},
        timeout=10,
    )
    ok = r.status_code == 200
    body = r.json() if ok else {}
    invite = body.get("invite", {}) if ok else {}
    bob_token = invite.get("token", "")
    record("A", "POST /family-group/invite Bob",
           ok and bob_token.startswith("INV-") and invite.get("status") == "pending" and "expires_at" in invite,
           f"status={r.status_code} token={bob_token} delivered={body.get('delivered')}")
    record("A", "delivered:false (no Resend env)", body.get("delivered") is False, f"delivered={body.get('delivered')}")

    r = requests.get(f"{API}/family-group/invites", headers=auth_headers(alice_jwt), timeout=10)
    inv_list = r.json().get("invites", []) if r.status_code == 200 else []
    bob_invite_row = next((i for i in inv_list if i.get("token") == bob_token), None)
    record("A", "GET /family-group/invites contains Bob pending",
           bool(bob_invite_row) and bob_invite_row.get("status") == "pending",
           f"count={len(inv_list)} bob={bob_invite_row}")

    bob_jwt, bob_user, err = signup_user(bob_email, "Bob Tester", invite_code=bob_token)
    record("A", "Bob signup via OTP with INV- token", err is None, err or f"bob_id={bob_user and bob_user.get('id')}")
    bob_id = bob_user["id"] if bob_user else None
    if bob_id:
        bob_db = db.users.find_one({"id": bob_id})
        record("A", "Bob.family_group_id == Alice.family_group_id",
               bob_db and bob_db.get("family_group_id") == alice_gid,
               f"bob_gid={bob_db and bob_db.get('family_group_id')} alice_gid={alice_gid}")

    r = requests.get(f"{API}/family-group/invites", headers=auth_headers(alice_jwt), timeout=10)
    inv_list = r.json().get("invites", []) if r.status_code == 200 else []
    bob_row = next((i for i in inv_list if i.get("token") == bob_token), None)
    record("A", "Bob's invite now status=accepted",
           bool(bob_row) and bob_row.get("status") == "accepted", f"row={bob_row}")
    bob_db_invite = db.family_invites.find_one({"token": bob_token})
    record("A", "Invite row has accepted_by_user_id=Bob in DB",
           bob_db_invite and bob_db_invite.get("accepted_by_user_id") == bob_id,
           f"db.accepted_by_user_id={bob_db_invite and bob_db_invite.get('accepted_by_user_id')}")

    r = requests.get(f"{API}/family-group", headers=auth_headers(alice_jwt), timeout=10)
    members = r.json().get("members", []) if r.status_code == 200 else []
    emails = {m.get("email", "").lower() for m in members}
    record("A", "GET /family-group members includes Alice + Bob",
           alice_email.lower() in emails and bob_email.lower() in emails, f"emails={emails}")

    # ===== Scenario B: Per-invite token single use =====
    print("\n--- Scenario B: INV- token single-use ---")
    _, _, err = signup_user(third_email, "Third Tester", invite_code=bob_token)
    record("B", "Reusing accepted INV- token rejects signup (404 Invite code not found)",
           err is not None and "404" in err and "Invite code not found" in err,
           err or "unexpected success")

    # ===== Scenario C: Legacy KINN- code =====
    print("\n--- Scenario C: KINN- family-wide code still works ---")
    charlie_jwt, charlie_user, err = signup_user(charlie_email, "Charlie Tester", invite_code=alice_kinn)
    record("C", "Charlie signup with KINN- code", err is None,
           err or f"charlie_id={charlie_user and charlie_user.get('id')}")
    if charlie_user:
        charlie_db = db.users.find_one({"id": charlie_user["id"]})
        record("C", "Charlie joined Alice's family via KINN",
               charlie_db and charlie_db.get("family_group_id") == alice_gid,
               f"charlie_gid={charlie_db and charlie_db.get('family_group_id')}")

    # ===== Scenario D: Revoke flow =====
    print("\n--- Scenario D: Revoke flow ---")
    r = requests.post(
        f"{API}/family-group/invite",
        headers=auth_headers(alice_jwt),
        json={"name": "Dave", "email": dave_email},
        timeout=10,
    )
    ok = r.status_code == 200
    dave_invite = r.json().get("invite", {}) if ok else {}
    dave_token = dave_invite.get("token", "")
    dave_invite_id = dave_invite.get("id")
    record("D", "Create Dave invite", ok and dave_token.startswith("INV-"),
           f"status={r.status_code} token={dave_token}")

    r = requests.delete(
        f"{API}/family-group/invites/{dave_invite_id}",
        headers=auth_headers(alice_jwt),
        timeout=10,
    )
    rj = r.json() if r.status_code == 200 else {}
    record("D", "DELETE invites/{id} -> 200 status=revoked",
           r.status_code == 200 and rj.get("status") == "revoked",
           f"status={r.status_code} body={rj}")

    r = requests.delete(
        f"{API}/family-group/invites/{dave_invite_id}",
        headers=auth_headers(alice_jwt),
        timeout=10,
    )
    rj = r.json() if r.status_code == 200 else {}
    record("D", "Re-DELETE same id idempotent (200, status=revoked)",
           r.status_code == 200 and rj.get("status") == "revoked",
           f"status={r.status_code} body={rj}")

    _, _, err = signup_user(dave_email, "Dave Tester", invite_code=dave_token)
    record("D", "Signup with revoked INV- token -> 404",
           err is not None and "404" in err and "Invite code not found" in err,
           err or "unexpected success")

    # ===== Scenario E: Validation / 4xx =====
    print("\n--- Scenario E: Validation / 4xx ---")
    r = requests.post(
        f"{API}/family-group/invite",
        headers=auth_headers(alice_jwt),
        json={"name": "", "email": "valid@example.com"},
        timeout=10,
    )
    record("E", "POST /invite empty name -> 400",
           r.status_code == 400, f"status={r.status_code} body={r.text[:200]}")

    r = requests.post(
        f"{API}/family-group/invite",
        headers=auth_headers(alice_jwt),
        json={"name": "Someone", "email": ""},
        timeout=10,
    )
    record("E", "POST /invite empty email -> 400/422",
           r.status_code in (400, 422), f"status={r.status_code} body={r.text[:200]}")

    r = requests.post(
        f"{API}/family-group/invite",
        headers=auth_headers(alice_jwt),
        json={"name": "Someone", "email": "not-an-email"},
        timeout=10,
    )
    record("E", "POST /invite invalid email -> 400/422",
           r.status_code in (400, 422), f"status={r.status_code}")

    r = requests.post(
        f"{API}/family-group/invite",
        json={"name": "Someone", "email": "valid@example.com"},
        timeout=10,
    )
    record("E", "POST /invite without auth -> 403", r.status_code == 403,
           f"status={r.status_code}")

    r = requests.delete(
        f"{API}/family-group/invites/{uuid.uuid4()}",
        headers=auth_headers(alice_jwt),
        timeout=10,
    )
    record("E", "DELETE invites/{unknown-id} -> 404", r.status_code == 404,
           f"status={r.status_code}")

    erin_jwt, erin_user, err = signup_user(erin_email, "Erin Tester")
    if err is None and dave_invite_id:
        r = requests.delete(
            f"{API}/family-group/invites/{dave_invite_id}",
            headers=auth_headers(erin_jwt),
            timeout=10,
        )
        record("E", "Erin DELETE Alice's invite -> 404 (tenant scoped)",
               r.status_code == 404, f"status={r.status_code}")
    else:
        record("E", "Erin DELETE Alice's invite -> 404 (tenant scoped)", False,
               f"erin signup failed: {err}")

    # ===== Scenario F: Email fallback =====
    print("\n--- Scenario F: Email delivery falls back gracefully ---")
    fallback_email = rand_email("fallback")
    r = requests.post(
        f"{API}/family-group/invite",
        headers=auth_headers(alice_jwt),
        json={"name": "Fallback Friend", "email": fallback_email},
        timeout=10,
    )
    ok = r.status_code == 200
    rb = r.json() if ok else {}
    fallback_token = rb.get("invite", {}).get("token", "")
    record("F", "POST /invite returns 200 with delivered:false",
           ok and rb.get("delivered") is False and fallback_token.startswith("INV-"),
           f"status={r.status_code} delivered={rb.get('delivered')} token={fallback_token}")
    r = requests.get(f"{API}/family-group/invites", headers=auth_headers(alice_jwt), timeout=10)
    try:
        tokens = {i.get("token") for i in r.json().get("invites", [])}
    except Exception:
        tokens = set()
    record("F", "Fallback invite is persisted (visible in GET)",
           r.status_code == 200 and fallback_token in tokens,
           f"GET status={r.status_code} in_list={fallback_token in tokens}")
    # Verify directly in DB regardless
    db_inv = db.family_invites.find_one({"token": fallback_token})
    record("F", "Fallback invite persisted in db.family_invites",
           db_inv is not None and db_inv.get("status") == "pending",
           f"db_row={'yes' if db_inv else 'no'}")

    # ===== Scenario H: Tenant isolation =====
    print("\n--- Scenario H: Tenant isolation ---")
    erin_invitee = rand_email("erin-invitee")
    erin_token = ""
    if erin_jwt:
        r = requests.post(
            f"{API}/family-group/invite",
            headers=auth_headers(erin_jwt),
            json={"name": "Erin's Friend", "email": erin_invitee},
            timeout=10,
        )
        ok = r.status_code == 200
        erin_token = r.json().get("invite", {}).get("token", "") if ok else ""
        record("H", "Erin creates her own invite", ok,
               f"status={r.status_code} token={erin_token}")

        r = requests.get(f"{API}/family-group/invites", headers=auth_headers(alice_jwt), timeout=10)
        try:
            alice_tokens = {i.get("token") for i in r.json().get("invites", [])}
        except Exception:
            alice_tokens = set()
        record("H", "Alice's GET /invites excludes Erin's invite",
               r.status_code == 200 and bool(erin_token) and erin_token not in alice_tokens,
               f"GET status={r.status_code} alice_count={len(alice_tokens)} erin_in_alice={erin_token in alice_tokens}")

        r = requests.get(f"{API}/family-group/invites", headers=auth_headers(erin_jwt), timeout=10)
        try:
            erin_tokens = {i.get("token") for i in r.json().get("invites", [])}
        except Exception:
            erin_tokens = set()
        leak = erin_tokens.intersection(alice_tokens)
        record("H", "Erin's GET /invites excludes Alice's invites",
               r.status_code == 200 and not leak and erin_token in erin_tokens,
               f"GET status={r.status_code} erin_count={len(erin_tokens)} leak={leak}")
        # DB-level tenant isolation check (bypasses the buggy GET endpoint)
        erin_gid_db = db.users.find_one({"id": erin_user["id"]}).get("family_group_id")
        alice_db_tokens = {i["token"] for i in db.family_invites.find({"family_group_id": alice_gid}, {"token": 1, "_id": 0})}
        erin_db_tokens = {i["token"] for i in db.family_invites.find({"family_group_id": erin_gid_db}, {"token": 1, "_id": 0})}
        record("H", "DB-level: alice/erin family_invites are partitioned by family_group_id",
               erin_token in erin_db_tokens and erin_token not in alice_db_tokens and bob_token in alice_db_tokens,
               f"alice_db_count={len(alice_db_tokens)} erin_db_count={len(erin_db_tokens)}")

    # ===== Scenario G: Soft cap =====
    print("\n--- Scenario G: Soft cap (51st invite -> 429) ---")
    if os.environ.get("SKIP_SOFT_CAP", "").lower() in ("1", "true", "yes"):
        print("  SKIPPED (SKIP_SOFT_CAP set)")
    elif erin_user:
        erin_gid = db.users.find_one({"id": erin_user["id"]}).get("family_group_id")
        already = db.family_invites.count_documents({"family_group_id": erin_gid, "status": "pending"})
        to_create = 50 - already
        print(f"  Erin pending={already}; creating {to_create} more to hit cap...")
        start = time.time()
        ok_count = 0
        for i in range(to_create):
            r = requests.post(
                f"{API}/family-group/invite",
                headers=auth_headers(erin_jwt),
                json={"name": f"Bulk{i}", "email": f"bulk-{i}-{uuid.uuid4().hex[:6]}@example.com"},
                timeout=10,
            )
            if r.status_code == 200:
                ok_count += 1
            else:
                print(f"  unexpected status at i={i}: {r.status_code} {r.text[:120]}")
                break
        elapsed = time.time() - start
        pending_now = db.family_invites.count_documents({"family_group_id": erin_gid, "status": "pending"})
        print(f"  Created {ok_count} ({elapsed:.1f}s). Pending now={pending_now}")
        r = requests.post(
            f"{API}/family-group/invite",
            headers=auth_headers(erin_jwt),
            json={"name": "Overflow", "email": f"overflow-{uuid.uuid4().hex[:6]}@example.com"},
            timeout=10,
        )
        record("G", "51st invite returns 429 (soft cap)", r.status_code == 429,
               f"status={r.status_code} pending_at_attempt={pending_now} body={r.text[:200]}")

    # ===== Summary =====
    print("\n=== SUMMARY ===")
    passed = sum(1 for _, _, ok, _ in results if ok)
    total = len(results)
    by_scn = {}
    for scn, _, ok, _ in results:
        by_scn.setdefault(scn, [0, 0])
        by_scn[scn][1] += 1
        if ok:
            by_scn[scn][0] += 1
    for scn in sorted(by_scn):
        p, t = by_scn[scn]
        print(f"  {scn}: {p}/{t}")
    print(f"  TOTAL: {passed}/{total}")

    fails = [(s, n, d) for s, n, ok, d in results if not ok]
    if fails:
        print("\nFAILURES:")
        for s, n, d in fails:
            print(f"  [{s}] {n} :: {d}")
    return 0 if passed == total else 2


if __name__ == "__main__":
    sys.exit(main())
