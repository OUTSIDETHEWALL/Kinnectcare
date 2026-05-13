"""Backend tests for DELETE /api/auth/account endpoint (App Store compliance).

Run: python3 /app/backend_test.py
"""
import os
import sys
import time
import uuid
import json
from typing import Optional, Dict, Any

import requests
from dotenv import dotenv_values


def load_base_url() -> str:
    env = dotenv_values("/app/frontend/.env")
    base = env.get("EXPO_PUBLIC_BACKEND_URL") or env.get("EXPO_BACKEND_URL")
    if not base:
        print("ERROR: EXPO_PUBLIC_BACKEND_URL not found in /app/frontend/.env")
        sys.exit(1)
    return base.rstrip("/") + "/api"


BASE = load_base_url()
print(f"BASE = {BASE}")

results = []  # list of (name, ok, detail)


def record(name: str, ok: bool, detail: str = ""):
    flag = "PASS" if ok else "FAIL"
    print(f"  [{flag}] {name}: {detail}")
    results.append((name, ok, detail))


def req(method: str, path: str, token: Optional[str] = None, json_body=None, raw_body: Optional[str] = None) -> requests.Response:
    url = BASE + path
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if raw_body is not None:
        headers["Content-Type"] = "application/json"
        return requests.request(method, url, headers=headers, data=raw_body, timeout=30)
    return requests.request(method, url, headers=headers, json=json_body, timeout=30)


def signup_user() -> Dict[str, Any]:
    email = f"delete_test_{uuid.uuid4().hex[:8]}@example.com"
    pw = "password123"
    r = req("POST", "/auth/signup", json_body={
        "email": email, "password": pw, "full_name": "Delete Tester"
    })
    if r.status_code != 200:
        raise RuntimeError(f"signup failed: {r.status_code} {r.text}")
    body = r.json()
    return {
        "email": email,
        "password": pw,
        "token": body["access_token"],
        "user": body["user"],
    }


# ============================================================
# SECTION 1 — Negative tests for DELETE /api/auth/account
# ============================================================
print("\n=== 1) Negative — missing/invalid confirm ===")
try:
    u = signup_user()
    print(f"  signed up: {u['email']}")
    token = u["token"]
    user_id = u["user"]["id"]

    # Verify seed counts via GET /members and reminders.
    rm = req("GET", "/members", token=token)
    members = rm.json() if rm.status_code == 200 else []
    record("seed members count >= 2", len(members) >= 2, f"got {len(members)}")

    reminder_total = 0
    for m in members:
        r2 = req("GET", f"/reminders/member/{m['id']}", token=token)
        if r2.status_code == 200:
            reminder_total += len(r2.json())
    record("seed reminders total >= 7", reminder_total >= 7, f"got {reminder_total}")

    # 1a. No body
    r = req("DELETE", "/auth/account", token=token, raw_body="")
    record("DELETE no body -> 400/422", r.status_code in (400, 422), f"got {r.status_code}")

    # 1b. Empty confirm
    r = req("DELETE", "/auth/account", token=token, json_body={"confirm": ""})
    record("DELETE confirm='' -> 400", r.status_code == 400, f"got {r.status_code} body={r.text[:120]}")

    # 1c. Wrong confirm
    r = req("DELETE", "/auth/account", token=token, json_body={"confirm": "nope"})
    record("DELETE confirm='nope' -> 400", r.status_code == 400, f"got {r.status_code}")

    # 1d. Verify user still exists
    rme = req("GET", "/auth/me", token=token)
    record("GET /auth/me still 200 after failed deletes", rme.status_code == 200, f"got {rme.status_code}")

    # ============================================================
    # SECTION 2 — Happy path on the SAME free user
    # ============================================================
    print("\n=== 2) Happy path — free user ===")
    r = req("DELETE", "/auth/account", token=token, json_body={"confirm": "DELETE"})
    record("DELETE confirm='DELETE' -> 200", r.status_code == 200, f"got {r.status_code} body={r.text[:200]}")
    body = r.json() if r.status_code == 200 else {}
    record("response.ok == True", body.get("ok") is True, f"ok={body.get('ok')}")
    deleted = body.get("deleted") or {}
    record("deleted.members >= 2", (deleted.get("members") or 0) >= 2, f"members={deleted.get('members')}")
    record("deleted.reminders >= 7", (deleted.get("reminders") or 0) >= 7, f"reminders={deleted.get('reminders')}")
    record("deleted.alerts >= 2", (deleted.get("alerts") or 0) >= 2, f"alerts={deleted.get('alerts')}")
    record("deleted has checkins key", "checkins" in deleted, f"checkins={deleted.get('checkins')}")
    record("deleted has medication_logs key", "medication_logs" in deleted, f"medication_logs={deleted.get('medication_logs')}")
    record("stripe_subscription_canceled == False", body.get("stripe_subscription_canceled") is False,
           f"got {body.get('stripe_subscription_canceled')}")
    record("stripe_customer_deleted == False", body.get("stripe_customer_deleted") is False,
           f"got {body.get('stripe_customer_deleted')}")

    # User truly gone — old token returns 401/403, login fails
    rme = req("GET", "/auth/me", token=token)
    record("GET /auth/me after delete -> 401/403", rme.status_code in (401, 403), f"got {rme.status_code}")

    rlogin = req("POST", "/auth/login", json_body={"email": u["email"], "password": u["password"]})
    record("login deleted user -> 401", rlogin.status_code == 401, f"got {rlogin.status_code}")

except Exception as e:
    record("Section 1+2 exception", False, repr(e))


# ============================================================
# SECTION 3 — Paid user with real Stripe customer
# ============================================================
print("\n=== 3) Happy path — paid user with Stripe customer ===")
try:
    u2 = signup_user()
    print(f"  signed up: {u2['email']}")
    token2 = u2["token"]
    user_id2 = u2["user"]["id"]

    # Create checkout session (creates real Stripe customer)
    r = req("POST", "/billing/checkout-session", token=token2, json_body={
        "success_url": "https://example.com/ok",
        "cancel_url": "https://example.com/cancel",
    })
    record("POST /billing/checkout-session -> 200", r.status_code == 200, f"got {r.status_code} body={r.text[:200]}")

    # Fetch billing/status to get customer_id
    rs = req("GET", "/billing/status", token=token2)
    record("GET /billing/status -> 200", rs.status_code == 200, f"got {rs.status_code}")
    status_body = rs.json() if rs.status_code == 200 else {}
    customer_id = status_body.get("stripe_customer_id")
    record("stripe_customer_id starts with cus_", bool(customer_id and customer_id.startswith("cus_")),
           f"customer_id={customer_id}")

    # Simulate active subscription with FAKE sub_id but REAL customer
    now = int(time.time())
    webhook_body = {
        "type": "customer.subscription.updated",
        "data": {
            "object": {
                "id": "sub_test_delete_001",
                "customer": customer_id,
                "status": "active",
                "current_period_end": now + 30 * 86400,
                "current_period_start": now,
                "metadata": {"kinnect_user_id": user_id2},
            }
        }
    }
    rw = req("POST", "/billing/webhook", json_body=webhook_body)
    record("POST /billing/webhook updated -> 200", rw.status_code == 200, f"got {rw.status_code} body={rw.text[:200]}")

    rs2 = req("GET", "/billing/status", token=token2)
    sb2 = rs2.json() if rs2.status_code == 200 else {}
    record("plan == family_plan", sb2.get("plan") == "family_plan", f"got plan={sb2.get('plan')}")
    record("status == active", sb2.get("status") == "active", f"got status={sb2.get('status')}")

    # Now DELETE
    r = req("DELETE", "/auth/account", token=token2, json_body={"confirm": "DELETE"})
    record("DELETE paid user -> 200", r.status_code == 200, f"got {r.status_code} body={r.text[:300]}")
    body = r.json() if r.status_code == 200 else {}
    record("ok == True (paid)", body.get("ok") is True, f"ok={body.get('ok')}")
    sc = body.get("stripe_subscription_canceled")
    cd = body.get("stripe_customer_deleted")
    record("stripe_subscription_canceled is bool", isinstance(sc, bool),
           f"got {sc} (False acceptable because fake sub_id)")
    record("stripe_customer_deleted == True (real customer)", cd is True,
           f"got {cd}")
    deleted2 = body.get("deleted") or {}
    record("deleted has members key (paid)", "members" in deleted2, f"members={deleted2.get('members')}")

    # post-deletion auth
    rme = req("GET", "/auth/me", token=token2)
    record("paid user /auth/me after delete -> 401/403", rme.status_code in (401, 403), f"got {rme.status_code}")

    rlogin = req("POST", "/auth/login", json_body={"email": u2["email"], "password": u2["password"]})
    record("login deleted paid user -> 401", rlogin.status_code == 401, f"got {rlogin.status_code}")

except Exception as e:
    record("Section 3 exception", False, repr(e))


# ============================================================
# SECTION 4 — Demo user regression (MUST NOT BE DELETED)
# ============================================================
print("\n=== 4) Demo user regression ===")
try:
    r = req("POST", "/auth/login", json_body={
        "email": "demo@kinnectcare.app", "password": "password123"
    })
    record("demo login -> 200", r.status_code == 200, f"got {r.status_code}")
    demo_token = r.json()["access_token"] if r.status_code == 200 else None

    rme = req("GET", "/auth/me", token=demo_token)
    record("demo /auth/me -> 200", rme.status_code == 200, f"got {rme.status_code}")

    rs = req("GET", "/summary", token=demo_token)
    record("demo /summary -> 200", rs.status_code == 200, f"got {rs.status_code}")
    if rs.status_code == 200:
        members = rs.json().get("members") or []
        record("demo /summary has members", len(members) >= 1, f"got {len(members)} members")

    rm = req("GET", "/members", token=demo_token)
    record("demo /members -> 200", rm.status_code == 200, f"got {rm.status_code}")
    if rm.status_code == 200:
        record("demo has members not deleted", len(rm.json()) >= 1, f"got {len(rm.json())}")

except Exception as e:
    record("Section 4 exception", False, repr(e))


# ============================================================
# Summary
# ============================================================
print("\n" + "=" * 60)
total = len(results)
passed = sum(1 for _, ok, _ in results if ok)
print(f"RESULT: {passed}/{total} passed")
failed = [(n, d) for n, ok, d in results if not ok]
if failed:
    print("\nFAILURES:")
    for n, d in failed:
        print(f"  - {n}: {d}")
sys.exit(0 if passed == total else 1)
