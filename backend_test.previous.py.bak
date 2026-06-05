"""Backend regression test for push-token cleanup feature + smoke checks.

Covers:
 1. Inject a fake ExponentPushToken, trigger SOS, verify it's pruned from
    user.push_tokens and that backend logs contain the prune log line.
 2. Verify healthy tokens on finalcut71@gmail.com are not pruned (count remains
    same — we expect exactly 3 valid tokens).
 3. Unit-level call to send_expo_push() with a deliberately invalid token
    returns the invalid token in its return list.
 4. Med scheduler regression: create a med with a slot ~5 min in the past,
    call POST /api/medications/_tick, expect counters.fired_due == 1.
 5. Alerts UTC tz suffix: GET /api/alerts first row's created_at ends with
    '+00:00' or 'Z'.
 6. SOS performance: returns 200 in <500ms and includes
    fanout_mode='background'.
"""
import asyncio
import os
import sys
import time
import uuid
import json
import subprocess
from datetime import datetime, timedelta, timezone
from typing import Tuple

import httpx
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

load_dotenv("/app/backend/.env")

BASE = "https://family-guard-37.preview.emergentagent.com/api"
DEMO_EMAIL = "demo@kinnship.app"
DEMO_PASSWORD = "password123"
FAKE_TOKEN = "ExponentPushToken[FAKE_TEST_TOKEN_FOR_CLEANUP]"

MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ.get("DB_NAME", "test_database")
mongo = AsyncIOMotorClient(MONGO_URL)
db = mongo[DB_NAME]

results = []  # list[(name, ok, detail)]


def record(name: str, ok: bool, detail: str = ""):
    results.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + (f" :: {detail}" if detail else ""))


async def login(client: httpx.AsyncClient, email: str, password: str) -> Tuple[str, dict]:
    r = await client.post(f"{BASE}/auth/login", json={"email": email, "password": password})
    r.raise_for_status()
    j = r.json()
    return j["access_token"], j["user"]


async def get_user_push_tokens(user_id: str) -> list:
    u = await db.users.find_one({"id": user_id}, {"_id": 0, "push_tokens": 1})
    return list((u or {}).get("push_tokens") or [])


async def scenario_1_prune_dead_token():
    """Inject fake token, trigger a push that targets demo, verify prune.

    NOTE: POST /api/sos intentionally EXCLUDES the triggering user from the
    push fanout (Bug 2 in v6.4 — Linking.openURL race on Android). So pressing
    SOS as demo does NOT trigger push_to_user(demo) and therefore cannot
    exercise the prune path on demo's own token list.

    We instead use the medication-tick path which DOES call
    push_to_user(self_user_id=demo) when a reminder with owner=demo fires.
    We additionally hit POST /api/sos to confirm the documented endpoint
    still returns 200 (and to satisfy the literal step in the spec).
    """
    async with httpx.AsyncClient(timeout=30.0) as client:
        token, user = await login(client, DEMO_EMAIL, DEMO_PASSWORD)
        headers = {"Authorization": f"Bearer {token}"}
        user_id = user["id"]

        # Scrub any pre-existing fake test token from previous runs
        await db.users.update_one(
            {"id": user_id}, {"$pull": {"push_tokens": FAKE_TOKEN}}
        )
        await db.users.update_one(
            {"id": user_id}, {"$addToSet": {"push_tokens": FAKE_TOKEN}}
        )
        injected = await get_user_push_tokens(user_id)
        if FAKE_TOKEN not in injected:
            record("S1: inject fake token", False, "addToSet failed")
            return
        record("S1: inject fake token", True, f"tokens_after_inject={len(injected)}")

        # Capture log byte-offsets BEFORE we trigger the push
        log_paths = [
            "/var/log/supervisor/backend.err.log",
            "/var/log/supervisor/backend.out.log",
        ]
        offsets = {}
        for p in log_paths:
            try:
                offsets[p] = os.path.getsize(p)
            except Exception:
                offsets[p] = 0

        # First, hit /sos to confirm spec'd endpoint returns 200 (still
        # required by the regression checklist).
        sos_r = await client.post(
            f"{BASE}/sos",
            json={"latitude": 33.4, "longitude": -112.0},
            headers=headers,
        )
        record(
            "S1: POST /sos returns 200",
            sos_r.status_code == 200,
            f"status={sos_r.status_code}",
        )

        # Now trigger a push that ACTUALLY targets demo: schedule a med 5 min
        # in the past and tick it. push_to_user(demo) will be called inline
        # within /_tick and prune the fake token before the response returns.
        r = await client.get(f"{BASE}/members", headers=headers)
        members = r.json() if r.status_code == 200 else []
        if not members:
            record("S1: members for med-tick prune", False, "no members")
            return
        mid = members[0]["id"]

        tz_name = user.get("timezone") or "UTC"
        try:
            from zoneinfo import ZoneInfo
            tz = ZoneInfo(tz_name)
        except Exception:
            tz = timezone.utc
        past_local = datetime.now(tz) - timedelta(minutes=5)
        hhmm = past_local.strftime("%H:%M")

        rcreate = await client.post(
            f"{BASE}/reminders",
            json={
                "member_id": mid,
                "title": f"S1 Prune Med {uuid.uuid4().hex[:6]}",
                "dosage": "5mg",
                "category": "medication",
                "times": [{"time": hhmm, "label": "S1"}],
            },
            headers=headers,
        )
        if rcreate.status_code != 200:
            record(
                "S1: create reminder for prune trigger",
                False,
                f"{rcreate.status_code} {rcreate.text[:200]}",
            )
            return
        rem_id = rcreate.json()["id"]

        # Tick — this calls push_to_user(demo) inline.
        await client.post(f"{BASE}/medications/_tick", headers=headers)
        # Give async tasks a moment to settle.
        await asyncio.sleep(2)

        after = await get_user_push_tokens(user_id)
        still_has_fake = FAKE_TOKEN in after
        record(
            "S1: fake token pruned from push_tokens",
            not still_has_fake,
            f"tokens_after={[t[:35] for t in after]}",
        )

        new_log = ""
        for p, off in offsets.items():
            try:
                with open(p, "rb") as f:
                    f.seek(off)
                    new_log += f.read().decode("utf-8", errors="ignore")
            except Exception:
                pass
        found_prune = (
            "Pruned" in new_log
            and "dead push token" in new_log
            and user_id in new_log
        )
        record(
            "S1: backend log contains 'Pruned N dead push token(s)' for user",
            found_prune,
            f"user_id={user_id} log_len={len(new_log)}",
        )
        if not found_prune:
            print("--- log tail (last 1500) ---")
            print(new_log[-1500:])

        # Cleanup the temp reminder
        await client.delete(f"{BASE}/reminders/{rem_id}", headers=headers)


async def scenario_2_healthy_tokens_preserved():
    """Verify finalcut71@gmail.com still has its valid push_tokens."""
    user = await db.users.find_one(
        {"email": "finalcut71@gmail.com"}, {"_id": 0, "push_tokens": 1, "id": 1}
    )
    if not user:
        record("S2: finalcut71@gmail.com exists", False, "user not found in db")
        return
    tokens = list(user.get("push_tokens") or [])
    # All tokens should be valid ExponentPushToken[...] shape
    all_valid_shape = all(
        isinstance(t, str) and t.startswith("ExponentPushToken[") and t.endswith("]")
        for t in tokens
    )
    record(
        "S2: finalcut71 still has 3 healthy push_tokens",
        len(tokens) == 3 and all_valid_shape,
        f"count={len(tokens)} all_valid_shape={all_valid_shape} sample={[t[:35] for t in tokens]}",
    )


def scenario_3_send_expo_push_unit():
    """Call send_expo_push() via python -c and verify the bad token is returned."""
    snippet = (
        "import asyncio,sys,json;"
        "sys.path.insert(0,'/app/backend');"
        "from expo_push import send_expo_push;"
        "bad='ExponentPushToken[FAKE_UNIT_TEST_XYZ_123456]';"
        "out=asyncio.run(send_expo_push([bad],'t','b',{'type':'unit'}));"
        "print('RESULT_JSON='+json.dumps(out))"
    )
    p = subprocess.run(
        ["python", "-c", snippet],
        cwd="/app/backend",
        capture_output=True,
        text=True,
        timeout=30,
    )
    if p.returncode != 0:
        record("S3: send_expo_push unit run", False, f"stderr={p.stderr[:400]}")
        return
    line = next(
        (l for l in p.stdout.splitlines() if l.startswith("RESULT_JSON=")), None
    )
    if not line:
        record("S3: send_expo_push unit run", False, f"no RESULT_JSON in stdout={p.stdout[:300]}")
        return
    out = json.loads(line.replace("RESULT_JSON=", "", 1))
    ok = isinstance(out, list) and "ExponentPushToken[FAKE_UNIT_TEST_XYZ_123456]" in out
    record(
        "S3: send_expo_push returns invalid token in dead-list",
        ok,
        f"returned={out}",
    )


async def scenario_4_med_tick():
    """Create a medication with a slot ~5 min in the past, tick, expect fired_due==1."""
    async with httpx.AsyncClient(timeout=30.0) as client:
        token, user = await login(client, DEMO_EMAIL, DEMO_PASSWORD)
        headers = {"Authorization": f"Bearer {token}"}

        r = await client.get(f"{BASE}/members", headers=headers)
        if r.status_code != 200:
            record("S4: GET /members", False, f"{r.status_code} {r.text[:200]}")
            return
        members = r.json()
        if not members:
            record("S4: members exist", False, "no members")
            return
        mid = members[0]["id"]

        tz_name = user.get("timezone") or "UTC"
        try:
            from zoneinfo import ZoneInfo
            tz = ZoneInfo(tz_name)
        except Exception:
            tz = timezone.utc
        now_local = datetime.now(tz)
        past_local = now_local - timedelta(minutes=5)
        hhmm = past_local.strftime("%H:%M")

        body = {
            "member_id": mid,
            "title": f"QA Tick Med {uuid.uuid4().hex[:6]}",
            "dosage": "10mg",
            "category": "medication",
            "times": [{"time": hhmm, "label": "QA"}],
        }
        r = await client.post(f"{BASE}/reminders", json=body, headers=headers)
        if r.status_code != 200:
            record("S4: POST /reminders", False, f"{r.status_code} {r.text[:200]}")
            return
        rem = r.json()
        rem_id = rem["id"]
        record("S4: create reminder with past slot", True, f"id={rem_id} time={hhmm}")

        r = await client.post(f"{BASE}/medications/_tick", headers=headers)
        if r.status_code != 200:
            record("S4: POST /medications/_tick", False, f"{r.status_code} {r.text[:200]}")
            await client.delete(f"{BASE}/reminders/{rem_id}", headers=headers)
            return
        counters = r.json()
        fired_due = counters.get("fired_due")
        ok = fired_due == 1
        record(
            "S4: counters.fired_due == 1",
            ok,
            f"fired_due={fired_due} counters={counters}",
        )

        r = await client.delete(f"{BASE}/reminders/{rem_id}", headers=headers)
        record(
            "S4: cleanup DELETE /reminders/{id}",
            r.status_code == 200,
            f"status={r.status_code}",
        )


async def scenario_5_alerts_tz_suffix():
    async with httpx.AsyncClient(timeout=30.0) as client:
        token, _user = await login(client, DEMO_EMAIL, DEMO_PASSWORD)
        headers = {"Authorization": f"Bearer {token}"}
        r = await client.get(f"{BASE}/alerts", headers=headers)
        if r.status_code != 200:
            record("S5: GET /alerts", False, f"{r.status_code}")
            return
        rows = r.json()
        if not rows:
            record("S5: at least one alert", False, "alerts list empty")
            return
        ca = rows[0].get("created_at")
        ok = isinstance(ca, str) and (ca.endswith("+00:00") or ca.endswith("Z"))
        record(
            "S5: first alert created_at ends with +00:00 or Z",
            ok,
            f"created_at={ca}",
        )


async def scenario_6_sos_perf_and_mode():
    async with httpx.AsyncClient(timeout=30.0) as client:
        token, _user = await login(client, DEMO_EMAIL, DEMO_PASSWORD)
        headers = {"Authorization": f"Bearer {token}"}
        t0 = time.perf_counter()
        r = await client.post(
            f"{BASE}/sos",
            json={"latitude": 33.4, "longitude": -112.0},
            headers=headers,
        )
        elapsed_ms = int((time.perf_counter() - t0) * 1000)
        if r.status_code != 200:
            record("S6: SOS status 200", False, f"status={r.status_code}")
            return
        j = r.json()
        record(
            "S6: POST /sos returns in <500ms",
            elapsed_ms < 500,
            f"elapsed_ms={elapsed_ms}",
        )
        record(
            "S6: response includes fanout_mode='background'",
            j.get("fanout_mode") == "background",
            f"fanout_mode={j.get('fanout_mode')}",
        )


async def main():
    print("=" * 70)
    print(f"Backend regression — push-token cleanup feature @ {BASE}")
    print("=" * 70)

    await scenario_1_prune_dead_token()
    await scenario_2_healthy_tokens_preserved()
    scenario_3_send_expo_push_unit()
    await scenario_4_med_tick()
    await scenario_5_alerts_tz_suffix()
    await scenario_6_sos_perf_and_mode()

    print("\n" + "=" * 70)
    passed = sum(1 for _, ok, _ in results if ok)
    print(f"SUMMARY: {passed}/{len(results)} checks passed")
    print("=" * 70)
    for name, ok, detail in results:
        print(("[OK]   " if ok else "[FAIL] ") + name + (f" :: {detail}" if detail and not ok else ""))

    sys.exit(0 if passed == len(results) else 1)


if __name__ == "__main__":
    asyncio.run(main())
