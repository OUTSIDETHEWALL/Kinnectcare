"""Focused re-test for GET /api/summary fix (KinnectCare).

Covers review request:
  1. demo login -> GET /api/summary returns 200 with required fields.
  2. fresh signup -> GET /api/summary still works.
  3. POST /api/reminders TimeSlot shape still works.
  4. PUT /api/reminders/{id} still works.
  5. Legacy reminders for demo now have `category` field present (via GET /api/reminders).
"""
import sys
import uuid
import requests
from pathlib import Path

FRONTEND_ENV = Path("/app/frontend/.env")
BASE = None
for line in FRONTEND_ENV.read_text().splitlines():
    if line.startswith("EXPO_PUBLIC_BACKEND_URL="):
        BASE = line.split("=", 1)[1].strip().strip('"')
        break
API = BASE.rstrip("/") + "/api"
print(f"Using API base: {API}")

DEMO_EMAIL = "demo@kinnectcare.app"
DEMO_PASSWORD = "password123"

REQUIRED_SUMMARY_FIELDS = [
    "medication_total", "medication_taken", "medication_missed",
    "routine_total", "weekly_compliance_percent",
]

results = []


def record(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name} :: {detail}")


def hdr(tok):
    return {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}


def login(email, password):
    r = requests.post(f"{API}/auth/login", json={"email": email, "password": password}, timeout=30)
    r.raise_for_status()
    return r.json()["access_token"]


def signup_fresh():
    suffix = uuid.uuid4().hex[:10]
    email = f"qa_{suffix}@kinnectcare.app"
    payload = {
        "email": email, "password": "TestPass!234",
        "full_name": "QA Tester", "timezone": "America/New_York",
    }
    r = requests.post(f"{API}/auth/signup", json=payload, timeout=30)
    r.raise_for_status()
    return email, r.json()["access_token"]


def check_summary(token, label):
    try:
        r = requests.get(f"{API}/summary", headers=hdr(token), timeout=30)
    except Exception as e:
        record(f"GET /api/summary ({label})", False, f"request error: {e}")
        return None
    if r.status_code != 200:
        record(f"GET /api/summary ({label})", False,
               f"status={r.status_code} body={r.text[:400]}")
        return None
    data = r.json()
    if "members" not in data or not isinstance(data["members"], list):
        record(f"GET /api/summary ({label})", False, f"no members array: {data}")
        return None
    if not data["members"]:
        record(f"GET /api/summary ({label}) members non-empty", False,
               "members array is empty (expected seeded members)")
        return data
    missing = []
    for m in data["members"]:
        for f in REQUIRED_SUMMARY_FIELDS:
            if f not in m:
                missing.append((m.get("name"), f))
    if missing:
        record(f"GET /api/summary ({label})", False, f"missing fields: {missing}")
        return data
    sample = data["members"][0]
    record(
        f"GET /api/summary ({label})", True,
        f"members={len(data['members'])} sample[name={sample.get('name')}, "
        f"med_total={sample.get('medication_total')}, med_taken={sample.get('medication_taken')}, "
        f"med_missed={sample.get('medication_missed')}, routine_total={sample.get('routine_total')}, "
        f"weekly_compliance_percent={sample.get('weekly_compliance_percent')}]"
    )
    return data


def check_legacy_reminders_have_category(token):
    r = requests.get(f"{API}/reminders", headers=hdr(token), timeout=30)
    if r.status_code != 200:
        record("GET /api/reminders (demo) backfill check", False,
               f"status={r.status_code} body={r.text[:300]}")
        return
    rems = r.json()
    no_cat = [x for x in rems if not x.get("category")]
    if no_cat:
        record("Legacy reminders backfilled with category", False,
               f"{len(no_cat)} reminder(s) missing category: ids={[x.get('id') for x in no_cat]}")
        return
    cats = sorted({x.get("category") for x in rems})
    statuses = sorted({x.get("status") for x in rems})
    record("Legacy reminders backfilled with category", True,
           f"all {len(rems)} reminders have category; cats={cats} statuses={statuses}")


def post_and_put_reminder(token, label):
    r = requests.get(f"{API}/members", headers=hdr(token), timeout=20)
    if r.status_code != 200 or not r.json():
        record(f"POST /api/reminders ({label})", False,
               f"could not list members: {r.status_code} {r.text[:200]}")
        return
    member_id = r.json()[0]["id"]

    payload = {
        "member_id": member_id, "title": "Vitamin D",
        "category": "medication", "dosage": "1000 IU",
        "times": [{"time": "07:30", "label": "Morning"}, {"time": "21:00"}],
    }
    r = requests.post(f"{API}/reminders", headers=hdr(token), json=payload, timeout=20)
    if r.status_code != 200:
        record(f"POST /api/reminders ({label})", False,
               f"status={r.status_code} body={r.text[:300]}")
        return
    rem = r.json()
    times = rem.get("times") or []
    if not (len(times) == 2 and times[0].get("time") == "07:30"
            and times[0].get("label") == "Morning"
            and times[1].get("time") == "21:00"):
        record(f"POST /api/reminders ({label})", False, f"unexpected times: {times}")
        return
    record(f"POST /api/reminders ({label})", True, f"id={rem['id']} times={times}")

    rid = rem["id"]
    upd = {"title": "Vitamin D3", "dosage": "2000 IU",
           "times": [{"time": "06:00", "label": "Dawn"}]}
    r = requests.put(f"{API}/reminders/{rid}", headers=hdr(token), json=upd, timeout=20)
    if r.status_code != 200:
        record(f"PUT /api/reminders/{{id}} ({label})", False,
               f"status={r.status_code} body={r.text[:300]}")
        return
    updated = r.json()
    ok = (updated.get("title") == "Vitamin D3"
          and updated.get("dosage") == "2000 IU"
          and len(updated.get("times") or []) == 1
          and updated["times"][0].get("time") == "06:00"
          and updated["times"][0].get("label") == "Dawn")
    if not ok:
        record(f"PUT /api/reminders/{{id}} ({label})", False, f"unexpected: {updated}")
        return
    record(f"PUT /api/reminders/{{id}} ({label})", True, "title/dosage/times updated")

    requests.delete(f"{API}/reminders/{rid}", headers=hdr(token), timeout=10)


def main():
    # 1) demo login
    try:
        demo_token = login(DEMO_EMAIL, DEMO_PASSWORD)
        record("POST /api/auth/login (demo)", True, "got token")
    except Exception as e:
        record("POST /api/auth/login (demo)", False, str(e))
        summary()
        return 1

    # 2) GET /api/summary demo (the regression target)
    check_summary(demo_token, "demo user")

    # 3) legacy reminder backfill verified via GET /api/reminders
    check_legacy_reminders_have_category(demo_token)

    # 4) POST/PUT reminders for demo
    post_and_put_reminder(demo_token, "demo")

    # 5) fresh signup + summary + reminder flow
    try:
        email, fresh_token = signup_fresh()
        record("POST /api/auth/signup (fresh user)", True, f"email={email}")
    except Exception as e:
        record("POST /api/auth/signup (fresh user)", False, str(e))
        summary()
        return 1

    check_summary(fresh_token, "fresh user")
    post_and_put_reminder(fresh_token, "fresh")

    return summary()


def summary():
    print("\n========== SUMMARY ==========")
    passed = sum(1 for _, ok, _ in results if ok)
    total = len(results)
    print(f"{passed}/{total} checks passed")
    for name, ok, _ in results:
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}")
    print("=============================\n")
    return 0 if passed == total else 2


if __name__ == "__main__":
    sys.exit(main())
