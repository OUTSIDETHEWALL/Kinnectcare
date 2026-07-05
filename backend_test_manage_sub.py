"""Tests for Kinnship Manage Subscription endpoints:
   GET  /api/billing/status
   POST /api/billing/cancel
   POST /api/billing/resume
Demo user is on FREE plan; cancel/resume must NOT touch live Stripe charges.
"""
import json
import sys
import requests

BASE = "https://family-guard-37.preview.emergentagent.com/api"
EMAIL = "demo@kinnship.app"
PASSWORD = "password123"

results = []


def record(name, ok, detail=""):
    status = "PASS" if ok else "FAIL"
    print(f"[{status}] {name} :: {detail}")
    results.append((name, ok, detail))


def main():
    # 1. Login
    r = requests.post(f"{BASE}/auth/login", json={"email": EMAIL, "password": PASSWORD}, timeout=30)
    record("POST /api/auth/login -> 200", r.status_code == 200, f"status={r.status_code}")
    if r.status_code != 200:
        print("Cannot continue without auth.")
        print(r.text[:500])
        return summarize()
    body = r.json()
    token = body.get("access_token")
    record("login returns access_token", bool(token), f"token_len={len(token or '')}")
    headers = {"Authorization": f"Bearer {token}"}

    # 2. GET /api/billing/status
    r = requests.get(f"{BASE}/billing/status", headers=headers, timeout=30)
    record("GET /api/billing/status -> 200", r.status_code == 200, f"status={r.status_code}")
    if r.status_code != 200:
        print(r.text[:500])
    else:
        st = r.json()
        print("billing/status body:", json.dumps(st, indent=2, default=str)[:1500])
        # Validate shape
        required_keys = ["plan", "member_count", "member_limit", "paid_plan",
                         "paid_plans", "cancel_at_period_end"]
        missing = [k for k in required_keys if k not in st]
        record("billing/status has all required keys", not missing,
               f"missing={missing}")
        record("plan is free|family_plan", st.get("plan") in ("free", "family_plan"),
               f"plan={st.get('plan')!r}")
        record("member_count is int", isinstance(st.get("member_count"), int),
               f"value={st.get('member_count')!r}")
        record("member_limit is int or None",
               st.get("member_limit") is None or isinstance(st.get("member_limit"), int),
               f"value={st.get('member_limit')!r}")
        record("paid_plan is object", isinstance(st.get("paid_plan"), dict),
               f"type={type(st.get('paid_plan')).__name__}")
        if isinstance(st.get("paid_plan"), dict):
            pp = st["paid_plan"]
            for k in ("amount_cents", "currency", "interval", "product_name"):
                record(f"paid_plan.{k} present", k in pp, f"value={pp.get(k)!r}")
        record("paid_plans is array", isinstance(st.get("paid_plans"), list),
               f"type={type(st.get('paid_plans')).__name__}")
        if isinstance(st.get("paid_plans"), list):
            record("paid_plans non-empty", len(st["paid_plans"]) > 0,
                   f"len={len(st['paid_plans'])}")
        record("cancel_at_period_end is bool",
               isinstance(st.get("cancel_at_period_end"), bool),
               f"value={st.get('cancel_at_period_end')!r}")
        # Optional keys (just log what we see)
        print(f"  optional current_period_end = {st.get('current_period_end')!r}")
        print(f"  optional manage_url        = {st.get('manage_url')!r}")
        print(f"  plan resolved             = {st.get('plan')!r}")

    # 3. POST /api/billing/cancel (demo is free -> immediate True expected)
    r = requests.post(f"{BASE}/billing/cancel", headers=headers, timeout=30)
    record("POST /api/billing/cancel -> 200", r.status_code == 200,
           f"status={r.status_code}")
    if r.status_code == 200:
        cb = r.json()
        print("cancel body:", json.dumps(cb, indent=2, default=str)[:800])
        record("cancel response has cancelled=true", cb.get("cancelled") is True,
               f"cancelled={cb.get('cancelled')!r}")
        record("cancel response has immediate bool",
               isinstance(cb.get("immediate"), bool),
               f"immediate={cb.get('immediate')!r}")
        record("cancel response has billing_status object",
               isinstance(cb.get("billing_status"), dict),
               f"type={type(cb.get('billing_status')).__name__}")
        bs = cb.get("billing_status") or {}
        record("billing_status.plan == 'free' for demo (free user expected)",
               bs.get("plan") == "free",
               f"plan={bs.get('plan')!r}")
        # If demo was free and no sub_id, immediate should be True
        record("immediate=True for free demo (expected branch)",
               cb.get("immediate") is True,
               f"immediate={cb.get('immediate')!r}")
    else:
        print(r.text[:500])

    # Idempotency — call again
    r2 = requests.post(f"{BASE}/billing/cancel", headers=headers, timeout=30)
    record("POST /api/billing/cancel (idempotent 2nd call) -> 200",
           r2.status_code == 200, f"status={r2.status_code}")
    if r2.status_code == 200:
        cb2 = r2.json()
        record("2nd cancel still has cancelled=true",
               cb2.get("cancelled") is True, f"cancelled={cb2.get('cancelled')!r}")

    # 4. POST /api/billing/resume (no sub_id -> {resumed:false})
    r = requests.post(f"{BASE}/billing/resume", headers=headers, timeout=30)
    record("POST /api/billing/resume -> 200", r.status_code == 200,
           f"status={r.status_code}")
    if r.status_code == 200:
        rb = r.json()
        print("resume body:", json.dumps(rb, indent=2, default=str)[:800])
        record("resume response has 'resumed' bool",
               isinstance(rb.get("resumed"), bool),
               f"resumed={rb.get('resumed')!r}")
        record("resume.resumed=False for user without sub_id (expected)",
               rb.get("resumed") is False, f"resumed={rb.get('resumed')!r}")
        record("resume response has billing_status object",
               isinstance(rb.get("billing_status"), dict),
               f"type={type(rb.get('billing_status')).__name__}")
    else:
        print(r.text[:500])

    # 5. Unauthorized check
    r = requests.get(f"{BASE}/billing/status", timeout=30)
    print(f"\nUnauthorized GET /api/billing/status -> {r.status_code}: {r.text[:200]}")
    # Spec says 401 expected. FastAPI HTTPBearer default returns 403.
    # We accept any 4xx but flag exact code.
    record("Unauthorized GET /api/billing/status returns 401",
           r.status_code == 401,
           f"status={r.status_code} (note: FastAPI HTTPBearer often returns 403)")

    return summarize()


def summarize():
    print("\n=========== SUMMARY ===========")
    passed = sum(1 for _, ok, _ in results if ok)
    failed = [(n, d) for n, ok, d in results if not ok]
    print(f"Passed: {passed}/{len(results)}")
    if failed:
        print("Failures:")
        for n, d in failed:
            print(f"  - {n} :: {d}")
    sys.exit(0 if not failed else 1)


if __name__ == "__main__":
    main()
