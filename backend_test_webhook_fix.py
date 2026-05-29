"""Verify Stripe webhook obj.get() AttributeError fix + Manage Subscription regression."""
import json
import sys
import requests

BASE = "https://family-guard-37.preview.emergentagent.com/api"
DEMO_EMAIL = "demo@kinnship.app"
DEMO_PASS = "password123"

results = []


def record(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'} - {name} :: {detail}")


def post_webhook(etype: str, obj: dict):
    body = {"type": etype, "data": {"object": obj}}
    r = requests.post(
        f"{BASE}/billing/webhook",
        data=json.dumps(body),
        headers={"Content-Type": "application/json"},
        timeout=30,
    )
    return r


def main():
    # ---------- 1) checkout.session.completed (no subscription) ----------
    r = post_webhook(
        "checkout.session.completed",
        {"customer": "cus_test_NONEXISTENT_OK", "subscription": None, "metadata": {}},
    )
    ok = r.status_code != 500
    record(
        "webhook checkout.session.completed (no 500)",
        ok,
        f"status={r.status_code} body={r.text[:200]}",
    )

    # ---------- 2) customer.subscription.updated ----------
    r = post_webhook(
        "customer.subscription.updated",
        {
            "customer": "cus_test_NONEXISTENT_OK",
            "id": "sub_test_fake_001",
            "status": "active",
            "current_period_end": 9999999999,
            "metadata": {},
            "items": {"data": []},
            "cancel_at_period_end": False,
        },
    )
    ok = r.status_code != 500
    record(
        "webhook customer.subscription.updated (no 500)",
        ok,
        f"status={r.status_code} body={r.text[:200]}",
    )

    # ---------- 3) invoice.paid ----------
    r = post_webhook(
        "invoice.paid",
        {
            "customer": "cus_test_NONEXISTENT_OK",
            "subscription": None,
            "metadata": {},
        },
    )
    ok = r.status_code != 500
    record(
        "webhook invoice.paid (no 500)",
        ok,
        f"status={r.status_code} body={r.text[:200]}",
    )

    # ---------- 4) Regression: Manage Subscription endpoints ----------
    lr = requests.post(
        f"{BASE}/auth/login",
        json={"email": DEMO_EMAIL, "password": DEMO_PASS},
        timeout=30,
    )
    if lr.status_code != 200:
        record("demo login", False, f"status={lr.status_code} body={lr.text[:300]}")
        return summarize()
    token = lr.json()["access_token"]
    hdrs = {"Authorization": f"Bearer {token}"}
    record("demo login", True, "200 OK")

    # GET /billing/status
    r = requests.get(f"{BASE}/billing/status", headers=hdrs, timeout=30)
    ok = r.status_code == 200
    payload = {}
    try:
        payload = r.json()
    except Exception:
        pass
    has_plan = "plan" in payload
    has_paid_plan = "paid_plan" in payload
    record(
        "GET /api/billing/status",
        ok and has_plan and has_paid_plan,
        f"status={r.status_code} plan={payload.get('plan')} keys={list(payload.keys())[:8]}",
    )

    # POST /billing/cancel (free user)
    r = requests.post(f"{BASE}/billing/cancel", headers=hdrs, timeout=30)
    ok = r.status_code == 200
    pj = {}
    try:
        pj = r.json()
    except Exception:
        pass
    cancelled = pj.get("cancelled") is True
    immediate = pj.get("immediate") is True
    record(
        "POST /api/billing/cancel (free user)",
        ok and cancelled and immediate,
        f"status={r.status_code} cancelled={pj.get('cancelled')} immediate={pj.get('immediate')}",
    )

    # POST /billing/resume (free user)
    r = requests.post(f"{BASE}/billing/resume", headers=hdrs, timeout=30)
    ok = r.status_code == 200
    pj = {}
    try:
        pj = r.json()
    except Exception:
        pass
    resumed_false = pj.get("resumed") is False
    record(
        "POST /api/billing/resume (free user)",
        ok and resumed_false,
        f"status={r.status_code} resumed={pj.get('resumed')}",
    )

    return summarize()


def summarize():
    passed = sum(1 for _, ok, _ in results if ok)
    print(f"\n=== {passed}/{len(results)} checks passed ===")
    failed = [(n, d) for n, ok, d in results if not ok]
    if failed:
        print("FAILED:")
        for n, d in failed:
            print(f"  - {n}: {d}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
