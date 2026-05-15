"""Backend tests for Kinnship Annual subscription plan additions.

Covers tests 1-10 from the review request:
  1) /api/billing/status structure for free demo user
  2) Checkout session - monthly (fresh user)
  3) Checkout session - annual (fresh user)
  4) Default interval (no interval field)
  5) Invalid interval normalization
  6) Annual savings math sanity
  7) Stripe price caching (2nd call succeeds quickly)
  8) Regression - fresh user starts free
  9) Group-aware billing untouched
 10) Plan label resolution for free user
"""
from __future__ import annotations

import random
import string
import sys
import time
from typing import Any, Dict, Optional, Tuple

import requests

BASE = "https://family-guard-37.preview.emergentagent.com/api"
DEMO_EMAIL = "demo@kinnship.app"
DEMO_PASSWORD = "password123"

PASS = "PASS"
FAIL = "FAIL"

results: Dict[str, Tuple[str, str]] = {}


def record(test_id: str, status: str, detail: str = "") -> None:
    results[test_id] = (status, detail)
    marker = "[+]" if status == PASS else "[-]"
    print(f"{marker} {test_id}: {status} {detail}")


def _rand() -> str:
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=8))


def login(email: str, password: str) -> str:
    r = requests.post(f"{BASE}/auth/login", json={"email": email, "password": password}, timeout=30)
    assert r.status_code == 200, f"login failed {r.status_code}: {r.text}"
    return r.json()["access_token"]


def signup(email: str, password: str, full_name: str = "QA Annual Tester") -> str:
    r = requests.post(
        f"{BASE}/auth/signup",
        json={"email": email, "password": password, "full_name": full_name},
        timeout=30,
    )
    assert r.status_code == 200, f"signup failed {r.status_code}: {r.text}"
    return r.json()["access_token"]


def auth(token: str) -> Dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def get_status(token: str) -> Dict[str, Any]:
    r = requests.get(f"{BASE}/billing/status", headers=auth(token), timeout=30)
    assert r.status_code == 200, f"/billing/status {r.status_code}: {r.text}"
    return r.json()


# ----- Test 1 -----------------------------------------------------------------
def test_1_demo_status() -> Optional[Dict[str, Any]]:
    try:
        token = login(DEMO_EMAIL, DEMO_PASSWORD)
    except AssertionError as e:
        record("T1", FAIL, str(e))
        return None
    status = get_status(token)
    errs = []
    if status.get("plan") != "free":
        errs.append(f"plan!=free (got {status.get('plan')!r})")
    if status.get("plan_label") is not None:
        errs.append(f"plan_label!=None (got {status.get('plan_label')!r})")
    if status.get("interval") is not None:
        errs.append(f"interval!=None (got {status.get('interval')!r})")
    if status.get("member_limit") != 2:
        errs.append(f"member_limit!=2 (got {status.get('member_limit')!r})")
    mc = status.get("member_count")
    if not isinstance(mc, int) or mc < 0:
        errs.append(f"member_count not int>=0 (got {mc!r})")

    paid = status.get("paid_plan") or {}
    if paid.get("amount_cents") != 999:
        errs.append(f"paid_plan.amount_cents!=999 (got {paid.get('amount_cents')!r})")
    if paid.get("currency") != "usd":
        errs.append(f"paid_plan.currency!=usd (got {paid.get('currency')!r})")
    if paid.get("interval") != "month":
        errs.append(f"paid_plan.interval!=month (got {paid.get('interval')!r})")
    if paid.get("product_name") != "Kinnship Family Plan":
        errs.append(f"paid_plan.product_name!='Kinnship Family Plan' (got {paid.get('product_name')!r})")

    plans = status.get("paid_plans")
    if not isinstance(plans, list) or len(plans) != 2:
        errs.append(f"paid_plans not list of 2 (got {plans!r})")
    else:
        exp_month = {
            "interval": "month", "label": "Monthly", "amount_cents": 999,
            "currency": "usd", "product_name": "Kinnship Family Plan",
            "is_recommended": False, "savings_cents": 0,
        }
        exp_year = {
            "interval": "year", "label": "Annual", "amount_cents": 9999,
            "currency": "usd", "product_name": "Kinnship Family Plan",
            "is_recommended": True, "savings_cents": 1989,
        }
        by_iv = {p.get("interval"): p for p in plans}
        for label, exp in (("monthly", exp_month), ("annual", exp_year)):
            got = by_iv.get(exp["interval"])
            if not got:
                errs.append(f"paid_plans missing {label} entry")
                continue
            for k, v in exp.items():
                if got.get(k) != v:
                    errs.append(f"paid_plans[{label}].{k}!={v!r} (got {got.get(k)!r})")

    if status.get("annual_savings_cents") != 1989:
        errs.append(f"annual_savings_cents!=1989 (got {status.get('annual_savings_cents')!r})")

    if errs:
        record("T1", FAIL, "; ".join(errs))
    else:
        record("T1", PASS, "billing/status structure matches expectations")
    return status


# ----- Tests 2-5: checkout-session variants -----------------------------------
def _do_checkout(token: str, body: Dict[str, Any]) -> requests.Response:
    return requests.post(
        f"{BASE}/billing/checkout-session",
        headers=auth(token),
        json=body,
        timeout=60,
    )


def test_2_checkout_monthly() -> Tuple[Optional[str], Optional[float]]:
    email = f"monthly_{_rand()}@example.com"
    try:
        token = signup(email, "password123", full_name="Monthly QA")
    except AssertionError as e:
        record("T2", FAIL, f"signup: {e}")
        return None, None
    t0 = time.time()
    r = _do_checkout(token, {
        "success_url": "http://localhost:3000/upgrade?status=success",
        "cancel_url": "http://localhost:3000/upgrade?status=cancel",
        "interval": "month",
    })
    dt = time.time() - t0
    if r.status_code != 200:
        record("T2", FAIL, f"status {r.status_code}: {r.text}")
        return token, dt
    j = r.json()
    errs = []
    url = j.get("checkout_url")
    sid = j.get("session_id")
    if not (isinstance(url, str) and url.startswith("https://checkout.stripe.com/")):
        errs.append(f"checkout_url bad: {url!r}")
    if not (isinstance(sid, str) and sid.startswith("cs_")):
        errs.append(f"session_id bad: {sid!r}")
    if j.get("interval") != "month":
        errs.append(f"interval!=month (got {j.get('interval')!r})")
    if errs:
        record("T2", FAIL, "; ".join(errs))
    else:
        record("T2", PASS, f"monthly checkout 200 in {dt:.2f}s, session_id={sid[:14]}...")
    return token, dt


def test_3_checkout_annual() -> Tuple[Optional[str], Optional[float]]:
    email = f"annual_{_rand()}@example.com"
    try:
        token = signup(email, "password123", full_name="Annual QA")
    except AssertionError as e:
        record("T3", FAIL, f"signup: {e}")
        return None, None
    t0 = time.time()
    r = _do_checkout(token, {
        "success_url": "http://localhost:3000/upgrade?status=success",
        "cancel_url": "http://localhost:3000/upgrade?status=cancel",
        "interval": "year",
    })
    dt = time.time() - t0
    if r.status_code != 200:
        record("T3", FAIL, f"status {r.status_code}: {r.text}")
        return token, dt
    j = r.json()
    errs = []
    url = j.get("checkout_url")
    sid = j.get("session_id")
    if not (isinstance(url, str) and url.startswith("https://checkout.stripe.com/")):
        errs.append(f"checkout_url bad: {url!r}")
    if not (isinstance(sid, str) and sid.startswith("cs_")):
        errs.append(f"session_id bad: {sid!r}")
    if j.get("interval") != "year":
        errs.append(f"interval!=year (got {j.get('interval')!r})")
    if errs:
        record("T3", FAIL, "; ".join(errs))
    else:
        record("T3", PASS, f"annual checkout 200 in {dt:.2f}s, session_id={sid[:14]}...")
    return token, dt


def test_4_default_interval() -> None:
    email = f"defint_{_rand()}@example.com"
    try:
        token = signup(email, "password123", full_name="Default Iv QA")
    except AssertionError as e:
        record("T4", FAIL, f"signup: {e}")
        return
    r = _do_checkout(token, {
        "success_url": "http://localhost:3000/upgrade?status=success",
        "cancel_url": "http://localhost:3000/upgrade?status=cancel",
    })
    if r.status_code != 200:
        record("T4", FAIL, f"status {r.status_code}: {r.text}")
        return
    iv = r.json().get("interval")
    if iv != "month":
        record("T4", FAIL, f"interval!=month (got {iv!r})")
    else:
        record("T4", PASS, "interval defaulted to month when omitted")


def test_5_invalid_interval() -> None:
    email = f"badint_{_rand()}@example.com"
    try:
        token = signup(email, "password123", full_name="BadIv QA")
    except AssertionError as e:
        record("T5", FAIL, f"signup: {e}")
        return
    r = _do_checkout(token, {
        "success_url": "http://localhost:3000/upgrade?status=success",
        "cancel_url": "http://localhost:3000/upgrade?status=cancel",
        "interval": "daily",
    })
    if r.status_code != 200:
        record("T5", FAIL, f"status {r.status_code}: {r.text}")
        return
    iv = r.json().get("interval")
    if iv != "month":
        record("T5", FAIL, f"interval not sanitized to month (got {iv!r})")
    else:
        record("T5", PASS, "interval='daily' sanitized to month")


# ----- Test 6 -----------------------------------------------------------------
def test_6_savings_math(status: Optional[Dict[str, Any]]) -> None:
    if status is None:
        try:
            token = login(DEMO_EMAIL, DEMO_PASSWORD)
            status = get_status(token)
        except Exception as e:
            record("T6", FAIL, f"could not fetch status: {e}")
            return
    expected = 12 * 999 - 9999
    got = status.get("annual_savings_cents")
    if got != expected:
        record("T6", FAIL, f"annual_savings_cents {got} != {expected}")
    else:
        record("T6", PASS, f"annual_savings_cents=={expected}")


# ----- Test 7 -----------------------------------------------------------------
def test_7_price_caching() -> None:
    email = f"cache_{_rand()}@example.com"
    try:
        token = signup(email, "password123", full_name="Cache QA")
    except AssertionError as e:
        record("T7", FAIL, f"signup: {e}")
        return
    errs = []
    timings = {}
    for iv in ("month", "year"):
        t0 = time.time()
        r = _do_checkout(token, {
            "success_url": "http://localhost:3000/upgrade?status=success",
            "cancel_url": "http://localhost:3000/upgrade?status=cancel",
            "interval": iv,
        })
        dt = time.time() - t0
        timings[iv] = dt
        if r.status_code != 200:
            errs.append(f"repeat {iv} call {r.status_code}: {r.text[:120]}")
            continue
        j = r.json()
        if j.get("interval") != iv:
            errs.append(f"repeat {iv} response interval={j.get('interval')!r}")
        sid = j.get("session_id") or ""
        if not sid.startswith("cs_"):
            errs.append(f"repeat {iv} session_id bad: {sid!r}")
    if errs:
        record("T7", FAIL, "; ".join(errs))
    else:
        record(
            "T7", PASS,
            f"repeat checkout-session for both intervals succeeded "
            f"(month {timings['month']:.2f}s, year {timings['year']:.2f}s)",
        )


# ----- Test 8 -----------------------------------------------------------------
def test_8_fresh_user_free() -> None:
    email = f"free_{_rand()}@example.com"
    try:
        token = signup(email, "password123", full_name="Free QA")
    except AssertionError as e:
        record("T8", FAIL, f"signup: {e}")
        return
    s = get_status(token)
    if s.get("plan") != "free":
        record("T8", FAIL, f"fresh user plan!=free (got {s.get('plan')!r})")
        return
    if s.get("plan_label") is not None:
        record("T8", FAIL, f"fresh user plan_label!=None (got {s.get('plan_label')!r})")
        return
    record("T8", PASS, "fresh signup starts on free plan with plan_label=None")


# ----- Test 9 -----------------------------------------------------------------
def test_9_group_aware() -> None:
    try:
        token = login(DEMO_EMAIL, DEMO_PASSWORD)
    except AssertionError as e:
        record("T9", FAIL, f"login: {e}")
        return
    s = get_status(token)
    fg_count: Optional[int] = None
    r = requests.get(f"{BASE}/family-group", headers=auth(token), timeout=30)
    if r.status_code == 200:
        body = r.json()
        if isinstance(body, dict):
            for key in ("members", "users"):
                v = body.get(key)
                if isinstance(v, list):
                    fg_count = len(v)
                    break
    r2 = requests.get(f"{BASE}/members", headers=auth(token), timeout=30)
    if r2.status_code != 200:
        record("T9", FAIL, f"/members {r2.status_code}: {r2.text}")
        return
    members_list = r2.json()
    if not isinstance(members_list, list):
        record("T9", FAIL, f"/members not list (got {type(members_list).__name__})")
        return
    members_count = len(members_list)
    errs = []
    if s.get("member_limit") != 2:
        errs.append(f"member_limit!=2 (got {s.get('member_limit')!r})")
    if s.get("member_count") != members_count:
        errs.append(f"member_count={s.get('member_count')} != /members len={members_count}")
    expected_remaining = max(0, 2 - s.get("member_count", 0))
    if s.get("members_remaining") != expected_remaining:
        errs.append(f"members_remaining={s.get('members_remaining')} != {expected_remaining}")
    if errs:
        record("T9", FAIL, "; ".join(errs))
    else:
        record(
            "T9", PASS,
            f"member_count={s.get('member_count')} == /members({members_count}); "
            f"member_limit=2; members_remaining={s.get('members_remaining')}"
            + (f"; family-group users={fg_count}" if fg_count is not None else ""),
        )


# ----- Test 10 ----------------------------------------------------------------
def test_10_plan_label_free(status: Optional[Dict[str, Any]]) -> None:
    if status is None:
        try:
            token = login(DEMO_EMAIL, DEMO_PASSWORD)
            status = get_status(token)
        except Exception as e:
            record("T10", FAIL, f"fetch status: {e}")
            return
    if "plan_label" not in status:
        record("T10", FAIL, "plan_label field missing from /billing/status")
        return
    if status.get("plan_label") is not None:
        record("T10", FAIL, f"plan_label!=None for free user (got {status.get('plan_label')!r})")
        return
    record("T10", PASS, "plan_label field present and is None for free user")


def main() -> int:
    print(f"=== Kinnship Annual plan backend tests @ {BASE} ===")
    status = test_1_demo_status()
    test_2_checkout_monthly()
    test_3_checkout_annual()
    test_4_default_interval()
    test_5_invalid_interval()
    test_6_savings_math(status)
    test_7_price_caching()
    test_8_fresh_user_free()
    test_9_group_aware()
    test_10_plan_label_free(status)

    print("\n=== SUMMARY ===")
    n_pass = sum(1 for s, _ in results.values() if s == PASS)
    n_fail = sum(1 for s, _ in results.values() if s == FAIL)
    for tid in sorted(results, key=lambda x: int(x[1:])):
        s, d = results[tid]
        marker = "[+]" if s == PASS else "[-]"
        print(f"{marker} {tid}: {s} - {d}")
    print(f"\nTotals: PASS={n_pass} FAIL={n_fail}")
    return 0 if n_fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
