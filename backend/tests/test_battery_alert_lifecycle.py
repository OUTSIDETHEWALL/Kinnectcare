"""
test_battery_alert_lifecycle.py — Unit tests for check_low_battery()
Tasks #19, #20, and #27 (Battery Alert Reliability sprint)

Uses unittest.mock to isolate the helper from MongoDB and push fanout
so these tests run without a live database or Expo push service.

Acceptance test coverage (from sprint spec):
  Test 1 — Trigger:    battery 20% → 15%  → alert created, push sent, flag set
  Test 2 — No dup:     battery stays at 10% → no second alert, no second push
  Test 3 — Recovery:   battery 10% → 26%  → alert resolved, flag cleared, push sent
  Test 4 — Re-trigger: battery 26% → 14%  → new alert, new push, lifecycle repeats
  Hysteresis:          battery rises to 16–24% → no recovery (below 25% clear band)
"""

import asyncio
import sys
import os
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

# ── bootstrap: server.py reads env vars at import time ───────────────────────
# Stub out the minimum required vars so the module loads without a live
# MongoDB instance.  The `db` object is replaced by a mock fixture before
# any test runs, so these values are never actually used.
_ENV_STUBS = {
    "MONGO_URL": "mongodb://localhost:27017",
    "DB_NAME":   "kinnship_test",
    "JWT_SECRET": "test-secret",
}
for _k, _v in _ENV_STUBS.items():
    os.environ.setdefault(_k, _v)

# Patch AsyncIOMotorClient before server.py initialises the real client so the
# import succeeds even without a reachable MongoDB.
with patch("motor.motor_asyncio.AsyncIOMotorClient", MagicMock()):
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
    import server  # noqa: E402  (import after env setup is intentional)


# ── constants ─────────────────────────────────────────────────────────────────

MEMBER_ID       = "test-member-bat-001"
FAMILY_GROUP_ID = "test-fg-bat-001"
OWNER_ID        = "test-owner-bat-001"


# ── runner ────────────────────────────────────────────────────────────────────

def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _call(battery_level: float, was_alerted: bool = False, name: str = "Joyce"):
    """Invoke check_low_battery() with the given battery level and flag state."""
    prev_doc = {"low_battery_alerted": was_alerted, "name": name}
    return _run(
        server.check_low_battery(
            member_id=MEMBER_ID,
            family_group_id=FAMILY_GROUP_ID,
            owner_id=OWNER_ID,
            exclude_user_id=OWNER_ID,
            battery_level=battery_level,
            prev_doc=prev_doc,
        )
    )


# ── fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def mock_db():
    """Replace the module-level `db` with a mock for each test."""
    m = MagicMock()
    m.alerts.insert_one = AsyncMock()
    m.alerts.update_one = AsyncMock()
    m.members.update_one = AsyncMock()
    with patch.object(server, "db", m):
        yield m


@pytest.fixture(autouse=True)
def mock_push():
    """Prevent real push notifications during tests."""
    m = AsyncMock(return_value=0)
    with patch.object(server, "push_to_family_group", m):
        yield m


# ── Test 1: Trigger ───────────────────────────────────────────────────────────

class TestTrigger:
    """Battery crosses below 15% while low_battery_alerted is False."""

    def test_alert_inserted(self, mock_db, mock_push):
        _call(battery_level=0.14, was_alerted=False)
        mock_db.alerts.insert_one.assert_called_once()
        doc = mock_db.alerts.insert_one.call_args[0][0]
        assert doc["type"] == "low_battery"
        assert doc["severity"] == "warning"
        assert doc["member_id"] == MEMBER_ID
        assert doc["family_group_id"] == FAMILY_GROUP_ID
        assert "14%" in doc["message"]
        assert "Joyce" in doc["title"]

    def test_push_sent(self, mock_db, mock_push):
        _call(battery_level=0.14, was_alerted=False)
        mock_push.assert_called_once()
        data_arg = mock_push.call_args[1].get("data") or mock_push.call_args[0][3]
        assert data_arg["type"] == "low_battery"
        assert "alert_id" in data_arg

    def test_returns_flag_true(self, mock_db, mock_push):
        result = _call(battery_level=0.14, was_alerted=False)
        assert result == {"low_battery_alerted": True}

    def test_exactly_at_threshold(self, mock_db, mock_push):
        """battery_level == 0.15 must trigger (condition is <=, not <)."""
        result = _call(battery_level=0.15, was_alerted=False)
        assert result == {"low_battery_alerted": True}
        mock_db.alerts.insert_one.assert_called_once()

    def test_push_excludes_owner(self, mock_db, mock_push):
        """The monitored device's owner should not receive their own alert."""
        _call(battery_level=0.10, was_alerted=False)
        kwargs = mock_push.call_args[1]
        assert kwargs.get("exclude_user_id") == OWNER_ID


# ── Test 2: No duplicate ──────────────────────────────────────────────────────

class TestNoDuplicate:
    """Battery stays below threshold while low_battery_alerted is already True."""

    def test_no_second_alert(self, mock_db, mock_push):
        result = _call(battery_level=0.10, was_alerted=True)
        mock_db.alerts.insert_one.assert_not_called()
        mock_push.assert_not_called()
        assert result == {}

    def test_no_second_alert_at_exact_threshold(self, mock_db, mock_push):
        result = _call(battery_level=0.15, was_alerted=True)
        mock_db.alerts.insert_one.assert_not_called()
        mock_push.assert_not_called()
        assert result == {}


# ── Hysteresis band ───────────────────────────────────────────────────────────

class TestHysteresis:
    """Battery rises above 15% but below 25% — alert must NOT clear."""

    @pytest.mark.parametrize("pct", [0.151, 0.16, 0.20, 0.24, 0.249])
    def test_no_recovery_in_band(self, mock_db, mock_push, pct):
        result = _call(battery_level=pct, was_alerted=True)
        assert result == {}, f"Expected no-op at {pct*100:.1f}%"
        mock_db.alerts.update_one.assert_not_called()
        mock_push.assert_not_called()

    def test_no_recovery_below_clear_threshold(self, mock_db, mock_push):
        result = _call(battery_level=0.249, was_alerted=True)
        assert result == {}

    def test_not_alerted_and_above_trigger_is_noop(self, mock_db, mock_push):
        """Battery fine (20%), no prior alert — nothing should happen."""
        result = _call(battery_level=0.20, was_alerted=False)
        assert result == {}
        mock_db.alerts.insert_one.assert_not_called()
        mock_db.alerts.update_one.assert_not_called()


# ── Test 3: Recovery ──────────────────────────────────────────────────────────

class TestRecovery:
    """Battery reaches >= 25% while low_battery_alerted is True."""

    def test_alert_resolved(self, mock_db, mock_push):
        _call(battery_level=0.26, was_alerted=True)
        mock_db.alerts.update_one.assert_called_once()
        filt = mock_db.alerts.update_one.call_args[0][0]
        upd  = mock_db.alerts.update_one.call_args[0][1]
        assert filt["type"] == "low_battery"
        assert filt["member_id"] == MEMBER_ID
        assert filt["family_group_id"] == FAMILY_GROUP_ID
        assert filt["resolved"] == {"$ne": True}
        assert upd["$set"]["resolved"] is True
        assert "resolved_at" in upd["$set"]

    def test_returns_flag_false(self, mock_db, mock_push):
        result = _call(battery_level=0.26, was_alerted=True)
        assert result == {"low_battery_alerted": False}

    def test_push_sent_on_recovery(self, mock_db, mock_push):
        """Recovery sends a push so caregivers know the phone is charging again."""
        _call(battery_level=0.26, was_alerted=True)
        mock_push.assert_called_once()

    def test_recovery_push_type(self, mock_db, mock_push):
        """Push data must carry type='battery_recovered' so the client routes it correctly."""
        _call(battery_level=0.26, was_alerted=True)
        data_arg = mock_push.call_args[1].get("data") or mock_push.call_args[0][3]
        assert data_arg["type"] == "battery_recovered"
        assert data_arg["member_id"] == MEMBER_ID

    def test_recovery_push_content(self, mock_db, mock_push):
        """Push title and body must mention the member name and current battery %."""
        _call(battery_level=0.26, was_alerted=True, name="Joyce")
        kwargs = mock_push.call_args[1]
        assert "Joyce" in kwargs["title"]
        assert "charging" in kwargs["title"].lower()
        assert "26%" in kwargs["body"]

    def test_recovery_push_excludes_owner(self, mock_db, mock_push):
        """The monitored device's owner must not receive their own recovery push."""
        _call(battery_level=0.26, was_alerted=True)
        kwargs = mock_push.call_args[1]
        assert kwargs.get("exclude_user_id") == OWNER_ID

    def test_exactly_at_clear_threshold(self, mock_db, mock_push):
        """battery_level == 0.25 must recover (condition is >=, not >)."""
        result = _call(battery_level=0.25, was_alerted=True)
        assert result == {"low_battery_alerted": False}
        mock_db.alerts.update_one.assert_called_once()

    def test_no_alert_insert_on_recovery(self, mock_db, mock_push):
        _call(battery_level=0.30, was_alerted=True)
        mock_db.alerts.insert_one.assert_not_called()


# ── Test 4: Re-trigger after recovery ─────────────────────────────────────────

class TestRetrigger:
    """Full lifecycle: trigger → recovery → trigger again."""

    def test_new_alert_after_full_recovery(self, mock_db, mock_push):
        """Simulate charged to 26% (flag reset to False) → drops to 14% again."""
        result = _call(battery_level=0.14, was_alerted=False)
        assert result == {"low_battery_alerted": True}
        mock_db.alerts.insert_one.assert_called_once()
        mock_push.assert_called_once()

    def test_no_alert_without_reset(self, mock_db, mock_push):
        """Without completing a recovery cycle the flag stays True — no re-alert."""
        result = _call(battery_level=0.08, was_alerted=True)
        assert result == {}
        mock_db.alerts.insert_one.assert_not_called()
