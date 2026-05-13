"""KinnectCare backend tests: Stripe billing + free-tier member limit + regressions."""
from __future__ import annotations

import os
import sys
import time
import uuid
from typing import Dict, Optional, Tuple

import requests


def _read_env(path: str) -> Dict[str, str]:
    env: Dict[str, str] = {}
    if not os.path.isfile(path):
        return env
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


FRONT_ENV = _read_env("/app/frontend/.env")
BASE = (
    FRONT_ENV.get("EXPO_PUBLIC_BACKEND_URL")
    or FRONT_ENV.get("EXPO_BACKEND_URL")
    or "https://family-guard-37.preview.emergentagent.com"
).rstrip("/")
API = f"{BASE}/api"

DEMO_EMAIL = "demo@kinnectcare.app"
DEMO_PASSWORD = "password123"


class R:
    results: list = []

    @classmethod
    def add(cls, name: str, ok: bool, info: str = "") -> bool:
        cls.results.append((name, bool(ok), info))
        print(f"[{'PASS' if ok else 'FAIL'}] {name}  {info}")
        return bool(ok)

    @classmethod
    def summary(cls) -> int:
        passed = sum(1 for _, ok, _ in cls.results if ok)
        total = len(cls.results)
        print(f"\n==== SUMMARY: {passed}/{total} passed ====")
        for n, ok, info in cls.results:
            if not ok:
                print(f"  - FAIL {n}: {info}")
        return 0 if passed == total else 1


def login(email: str, password: str) -> Tuple[Optional[str], Optional[dict]]:
    r = requests.post(f"{API}/auth/login", json={"email": email, "password": password}, timeout=30)
    if r.status_code != 200:
        return None, None
    j = r.json()
    return j.get("access_token"), j.get("user")


def signup(email: str, password: str, full_name: str = "Billing Tester") -> Tuple[Optional[str], Optional[dict]]:
    r = requests.post(
        f"{API}/auth/signup",
        json={"email": email, "password": password, "full_name": full_name},
        timeout=30,
    )
    if r.status_code != 200:
        print(f"signup failed: {r.status_code} {r.text}")
        return None, None
    j = r.json()
    return j.get("access_token"), j.get("user")


def H(token: str) -> Dict[str, str]:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


print(f"== Using API: {API}")

# ====================================================================
# T1 demo /billing/status
# ====================================================================
print("\n== TEST 1: demo /billing/status ==")
token, user = login(DEMO_EMAIL, DEMO_PASSWORD)
R.add("T1 demo login", token is not None, f"user={user and user.get('email')}")

if token:
    r = requests.get(f"{API}/billing/status", headers=H(token), timeout=30)
    R.add("T1 GET /billing/status 200", r.status_code == 200, f"st={r.status_code}")
    if r.status_code == 200:
        s = r.json()
        R.add("T1 plan==free", s.get("plan") == "free", f"plan={s.get('plan')}")
        R.add("T1 member_limit==2", s.get("member_limit") == 2, f"limit={s.get('member_limit')}")
        pp = s.get("paid_plan") or {}
        R.add("T1 paid_plan.amount_cents==999", pp.get("amount_cents") == 999, f"amt={pp.get('amount_cents')}")
        R.add("T1 paid_plan.currency==usd", pp.get("currency") == "usd", f"cur={pp.get('currency')}")
        R.add("T1 paid_plan.interval==month", pp.get("interval") == "month", f"int={pp.get('interval')}")
        pname = pp.get("product_name") or ""
        R.add("T1 paid_plan.product_name has 'KinnectCare Family Plan'",
              "KinnectCare Family Plan" in pname, f"pname={pname}")
        mc = s.get("member_count")
        R.add("T1 member_count>=2", isinstance(mc, int) and mc >= 2, f"mc={mc}")
        mr = s.get("members_remaining")
        exp = max(0, 2 - int(mc or 0))
        R.add("T1 members_remaining==max(0,2-count)", mr == exp, f"mr={mr} expected={exp}")

# ====================================================================
# T2 fresh user 402 paywall
# ====================================================================
print("\n== TEST 2: fresh user member-limit 402 ==")
rand = uuid.uuid4().hex[:10]
new_email = f"billing_test_{rand}@example.com"
fr_token, fr_user = signup(new_email, "password123")
R.add("T2 signup fresh user", fr_token is not None, f"email={new_email}")
fr_user_id = (fr_user or {}).get("id") if fr_user else None

if fr_token:
    r = requests.get(f"{API}/billing/status", headers=H(fr_token), timeout=30)
    R.add("T2 /billing/status 200", r.status_code == 200, f"st={r.status_code}")
    if r.status_code == 200:
        s = r.json()
        R.add("T2 plan==free", s.get("plan") == "free", f"plan={s.get('plan')}")
        R.add("T2 member_count==2", s.get("member_count") == 2, f"mc={s.get('member_count')}")
        R.add("T2 members_remaining==0", s.get("members_remaining") == 0, f"mr={s.get('members_remaining')}")

    payload = {"name": "Test 3rd", "age": 40, "phone": "+1-555-0000", "gender": "Male"}
    r = requests.post(f"{API}/members", json=payload, headers=H(fr_token), timeout=30)
    R.add("T2 POST /members (3rd) -> 402", r.status_code == 402, f"st={r.status_code} body={r.text[:300]}")
    if r.status_code == 402:
        detail = r.json().get("detail")
        R.add("T2 detail is dict", isinstance(detail, dict), f"detail={detail}")
        if isinstance(detail, dict):
            R.add("T2 paywall==true", detail.get("paywall") is True, str(detail.get("paywall")))
            R.add("T2 code==member_limit_reached",
                  detail.get("code") == "member_limit_reached", str(detail.get("code")))
            R.add("T2 limit==2", detail.get("limit") == 2, str(detail.get("limit")))
            R.add("T2 current==2", detail.get("current") == 2, str(detail.get("current")))

# ====================================================================
# T3 checkout-session
# ====================================================================
print("\n== TEST 3: checkout-session ==")
fresh_customer_id = None
if fr_token:
    r = requests.post(
        f"{API}/billing/checkout-session",
        json={"success_url": "https://example.com/ok", "cancel_url": "https://example.com/cancel"},
        headers=H(fr_token),
        timeout=60,
    )
    R.add("T3 checkout-session 200", r.status_code == 200, f"st={r.status_code} body={r.text[:300]}")
    if r.status_code == 200:
        j = r.json()
        co_url = j.get("checkout_url") or ""
        R.add("T3 checkout_url startswith https://checkout.stripe.com/",
              co_url.startswith("https://checkout.stripe.com/"), f"url={co_url[:80]}")
        R.add("T3 session_id non-empty", bool(j.get("session_id")), f"sid={j.get('session_id')}")
        pk = j.get("publishable_key") or ""
        R.add("T3 publishable_key startswith pk_test_", pk.startswith("pk_test_"), f"pk={pk[:12]}")

    r = requests.get(f"{API}/billing/status", headers=H(fr_token), timeout=30)
    R.add("T3 /billing/status 200 post-checkout", r.status_code == 200, f"st={r.status_code}")
    if r.status_code == 200:
        fresh_customer_id = (r.json().get("stripe_customer_id") or "")
        R.add("T3 stripe_customer_id startswith cus_",
              isinstance(fresh_customer_id, str) and fresh_customer_id.startswith("cus_"),
              f"cust={fresh_customer_id}")

# ====================================================================
# T4 webhook activation
# ====================================================================
print("\n== TEST 4: webhook activate subscription ==")
if fr_token and fresh_customer_id and fr_user_id:
    future_unix = int(time.time()) + 30 * 86400
    body = {
        "type": "customer.subscription.updated",
        "data": {"object": {
            "id": "sub_test_unit_001",
            "customer": fresh_customer_id,
            "status": "active",
            "current_period_end": future_unix,
            "current_period_start": future_unix - 30 * 86400,
            "metadata": {"kinnect_user_id": fr_user_id},
        }},
    }
    r = requests.post(f"{API}/billing/webhook", json=body, timeout=30)
    R.add("T4 webhook 200", r.status_code == 200, f"st={r.status_code} body={r.text[:300]}")
    if r.status_code == 200:
        R.add("T4 webhook status==ok", r.json().get("status") == "ok", r.text)

    r = requests.get(f"{API}/billing/status", headers=H(fr_token), timeout=30)
    R.add("T4 /billing/status 200 post-activation", r.status_code == 200, f"st={r.status_code}")
    if r.status_code == 200:
        s = r.json()
        R.add("T4 plan==family_plan", s.get("plan") == "family_plan", f"plan={s.get('plan')}")
        R.add("T4 status==active", s.get("status") == "active", f"status={s.get('status')}")
        R.add("T4 member_limit is null", s.get("member_limit") is None, f"limit={s.get('member_limit')}")
        R.add("T4 members_remaining is null", s.get("members_remaining") is None, f"mr={s.get('members_remaining')}")
        cpe = s.get("current_period_end")
        try:
            from datetime import datetime
            ok_iso = isinstance(cpe, str) and bool(datetime.fromisoformat(cpe.replace("Z", "+00:00")))
        except Exception:
            ok_iso = False
        R.add("T4 current_period_end is ISO string", ok_iso, f"cpe={cpe}")

    payload = {"name": "Paid Member 3", "age": 33, "phone": "+1-555-0303", "gender": "Female"}
    r = requests.post(f"{API}/members", json=payload, headers=H(fr_token), timeout=30)
    R.add("T4 POST /members (3rd after paid) -> 200",
          r.status_code == 200, f"st={r.status_code} body={r.text[:200]}")

# ====================================================================
# T5 webhook cancellation
# ====================================================================
print("\n== TEST 5: webhook cancellation ==")
if fr_token and fresh_customer_id:
    body = {
        "type": "customer.subscription.deleted",
        "data": {"object": {"id": "sub_test_unit_001", "customer": fresh_customer_id}},
    }
    r = requests.post(f"{API}/billing/webhook", json=body, timeout=30)
    R.add("T5 webhook 200", r.status_code == 200, f"body={r.text[:200]}")
    if r.status_code == 200:
        R.add("T5 status==ok", r.json().get("status") == "ok", r.text)

    r = requests.get(f"{API}/billing/status", headers=H(fr_token), timeout=30)
    R.add("T5 /billing/status 200", r.status_code == 200, f"st={r.status_code}")
    if r.status_code == 200:
        s = r.json()
        R.add("T5 plan==free", s.get("plan") == "free", f"plan={s.get('plan')}")
        R.add("T5 status==canceled", s.get("status") == "canceled", f"status={s.get('status')}")
        R.add("T5 member_limit==2", s.get("member_limit") == 2, f"limit={s.get('member_limit')}")

    payload = {"name": "Cancelled Member 4", "age": 44, "phone": "+1-555-0404", "gender": "Male"}
    r = requests.post(f"{API}/members", json=payload, headers=H(fr_token), timeout=30)
    R.add("T5 POST /members (4th) -> 402 after cancel",
          r.status_code == 402, f"st={r.status_code} body={r.text[:200]}")

# ====================================================================
# T6 billing_config doc exists
# ====================================================================
print("\n== TEST 6: billing_config in Mongo ==")
try:
    from pymongo import MongoClient

    bk = _read_env("/app/backend/.env")
    mc = MongoClient(bk.get("MONGO_URL", "mongodb://localhost:27017"), serverSelectionTimeoutMS=5000)
    cfg = mc[bk.get("DB_NAME", "test_database")]["billing_config"].find_one({"key": "price"})
    R.add("T6 billing_config price doc exists", cfg is not None, f"found={bool(cfg)}")
    if cfg:
        pid = str(cfg.get("product_id") or "")
        prid = str(cfg.get("price_id") or "")
        R.add("T6 product_id starts with prod_", pid.startswith("prod_"), f"pid={pid}")
        R.add("T6 price_id starts with price_", prid.startswith("price_"), f"price_id={prid}")
        R.add("T6 amount_cents==999", cfg.get("amount_cents") == 999, f"amt={cfg.get('amount_cents')}")
except Exception as e:
    R.add("T6 mongo lookup", False, f"err={e}")

# ====================================================================
# T7 negative auth
# ====================================================================
print("\n== TEST 7: negative auth ==")
r = requests.get(f"{API}/billing/status", timeout=30)
R.add("T7 /billing/status no auth -> 401/403", r.status_code in (401, 403), f"st={r.status_code}")
r = requests.post(
    f"{API}/billing/checkout-session",
    json={"success_url": "https://example.com/ok", "cancel_url": "https://example.com/cancel"},
    timeout=30,
)
R.add("T7 /billing/checkout-session no auth -> 401/403", r.status_code in (401, 403), f"st={r.status_code}")

# ====================================================================
# T8 regression
# ====================================================================
print("\n== TEST 8: regression ==")
token2, _ = login(DEMO_EMAIL, DEMO_PASSWORD)
R.add("T8 /auth/login still works", token2 is not None)
if token2:
    r = requests.get(f"{API}/auth/me", headers=H(token2), timeout=30)
    R.add("T8 /auth/me 200", r.status_code == 200, f"st={r.status_code}")
    r = requests.get(f"{API}/summary", headers=H(token2), timeout=30)
    R.add("T8 /summary 200", r.status_code == 200, f"st={r.status_code}")
    if r.status_code == 200:
        R.add("T8 /summary has members list", isinstance(r.json().get("members"), list))
    r = requests.get(f"{API}/members", headers=H(token2), timeout=30)
    R.add("T8 /members 200", r.status_code == 200, f"st={r.status_code}")

sys.exit(R.summary())
