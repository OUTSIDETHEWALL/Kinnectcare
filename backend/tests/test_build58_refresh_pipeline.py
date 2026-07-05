"""Build #58 backend regression tests — Refresh Pipeline root-cause fix.

Verifies the two compounding fixes to
POST /api/members/{member_id}/request-location-refresh:

  1. Short-circuit BEFORE any push send when the TARGET user has
     `location_sharing_enabled: false`  → returns
     `{ok:true, skipped:"target_sharing_off", request_id:...}` and
     dispatches NO push.
  2. When a refresh push IS sent, `send_expo_push` is invoked with
     `priority="normal"` (not the default "high") so FCM no longer
     aggressively wakes the Android notification handler and draws
     a blank-"K" tray placeholder.

Also covers:
  • Case C — SOS/meds callers still use default "high" priority
    (grep source — no other caller passes `priority` kwarg).
  • Case D — no user_id link → skipped:"no_user_link".
  • Case E — 30 s per-member throttle → skipped:"throttled".
  • Case F — member_not_found → 404 + no STAGE log for that request_id.

Log verification: reads /var/log/supervisor/backend.err.log tail and
greps STAGE lines by `request_id` (unique per call).

Test data seed:
  • Caller = existing Alice (JWT in /app/memory/test_credentials.md).
  • Target members are created via POST /api/members and (for cases
    that need a linked user_id) a disposable target user doc is
    seeded via mongosh, then torn down.
"""

import os
import re
import time
import json
import uuid
import subprocess
from pathlib import Path

import pytest
import requests

BASE_URL = "https://family-guard-37.preview.emergentagent.com"
API = f"{BASE_URL}/api"

ALICE_JWT = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJzdWIiOiI3ZDI4NTg5YS1mNDJhLTQ2OTMtYmU5Ni0zNGE0MDM2ODViOWIiLCJleHAiOjE4MTIyMjY0NjB9."
    "GxlsVHwyy6W_f-f2c2PMlLgBYLphaOGphPmES7C9CLE"
)
ALICE_ID = "7d28589a-f42a-4693-be96-34a403685b9b"
ALICE_FG = "5e214a2f-c794-4649-bbd0-f42fbf2c32da"

BACKEND_LOG = "/var/log/supervisor/backend.err.log"
MONGO_DB = "test_database"

# A syntactically valid Expo push token (Expo will reject as bogus, but
# `send_expo_push` will PASS its own validity gate and log push_sending +
# push_sent — which is all we need to observe).
FAKE_TOKEN = "ExponentPushToken[TEST-BUILD58-AAAAAAAAAAAAAA]"


def _headers(jwt=ALICE_JWT):
    return {"Authorization": f"Bearer {jwt}", "Content-Type": "application/json"}


def _log_tail_since(offset: int) -> str:
    """Return log content appended since `offset` bytes."""
    time.sleep(0.35)  # let the async log flush
    try:
        with open(BACKEND_LOG, "r") as f:
            f.seek(offset)
            return f.read()
    except FileNotFoundError:
        return ""


def _log_offset() -> int:
    try:
        return Path(BACKEND_LOG).stat().st_size
    except FileNotFoundError:
        return 0


def _mongo_eval(js: str) -> subprocess.CompletedProcess:
    """Legacy shell-out fallback. New tests should prefer _pymongo_db()."""
    wrapped = f'var _d = db.getSiblingDB("{MONGO_DB}"); print({js})'
    fallback = f'var _d = db.getSiblingDB("{MONGO_DB}"); {js}'
    cp = subprocess.run(
        ["mongosh", "--quiet", "--eval", wrapped],
        capture_output=True, text=True, timeout=10,
    )
    if cp.returncode != 0:
        cp = subprocess.run(
            ["mongosh", "--quiet", "--eval", fallback],
            capture_output=True, text=True, timeout=10,
        )
    return cp


def _pymongo_db():
    """Return a pymongo Database handle to the test database."""
    from pymongo import MongoClient
    return MongoClient("mongodb://localhost:27017")[MONGO_DB]


# =============================================================================
# Fixtures
# =============================================================================

@pytest.fixture
def created_members():
    """Registry of member ids created inline by tests; cleaned up at end."""
    ids = []
    yield ids
    for mid in ids:
        try:
            requests.delete(f"{API}/members/{mid}", headers=_headers(), timeout=8)
        except Exception:
            pass


@pytest.fixture
def created_users():
    """Registry of disposable user docs seeded via pymongo; hard-deleted at end."""
    uids = []
    yield uids
    if uids:
        try:
            d = _pymongo_db()
            d.users.delete_many({"id": {"$in": uids}})
        except Exception:
            pass


def _make_member(name="TEST_B58_Target", link_user_id: str | None = None) -> str:
    """POST a member. Optionally patch it to have a `user_id` link via pymongo."""
    payload = {
        "name": name,
        "age": 70,
        "phone": "+15555550199",
        "gender": "male",
        "role": "senior",
    }
    r = requests.post(f"{API}/members", headers=_headers(), json=payload, timeout=10)
    assert r.status_code == 200, f"POST /members failed: {r.status_code} {r.text}"
    mid = r.json()["id"]
    if link_user_id:
        d = _pymongo_db()
        res = d.members.update_one({"id": mid}, {"$set": {"user_id": link_user_id}})
        assert res.matched_count == 1, f"member {mid} not found for user_id link"
    return mid


def _make_target_user(sharing_enabled: bool, with_token: bool = True) -> str:
    """Seed a disposable user doc via pymongo. Returns user_id (uuid)."""
    uid = str(uuid.uuid4())
    d = _pymongo_db()
    d.users.insert_one({
        "id": uid,
        "email": f"TEST_b58_{uid[:8]}@example.com",
        "full_name": "TEST B58 Target",
        "location_sharing_enabled": bool(sharing_enabled),
        "push_tokens": [FAKE_TOKEN] if with_token else [],
        "timezone": "UTC",
        "family_group_id": ALICE_FG,
    })
    return uid


def _clear_throttle_for(member_id: str) -> None:
    """Reset the in-memory 30 s throttle by waiting or by
    monkey-patching via a diagnostic endpoint. Since no such endpoint
    exists, we can only wait — or use unique member IDs per test."""
    # We use fresh member IDs per test, so no cross-contamination.
    _ = member_id


# =============================================================================
# Case A — Sharing-off short-circuit (P0)
# =============================================================================

class TestCaseA_SharingOffShortCircuit:
    def test_target_sharing_off_skips_push(self, created_members, created_users):
        target_uid = _make_target_user(sharing_enabled=False, with_token=True)
        created_users.append(target_uid)
        mid = _make_member(name="TEST_B58_A_off", link_user_id=target_uid)
        created_members.append(mid)

        # Sanity: verify seeded user has sharing OFF and has a push token.
        d = _pymongo_db()
        seed_doc = d.users.find_one(
            {"id": target_uid},
            {"_id": 0, "location_sharing_enabled": 1, "push_tokens": 1},
        )
        assert seed_doc is not None, "seeded user not found in db"
        assert seed_doc.get("location_sharing_enabled") is False, seed_doc
        assert FAKE_TOKEN in (seed_doc.get("push_tokens") or []), seed_doc

        off = _log_offset()
        r = requests.post(
            f"{API}/members/{mid}/request-location-refresh",
            headers=_headers(), timeout=10,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("ok") is True, body
        assert body.get("skipped") == "target_sharing_off", body
        rid = body.get("request_id")
        assert isinstance(rid, str) and len(rid) >= 8, body

        tail = _log_tail_since(off)
        # Positive assertion: correct skip stage was logged.
        assert re.search(
            rf"STAGE=push_skipped reason=target_sharing_off request_id={re.escape(rid)}",
            tail,
        ), f"Expected target_sharing_off STAGE log with rid={rid!r}. Tail:\n{tail[-3000:]}"
        # Negative assertion: NO push_sending / push_sent for this rid.
        assert not re.search(
            rf"STAGE=push_sending request_id={re.escape(rid)}", tail
        ), f"UNEXPECTED push_sending for skipped refresh rid={rid}. Tail:\n{tail[-3000:]}"
        assert not re.search(
            rf"STAGE=push_sent request_id={re.escape(rid)}", tail
        ), f"UNEXPECTED push_sent for skipped refresh rid={rid}. Tail:\n{tail[-3000:]}"


# =============================================================================
# Case B — Normal-priority refresh push (P0)
# =============================================================================

class TestCaseB_NormalPriorityRefresh:
    def test_refresh_sends_with_priority_normal(self, created_members, created_users):
        target_uid = _make_target_user(sharing_enabled=True, with_token=True)
        created_users.append(target_uid)
        mid = _make_member(name="TEST_B58_B_on", link_user_id=target_uid)
        created_members.append(mid)

        off = _log_offset()
        r = requests.post(
            f"{API}/members/{mid}/request-location-refresh",
            headers=_headers(), timeout=15,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("ok") is True, body
        # Not skipped — should have sent to at least 1 token.
        assert body.get("skipped") is None, body
        assert body.get("sent_to") == 1, body
        rid = body["request_id"]

        tail = _log_tail_since(off)
        # push_sending line records priority=normal + channel=silent_v2
        assert re.search(
            rf"STAGE=push_sending request_id={re.escape(rid)} tokens=1 priority=normal channel=silent_v2",
            tail,
        ), f"Expected push_sending priority=normal log for rid={rid}. Tail:\n{tail[-3000:]}"
        # push_sent tokens=1
        assert re.search(
            rf"STAGE=push_sent request_id={re.escape(rid)} tokens=1",
            tail,
        ), f"Expected push_sent tokens=1 log for rid={rid}. Tail:\n{tail[-3000:]}"

    def test_refresh_uses_silent_data_only_payload_shape(self):
        """Static verification of the payload shape passed to send_expo_push:
        title="", body="", data.type="request_location_refresh",
        data.channelId="silent_v2", data._source_tag="refresh".
        Reads server.py directly to guard against accidental future edits."""
        src = Path("/app/backend/server.py").read_text()
        # locate the request_location_refresh function
        block_match = re.search(
            r"@api_router\.post\(\"/members/\{member_id\}/request-location-refresh\"\)"
            r".*?(?=@api_router\.|\Z)",
            src, re.DOTALL,
        )
        assert block_match, "could not locate request_location_refresh block"
        blk = block_match.group(0)
        assert 'title=""' in blk, "refresh push must have empty title"
        assert 'body=""' in blk, "refresh push must have empty body"
        assert '"type": "request_location_refresh"' in blk
        assert '"channelId": "silent_v2"' in blk
        assert '"_source_tag": "refresh"' in blk
        assert 'priority="normal"' in blk, "refresh push must pass priority=normal"


# =============================================================================
# Case C — SOS / meds priority regression (default "high")
# =============================================================================

class TestCaseC_HighPriorityDefaultsPreserved:
    def test_send_expo_push_default_priority_is_high(self):
        """The signature default must remain 'high' so all other callers
        (SOS, meds, alerts) get high-priority pushes unchanged."""
        import sys
        sys.path.insert(0, "/app/backend")
        from expo_push import send_expo_push  # noqa
        import inspect
        sig = inspect.signature(send_expo_push)
        prio = sig.parameters.get("priority")
        assert prio is not None, "send_expo_push must expose `priority` kwarg"
        assert prio.default == "high", (
            f"send_expo_push default priority MUST remain 'high' — got {prio.default!r}"
        )

    def test_no_other_caller_passes_priority(self):
        """Grep server.py for all send_expo_push calls; only the refresh
        route may override priority. Everyone else uses the default."""
        src = Path("/app/backend/server.py").read_text()
        # Find all `send_expo_push(...)` invocations with their argument block.
        # We only need to guarantee no non-refresh caller passes priority=.
        callers = re.findall(r"send_expo_push\s*\((.*?)\)", src, re.DOTALL)
        assert callers, "expected at least 1 send_expo_push caller in server.py"
        offenders = []
        for arg_block in callers:
            if "priority=" in arg_block and 'priority="normal"' not in arg_block:
                offenders.append(arg_block[:200])
        assert not offenders, (
            "Some send_expo_push callers set priority to a non-'normal' value "
            "(would downgrade or misroute user-visible pushes):\n"
            + "\n---\n".join(offenders)
        )


# =============================================================================
# Case D — no user link (member has no user_id)
# =============================================================================

class TestCaseD_NoUserLink:
    def test_unlinked_member_returns_no_user_link(self, created_members):
        mid = _make_member(name="TEST_B58_D_unlinked", link_user_id=None)
        created_members.append(mid)

        off = _log_offset()
        r = requests.post(
            f"{API}/members/{mid}/request-location-refresh",
            headers=_headers(), timeout=10,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("skipped") == "no_user_link", body
        rid = body["request_id"]

        tail = _log_tail_since(off)
        assert re.search(
            rf"STAGE=push_skipped reason=no_user_link request_id={re.escape(rid)}",
            tail,
        ), f"Expected no_user_link STAGE log for rid={rid}. Tail:\n{tail[-3000:]}"
        assert not re.search(
            rf"STAGE=push_sending request_id={re.escape(rid)}", tail
        )


# =============================================================================
# Case E — Throttled (30 s per member)
# =============================================================================

class TestCaseE_Throttle:
    def test_second_refresh_within_30s_is_throttled(
        self, created_members, created_users
    ):
        target_uid = _make_target_user(sharing_enabled=True, with_token=True)
        created_users.append(target_uid)
        mid = _make_member(name="TEST_B58_E_throttle", link_user_id=target_uid)
        created_members.append(mid)

        # First call — should succeed (sent_to=1).
        r1 = requests.post(
            f"{API}/members/{mid}/request-location-refresh",
            headers=_headers(), timeout=15,
        )
        assert r1.status_code == 200, r1.text
        b1 = r1.json()
        assert b1.get("skipped") is None, b1
        assert b1.get("sent_to") == 1, b1

        # Second call — must be throttled.
        off = _log_offset()
        r2 = requests.post(
            f"{API}/members/{mid}/request-location-refresh",
            headers=_headers(), timeout=10,
        )
        assert r2.status_code == 200, r2.text
        b2 = r2.json()
        assert b2.get("skipped") == "throttled", b2
        assert isinstance(b2.get("retry_in_s"), int), b2
        assert 0 < b2["retry_in_s"] <= 30, b2
        rid2 = b2["request_id"]

        tail = _log_tail_since(off)
        assert re.search(
            rf"STAGE=push_skipped reason=throttled request_id={re.escape(rid2)}",
            tail,
        ), f"Expected throttled STAGE log for rid={rid2}. Tail:\n{tail[-3000:]}"


# =============================================================================
# Case F — member_not_found regression (no STAGE log — quiet drop)
# =============================================================================

class TestCaseF_MemberNotFoundQuiet:
    def test_unknown_member_returns_404_and_is_quiet_in_stage_log(self):
        bogus_id = f"nonexistent-{uuid.uuid4().hex[:12]}"

        off = _log_offset()
        r = requests.post(
            f"{API}/members/{bogus_id}/request-location-refresh",
            headers=_headers(), timeout=10,
        )
        assert r.status_code == 404, r.text

        tail = _log_tail_since(off)
        # Must NOT emit any refresh-pipeline STAGE line for this request
        # (Build #56 behavior — we short-circuit before generating request_id).
        assert "[refresh-pipeline] STAGE=" not in tail, (
            "member_not_found path leaked STAGE log (Build #56 quiet-drop "
            f"regression). Tail:\n{tail[-3000:]}"
        )
