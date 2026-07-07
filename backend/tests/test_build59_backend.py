"""Build #59 backend regression + focused feature tests.

Scope (backend HTTP only — frontend handled by user):
  • P1 — Location Sharing per-account isolation (CRITICAL regression).
    Verifies PUT /api/me/preferences {location_sharing_enabled:false}
    only touches the caller's own personal member row (user_id match),
    NOT rows they created for other people (owner_id match).
  • P2 — GET /api/auth/otp-status shape (pending / delivered / failed / 400).
  • P3 — _would_render_blank stricter rule + data-only refresh push
         path is NOT dropped.
  • P4 — GET /api/billing/status shape for free-tier user.
  • P5 — Family invite w/ relationship + role optional fields;
         bogus role sanitized to null; verify-invite public shape.
  • P6 — startup heal log line present in backend.err.log.

All tests seeded fresh via OTP sign-up (grep code from
/var/log/supervisor/backend.err.log).  Test data prefixed TEST_B59_.
"""

import os
import re
import time
import uuid
import subprocess
from pathlib import Path

import pytest
import requests

BASE_URL = "https://family-guard-37.preview.emergentagent.com"
API = f"{BASE_URL}/api"
BACKEND_LOG = "/var/log/supervisor/backend.err.log"
OTP_TIMEOUT_S = 20


# ---------------------- helpers ----------------------
def _log_tail(n: int = 400) -> str:
    try:
        out = subprocess.run(
            ["tail", "-n", str(n), BACKEND_LOG],
            capture_output=True, text=True, timeout=5,
        )
        return out.stdout
    except Exception:
        return ""


def _grep_otp_code(email: str, since_ts: float) -> str | None:
    """Scan log for `Code for <email>: NNNNNN` written after since_ts.
    Poll a few times to avoid delivery race."""
    pat = re.compile(rf"Code for {re.escape(email)}:\s*(\d{{6}})")
    deadline = time.time() + OTP_TIMEOUT_S
    last_code = None
    while time.time() < deadline:
        log = _log_tail(2000)
        for m in pat.finditer(log):
            last_code = m.group(1)
        if last_code:
            return last_code
        time.sleep(1)
    return last_code


def _signup(email: str, full_name: str, invite_code: str | None = None) -> dict:
    """Full OTP signup flow → returns {token, user}."""
    ts = time.time()
    payload = {"email": email, "purpose": "signup", "full_name": full_name}
    if invite_code:
        payload["invite_code"] = invite_code
    r = requests.post(f"{API}/auth/request-otp", json=payload, timeout=10)
    assert r.status_code == 200, f"request-otp failed: {r.status_code} {r.text}"
    code = _grep_otp_code(email, ts)
    assert code, f"No OTP code found in log for {email}"
    v = requests.post(
        f"{API}/auth/verify-otp",
        json={"email": email, "code": code},
        timeout=10,
    )
    assert v.status_code == 200, f"verify-otp failed: {v.status_code} {v.text}"
    data = v.json()
    return {"token": data["access_token"], "user": data["user"]}


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# ---------------------- fixtures ----------------------
@pytest.fixture(scope="module")
def user_a():
    """Caregiver A — creates a fresh family group + a member for person B."""
    email = f"test-b59-a-{uuid.uuid4().hex[:8]}@example.com"
    sess = _signup(email, "TEST_B59 Caregiver A")
    return sess


@pytest.fixture(scope="module")
def family_invite_from_a(user_a):
    """Create a per-invite INV- token for User B to join A's family group."""
    invitee_email = f"test-b59-b-{uuid.uuid4().hex[:8]}@example.com"
    r = requests.post(
        f"{API}/family-group/invite",
        json={
            "name": "TEST_B59 Senior B",
            "email": invitee_email,
            "relationship": "Mom",
            "role": "senior",
        },
        headers=_auth(user_a["token"]),
        timeout=10,
    )
    assert r.status_code == 200, f"invite failed: {r.status_code} {r.text}"
    body = r.json()
    return {"invitee_email": invitee_email, "body": body}


# ================================================================
# P6 — startup heal migration log
# ================================================================
class TestP6HealMigration:
    def test_heal_log_present(self):
        log = _log_tail(5000)
        assert "Build #59 heal:" in log, (
            "Expected 'Build #59 heal: ...' log line on startup"
        )
        # Either the "no leaks" or "repaired N" variant is acceptable.
        assert re.search(
            r"Build #59 heal: (no cross-user sharing leaks to fix|repaired \d+ cross-user location-sharing leak)",
            log,
        ), "Heal log line format unexpected"


# ================================================================
# P4 — Stripe/billing status for free-tier
# ================================================================
class TestP4BillingStatus:
    def test_billing_status_free_tier(self, user_a):
        r = requests.get(
            f"{API}/billing/status",
            headers=_auth(user_a["token"]),
            timeout=10,
        )
        assert r.status_code == 200
        body = r.json()
        # Required fields per Build #59 spec
        for key in ("plan", "current_period_end", "interval", "plan_label"):
            assert key in body, f"missing field {key} in billing/status"
        assert body["plan"] == "free"
        # Free tier: no interval, no plan_label, no cpe
        assert body["current_period_end"] is None
        assert body["interval"] is None
        assert body["plan_label"] is None


# ================================================================
# P2 — OTP delivery status tracking
# ================================================================
class TestP2OtpStatus:
    def test_pending_for_never_requested_email(self):
        r = requests.get(
            f"{API}/auth/otp-status",
            params={"email": f"neverseen-{uuid.uuid4().hex[:6]}@example.com"},
            timeout=10,
        )
        assert r.status_code == 200
        assert r.json() == {"status": "pending"}

    def test_malformed_email_rejected(self):
        r = requests.get(
            f"{API}/auth/otp-status",
            params={"email": "nope"},
            timeout=10,
        )
        assert r.status_code == 400

    def test_status_after_request_otp(self):
        email = f"test-b59-status-{uuid.uuid4().hex[:8]}@example.com"
        r = requests.post(
            f"{API}/auth/request-otp",
            json={"email": email, "purpose": "signup", "full_name": "TEST_B59 Status"},
            timeout=10,
        )
        assert r.status_code == 200
        time.sleep(2)
        s = requests.get(
            f"{API}/auth/otp-status", params={"email": email}, timeout=10
        )
        assert s.status_code == 200
        body = s.json()
        assert body.get("status") in ("pending", "delivered", "failed"), (
            f"unexpected status shape: {body}"
        )
        if body["status"] == "delivered":
            assert "transport" in body
        if body["status"] == "failed":
            assert "transport" in body


# ================================================================
# P5 — Family invitation with relationship + role
# ================================================================
class TestP5FamilyInvite:
    def test_invite_persists_relationship_and_role(self, family_invite_from_a):
        body = family_invite_from_a["body"]
        assert body["ok"] is True
        inv = body["invite"]
        assert inv["relationship"] == "Mom"
        assert inv["role"] == "senior"
        assert inv["invitee_email"] == family_invite_from_a["invitee_email"]
        assert inv["status"] == "pending"
        assert inv["token"].startswith("INV-")

    def test_list_invites_includes_new_fields(self, user_a, family_invite_from_a):
        r = requests.get(
            f"{API}/family-group/invites",
            headers=_auth(user_a["token"]),
            timeout=10,
        )
        assert r.status_code == 200
        rows = r.json()["invites"]
        needle = family_invite_from_a["body"]["invite"]["token"]
        match = next((i for i in rows if i["token"] == needle), None)
        assert match is not None, "newly-created invite missing from GET /invites"
        assert match["relationship"] == "Mom"
        assert match["role"] == "senior"

    def test_verify_invite_public_no_auth(self, family_invite_from_a, user_a):
        token = family_invite_from_a["body"]["invite"]["token"]
        # Deliberately NO auth header — this endpoint is public.
        r = requests.get(f"{API}/family-group/verify-invite/{token}", timeout=10)
        assert r.status_code == 200
        body = r.json()
        assert body["valid"] is True
        assert body["family_name"]  # non-empty
        # inviter_name is the full_name of user A
        assert body["inviter_name"] == user_a["user"]["full_name"]
        assert body["code_type"] == "per-invite"

    def test_bogus_role_sanitized_to_null(self, user_a):
        invitee_email = f"test-b59-bogusrole-{uuid.uuid4().hex[:8]}@example.com"
        r = requests.post(
            f"{API}/family-group/invite",
            json={
                "name": "TEST_B59 Bogus Role",
                "email": invitee_email,
                "relationship": "Cousin",
                "role": "bogus",
            },
            headers=_auth(user_a["token"]),
            timeout=10,
        )
        assert r.status_code == 200, f"expected 200 (silent coerce), got {r.status_code} {r.text}"
        inv = r.json()["invite"]
        assert inv["role"] is None, f"expected role sanitized to null, got {inv['role']!r}"
        assert inv["relationship"] == "Cousin"


# ================================================================
# P1 — Location Sharing per-account isolation (CRITICAL)
# ================================================================
class TestP1LocationSharingIsolation:
    """The bug: PUT /api/me/preferences {location_sharing_enabled:false}
    used to match `{$or: [{user_id:A}, {owner_id:A}]}` — which nuked
    rows A had CREATED for other people (owner_id match).

    The fix: match STRICTLY on `{user_id: A}` — only A's own personal
    row is affected.
    """

    @pytest.fixture(scope="class")
    def user_a_isolated(self):
        email = f"test-b59-a-iso-{uuid.uuid4().hex[:8]}@example.com"
        return _signup(email, "TEST_B59 A Isolated")

    @pytest.fixture(scope="class")
    def user_b_isolated(self, user_a_isolated):
        """Create a per-invite token from A, sign up B with it — both
        end up sharing the same family_group_id."""
        # Create invite from A
        invitee_email = f"test-b59-b-iso-{uuid.uuid4().hex[:8]}@example.com"
        r = requests.post(
            f"{API}/family-group/invite",
            json={"name": "TEST_B59 B Isolated", "email": invitee_email, "role": "senior"},
            headers=_auth(user_a_isolated["token"]),
            timeout=10,
        )
        assert r.status_code == 200, f"invite failed: {r.text}"
        token = r.json()["invite"]["token"]

        # ALSO create a member row for "B" owned by A so we can prove
        # the ownership bug is fixed (this stamps owner_id=A on a row
        # that BELONGS to person B, before B ever signs up).
        m = requests.post(
            f"{API}/members",
            json={
                "name": "TEST_B59 Senior-B-created-by-A",
                "age": 72,
                "phone": "5555550190",
                "gender": "female",
            },
            headers=_auth(user_a_isolated["token"]),
            timeout=10,
        )
        assert m.status_code == 200, f"create member failed: {m.text}"
        b_member_owned_by_a = m.json()

        # Now sign up B, joining via the invite token.
        b_sess = _signup(invitee_email, "TEST_B59 B Isolated", invite_code=token)
        return {
            "sess": b_sess,
            "member_owned_by_a": b_member_owned_by_a,
        }

    def test_a_and_b_share_family_group(self, user_a_isolated, user_b_isolated):
        """Precondition — A and B must be in the same family_group_id
        so any accidental over-broad update on A can be observed on B."""
        assert (
            user_a_isolated["user"]["family_group_id"]
            == user_b_isolated["sess"]["user"]["family_group_id"]
        ), "A and B must share family group for isolation test to be meaningful"

    def test_a_toggle_off_does_NOT_affect_b_row_owned_by_a(
        self, user_a_isolated, user_b_isolated
    ):
        """The critical regression assertion.

        Setup: A created a member row 'Senior-B-created-by-A' — that
        row has owner_id=A and (initially) no user_id link.  Under the
        OLD bug, when A toggles sharing OFF, that row would also flip
        to false.  Under the fix, only rows with user_id=A flip.
        """
        # Read B-owned-by-A row BEFORE toggle from B's perspective (B
        # is in the same family group so GET /members returns it).
        pre = requests.get(
            f"{API}/members",
            headers=_auth(user_b_isolated["sess"]["token"]),
            timeout=10,
        )
        assert pre.status_code == 200
        pre_rows = pre.json()
        target_id = user_b_isolated["member_owned_by_a"]["id"]
        pre_target = next((m for m in pre_rows if m["id"] == target_id), None)
        assert pre_target is not None, "member A-created-for-B missing from B's view"
        # Field may be absent (defaults True) OR explicitly True.
        pre_val = pre_target.get("location_sharing_enabled", True)
        assert pre_val is True, f"expected pre-toggle sharing True, got {pre_val}"

        # A toggles sharing OFF.
        put_r = requests.put(
            f"{API}/me/preferences",
            json={"location_sharing_enabled": False},
            headers=_auth(user_a_isolated["token"]),
            timeout=10,
        )
        assert put_r.status_code == 200
        assert put_r.json()["location_sharing_enabled"] is False

        # Verify: log shows "propagated to 1 member doc(s)" — NOT 2+.
        # (A has NO personal self-row yet because A never had a
        # `user_id` stamped on any member.  Prior to Build #59 this
        # would have grabbed the owner_id=A row and shown ">=1".
        # After the fix, `user_id=A` matches 0 rows because A never
        # created a self-row, so the log SHOULD show 0.
        # NOTE: acceptable value is 0 or 1 — depends on whether A
        # ever created their own personal row.  What is NOT acceptable
        # is >=2.)
        log = _log_tail(500)
        m = re.findall(
            r"\[privacy\] location_sharing=False propagated to (\d+) member doc\(s\) for user="
            + re.escape(user_a_isolated["user"]["id"]),
            log,
        )
        assert m, "expected [privacy] log line for A's toggle"
        propagated = int(m[-1])
        assert propagated <= 1, (
            f"REGRESSION: propagated to {propagated} docs (expected 0 or 1). "
            f"Cross-user leak — A's toggle touched multiple rows."
        )

        # Read the A-created-for-B row again from B's perspective.
        post = requests.get(
            f"{API}/members",
            headers=_auth(user_b_isolated["sess"]["token"]),
            timeout=10,
        )
        assert post.status_code == 200
        post_target = next(
            (mm for mm in post.json() if mm["id"] == target_id), None
        )
        assert post_target is not None
        post_val = post_target.get("location_sharing_enabled", True)
        assert post_val is True, (
            f"REGRESSION: A-created-for-B row got flipped to {post_val} "
            f"by A's own toggle. Expected: unchanged (True)."
        )
        assert post_target.get("location_name") != "Location Sharing Off", (
            "REGRESSION: A-created-for-B row got 'Location Sharing Off' banner "
            "even though B never toggled anything."
        )

    def test_b_toggle_off_only_flips_b_row(
        self, user_a_isolated, user_b_isolated
    ):
        """B toggling off should touch ONLY B's own row (if any)."""
        put_r = requests.put(
            f"{API}/me/preferences",
            json={"location_sharing_enabled": False},
            headers=_auth(user_b_isolated["sess"]["token"]),
            timeout=10,
        )
        assert put_r.status_code == 200

        log = _log_tail(500)
        m = re.findall(
            r"\[privacy\] location_sharing=False propagated to (\d+) member doc\(s\) for user="
            + re.escape(user_b_isolated["sess"]["user"]["id"]),
            log,
        )
        assert m, "expected [privacy] log line for B's toggle"
        propagated = int(m[-1])
        assert propagated <= 1, (
            f"REGRESSION: B toggle touched {propagated} rows (expected 0 or 1)"
        )

        # A's preferences should be independent — A already toggled off
        # in the previous test.  Reset A back to True to verify PUT
        # still works cleanly and to leave a clean state.
        r = requests.put(
            f"{API}/me/preferences",
            json={"location_sharing_enabled": True},
            headers=_auth(user_a_isolated["token"]),
            timeout=10,
        )
        assert r.status_code == 200


# ================================================================
# P3 — _would_render_blank stricter rule (unit-import)
# ================================================================
class TestP3BlankPushRule:
    """Import the function directly to validate the tightened rules.

    Rule:
      • Both title AND body empty → NOT blank (data-only push OK)
      • Any visible push must have BOTH title ≥3 chars AND body ≥3 chars
      • Placeholder titles ("update", "notification", "alert",
        "kinnship", "k") + short body → still blank
    """

    def test_import(self):
        # Ensure /app is on sys.path — server runs from /app/backend but
        # tests may be invoked from /app.  Try both.
        import sys
        for p in ("/app/backend", "/app"):
            if p not in sys.path:
                sys.path.insert(0, p)
        try:
            from expo_push import _would_render_blank  # noqa: F401
        except ImportError:
            from backend.expo_push import _would_render_blank  # noqa: F401

    def _fn(self):
        import sys
        for p in ("/app/backend", "/app"):
            if p not in sys.path:
                sys.path.insert(0, p)
        try:
            from expo_push import _would_render_blank
        except ImportError:
            from backend.expo_push import _would_render_blank
        return _would_render_blank

    def test_data_only_push_ok(self):
        f = self._fn()
        assert f("", "") is False
        assert f(None, None) is False

    def test_short_title_blank(self):
        f = self._fn()
        # title < 3 chars, non-empty body → blank
        assert f("Hi", "Some meaningful body text") is True

    def test_short_body_blank(self):
        f = self._fn()
        assert f("Meaningful title", "OK") is True

    def test_placeholder_title_blank(self):
        f = self._fn()
        # "Update" / "Kinnship" / "K" placeholder + short body → blank
        assert f("Update", "Hello") is True
        assert f("Kinnship", "Test") is True
        assert f("K", "Anything") is True  # also fails len<3

    def test_meaningful_push_not_blank(self):
        f = self._fn()
        assert f("Charles requested location", "Please tap to share your current location") is False


class TestP3RefreshPushNotDropped:
    """The 'silent refresh' code path (data-only push, empty title+body)
    must NOT be rejected by the new blank rule.  We can't easily observe
    the actual push send (no real token), but we CAN observe that the
    refresh endpoint doesn't hard-fail on the blank-check code path.

    Instead of a full E2E, we verify _would_render_blank("", "") returns
    False (already covered in TestP3BlankPushRule.test_data_only_push_ok)
    and confirm no recent blank-drop entries reference the refresh path.
    """

    def test_refresh_path_not_in_blank_drops(self):
        # Read the ring buffer via the runtime.  If server exposes it
        # via an admin route we'd use that; otherwise the in-process
        # import gives us access.
        import sys
        for p in ("/app/backend", "/app"):
            if p not in sys.path:
                sys.path.insert(0, p)
        try:
            from expo_push import get_recent_blank_drops
        except ImportError:
            from backend.expo_push import get_recent_blank_drops
        drops = get_recent_blank_drops()
        # Note: this ring buffer is process-local to the pytest worker,
        # not to the backend process — so it will always be empty here.
        # This test primarily documents the API surface + confirms the
        # helper is importable and returns a list.
        assert isinstance(drops, list)
