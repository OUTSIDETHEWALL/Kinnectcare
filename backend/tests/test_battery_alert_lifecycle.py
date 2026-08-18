"""
test_battery_alert_lifecycle.py — Unit tests for check_low_battery()

Two-tier battery alert system:
  • Early warning (≤ 20 %): type='low_battery_warning', sets low_battery_warn_alerted=True
  • Critical      (≤ 15 %): type='low_battery',         sets low_battery_alerted=True
  • Reset: battery ≥ 25 % OR is_charging=True → both flags cleared, both alert types resolved

Coverage:
  TestCriticalTrigger    — 15 % critical tier fires correctly
  TestWarningTier        — 20 % early-warning tier fires correctly, critical skips warning
  TestNoDuplicate        — no double-alert when both flags already set
  TestHysteresis         — 15–24 % range never triggers recovery
  TestRecovery           — battery ≥ 25 % resolves both alert types and pushes recovery
  TestIsChargingReset    — is_charging=True triggers reset regardless of battery level
  TestConcurrentRecovery — exactly one recovery push when both upload paths converge
  TestRetrigger          — full lifecycle repeats after a complete charge cycle
"""

import asyncio
import sys
import os
from typing import Optional
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

# ── bootstrap: server.py reads env vars at import time ───────────────────────
_ENV_STUBS = {
    "MONGO_URL":   "mongodb://localhost:27017",
    "DB_NAME":     "kinnship_test",
    "JWT_SECRET":  "test-secret",
}
for _k, _v in _ENV_STUBS.items():
    os.environ.setdefault(_k, _v)

with patch("motor.motor_asyncio.AsyncIOMotorClient", MagicMock()):
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
    import server  # noqa: E402


# ── constants ─────────────────────────────────────────────────────────────────

MEMBER_ID       = "test-member-bat-001"
FAMILY_GROUP_ID = "test-fg-bat-001"
OWNER_ID        = "test-owner-bat-001"


# ── runner ────────────────────────────────────────────────────────────────────

def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _call(
    battery_level: float,
    was_alerted: bool = False,
    was_warn_alerted: bool = False,
    name: str = "Joyce",
    is_charging: Optional[bool] = None,
):
    """Invoke check_low_battery() with the given battery level and flag states.

    was_alerted      maps to low_battery_alerted      (critical tier flag)
    was_warn_alerted maps to low_battery_warn_alerted (warning tier flag)

    In production both flags are always written together when the critical
    tier fires (warn is set to True alongside crit).  Tests that simulate a
    real post-critical state should pass was_warn_alerted=True alongside
    was_alerted=True.
    """
    prev_doc = {
        "low_battery_alerted":      was_alerted,
        "low_battery_warn_alerted": was_warn_alerted,
        "name":                     name,
    }
    return _run(
        server.check_low_battery(
            member_id=MEMBER_ID,
            family_group_id=FAMILY_GROUP_ID,
            owner_id=OWNER_ID,
            exclude_user_id=OWNER_ID,
            battery_level=battery_level,
            is_charging=is_charging,
            prev_doc=prev_doc,
        )
    )


# ── fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def mock_db():
    """Replace the module-level `db` with a mock for each test."""
    m = MagicMock()
    m.alerts.insert_one       = AsyncMock()
    m.alerts.update_one       = AsyncMock()
    m.alerts.update_many      = AsyncMock()
    # find_one_and_update returns a doc by default (simulates winning the race).
    # Tests that want to simulate the "already resolved by a concurrent caller"
    # path override return_value to None.
    m.alerts.find_one_and_update = AsyncMock(return_value={"_id": "alert-id-001"})
    m.members.update_one      = AsyncMock()
    with patch.object(server, "db", m):
        yield m


@pytest.fixture(autouse=True)
def mock_push():
    """Prevent real push notifications during tests."""
    m = AsyncMock(return_value=0)
    with patch.object(server, "push_to_family_group", m):
        yield m


# ── TestCriticalTrigger ───────────────────────────────────────────────────────

class TestCriticalTrigger:
    """Battery crosses ≤ 15 % while low_battery_alerted is False."""

    def test_alert_inserted(self, mock_db, mock_push):
        _call(battery_level=0.14)
        mock_db.alerts.insert_one.assert_called_once()
        doc = mock_db.alerts.insert_one.call_args[0][0]
        assert doc["type"] == "low_battery"
        assert doc["severity"] == "warning"
        assert doc["member_id"] == MEMBER_ID
        assert doc["family_group_id"] == FAMILY_GROUP_ID
        assert "14%" in doc["message"]
        assert "Joyce" in doc["title"]
        assert "critically low" in doc["title"].lower()

    def test_push_sent(self, mock_db, mock_push):
        _call(battery_level=0.14)
        mock_push.assert_called_once()
        data_arg = mock_push.call_args[1].get("data") or mock_push.call_args[0][3]
        assert data_arg["type"] == "low_battery"
        assert "alert_id" in data_arg

    def test_returns_both_flags_true(self, mock_db, mock_push):
        """Critical tier sets both flags so the warning doesn't fire retroactively."""
        result = _call(battery_level=0.14)
        assert result == {"low_battery_alerted": True, "low_battery_warn_alerted": True}

    def test_exactly_at_threshold(self, mock_db, mock_push):
        """battery_level == 0.15 must trigger (condition is <=, not <)."""
        result = _call(battery_level=0.15)
        assert result == {"low_battery_alerted": True, "low_battery_warn_alerted": True}
        mock_db.alerts.insert_one.assert_called_once()

    def test_push_excludes_owner(self, mock_db, mock_push):
        """The monitored device's owner should not receive their own alert."""
        _call(battery_level=0.10)
        kwargs = mock_push.call_args[1]
        assert kwargs.get("exclude_user_id") == OWNER_ID

    def test_critical_skips_warning_insert(self, mock_db, mock_push):
        """Only one alert is inserted (critical) even though battery also crossed 20%."""
        _call(battery_level=0.14)
        # insert_one called exactly once — for the critical alert, not a second for warning
        mock_db.alerts.insert_one.assert_called_once()
        doc = mock_db.alerts.insert_one.call_args[0][0]
        assert doc["type"] == "low_battery"

    def test_only_one_push_sent(self, mock_db, mock_push):
        """Exactly one push, not two (not one per tier)."""
        _call(battery_level=0.10)
        assert mock_push.call_count == 1


# ── TestWarningTier ───────────────────────────────────────────────────────────

class TestWarningTier:
    """Battery crosses ≤ 20 % but stays above 15 % — early-warning tier fires."""

    def test_warning_alert_inserted(self, mock_db, mock_push):
        _call(battery_level=0.19)
        mock_db.alerts.insert_one.assert_called_once()
        doc = mock_db.alerts.insert_one.call_args[0][0]
        assert doc["type"] == "low_battery_warning"
        assert doc["severity"] == "warning"
        assert "19%" in doc["message"]
        assert "Joyce" in doc["title"]
        assert "getting low" in doc["title"].lower()

    def test_warning_push_sent(self, mock_db, mock_push):
        _call(battery_level=0.19)
        mock_push.assert_called_once()
        data_arg = mock_push.call_args[1].get("data") or mock_push.call_args[0][3]
        assert data_arg["type"] == "low_battery_warning"

    def test_returns_only_warn_flag(self, mock_db, mock_push):
        """Warning tier sets only low_battery_warn_alerted — critical flag untouched."""
        result = _call(battery_level=0.19)
        assert result == {"low_battery_warn_alerted": True}

    def test_exactly_at_warning_threshold(self, mock_db, mock_push):
        """battery_level == 0.20 must trigger the warning (condition is <=)."""
        result = _call(battery_level=0.20)
        assert result == {"low_battery_warn_alerted": True}
        mock_db.alerts.insert_one.assert_called_once()

    def test_no_warning_when_already_warned(self, mock_db, mock_push):
        """Warning flag already set — no second insert, no second push."""
        result = _call(battery_level=0.18, was_warn_alerted=True)
        mock_db.alerts.insert_one.assert_not_called()
        mock_push.assert_not_called()
        assert result == {}

    def test_no_warning_after_critical_fired(self, mock_db, mock_push):
        """Both flags already set (realistic post-critical state) — no inserts."""
        result = _call(battery_level=0.14, was_alerted=True, was_warn_alerted=True)
        mock_db.alerts.insert_one.assert_not_called()
        mock_push.assert_not_called()
        assert result == {}


# ── TestNoDuplicate ───────────────────────────────────────────────────────────

class TestNoDuplicate:
    """Battery stays below thresholds while both alert flags are already True."""

    def test_no_second_alert(self, mock_db, mock_push):
        result = _call(battery_level=0.10, was_alerted=True, was_warn_alerted=True)
        mock_db.alerts.insert_one.assert_not_called()
        mock_push.assert_not_called()
        assert result == {}

    def test_no_second_alert_at_critical_threshold(self, mock_db, mock_push):
        result = _call(battery_level=0.15, was_alerted=True, was_warn_alerted=True)
        mock_db.alerts.insert_one.assert_not_called()
        mock_push.assert_not_called()
        assert result == {}

    def test_no_second_alert_at_warning_threshold(self, mock_db, mock_push):
        result = _call(battery_level=0.20, was_alerted=True, was_warn_alerted=True)
        mock_db.alerts.insert_one.assert_not_called()
        mock_push.assert_not_called()
        assert result == {}


# ── TestHysteresis ────────────────────────────────────────────────────────────

class TestHysteresis:
    """Battery rises above 15 % but stays below 25 % — alert must NOT clear."""

    @pytest.mark.parametrize("pct", [0.151, 0.16, 0.20, 0.24, 0.249])
    def test_no_recovery_in_band(self, mock_db, mock_push, pct):
        # Simulate post-critical state: both flags set, battery in the band
        result = _call(battery_level=pct, was_alerted=True, was_warn_alerted=True)
        assert result == {}, f"Expected no-op at {pct*100:.1f}%"
        mock_db.alerts.update_one.assert_not_called()
        mock_push.assert_not_called()

    def test_no_recovery_below_clear_threshold(self, mock_db, mock_push):
        result = _call(battery_level=0.249, was_alerted=True, was_warn_alerted=True)
        assert result == {}

    def test_above_warning_threshold_no_flags_is_noop(self, mock_db, mock_push):
        """Battery at 21% with no prior alerts — 21% > 20% warn threshold, so no-op."""
        result = _call(battery_level=0.21, was_alerted=False, was_warn_alerted=False)
        assert result == {}
        mock_db.alerts.insert_one.assert_not_called()
        mock_db.alerts.update_one.assert_not_called()


# ── TestRecovery ──────────────────────────────────────────────────────────────

class TestRecovery:
    """Battery reaches ≥ 25 % while at least one alert flag is True."""

    def test_find_one_and_update_called(self, mock_db, mock_push):
        _call(battery_level=0.26, was_alerted=True, was_warn_alerted=True)
        mock_db.alerts.find_one_and_update.assert_called_once()

    def test_filter_covers_both_alert_types(self, mock_db, mock_push):
        """Recovery resolves both low_battery and low_battery_warning alerts."""
        _call(battery_level=0.26, was_alerted=True, was_warn_alerted=True)
        filt = mock_db.alerts.find_one_and_update.call_args[0][0]
        assert filt["type"] == {"$in": ["low_battery", "low_battery_warning"]}
        assert filt["member_id"] == MEMBER_ID
        assert filt["family_group_id"] == FAMILY_GROUP_ID
        assert filt["resolved"] == {"$ne": True}

    def test_update_marks_resolved(self, mock_db, mock_push):
        _call(battery_level=0.26, was_alerted=True, was_warn_alerted=True)
        upd = mock_db.alerts.find_one_and_update.call_args[0][1]
        assert upd["$set"]["resolved"] is True
        assert "resolved_at" in upd["$set"]

    def test_update_many_cleans_up_remaining(self, mock_db, mock_push):
        """update_many resolves any remaining open alerts of either type."""
        _call(battery_level=0.26, was_alerted=True, was_warn_alerted=True)
        mock_db.alerts.update_many.assert_called_once()
        filt = mock_db.alerts.update_many.call_args[0][0]
        assert filt["type"] == {"$in": ["low_battery", "low_battery_warning"]}

    def test_returns_both_flags_false(self, mock_db, mock_push):
        result = _call(battery_level=0.26, was_alerted=True, was_warn_alerted=True)
        assert result == {"low_battery_warn_alerted": False, "low_battery_alerted": False}

    def test_push_sent_on_recovery(self, mock_db, mock_push):
        _call(battery_level=0.26, was_alerted=True, was_warn_alerted=True)
        mock_push.assert_called_once()

    def test_recovery_push_type(self, mock_db, mock_push):
        _call(battery_level=0.26, was_alerted=True, was_warn_alerted=True)
        data_arg = mock_push.call_args[1].get("data") or mock_push.call_args[0][3]
        assert data_arg["type"] == "battery_recovered"
        assert data_arg["member_id"] == MEMBER_ID

    def test_recovery_push_content(self, mock_db, mock_push):
        _call(battery_level=0.26, was_alerted=True, was_warn_alerted=True, name="Joyce")
        kwargs = mock_push.call_args[1]
        assert "Joyce" in kwargs["title"]
        assert "charging" in kwargs["title"].lower()
        assert "26%" in kwargs["body"]

    def test_recovery_push_excludes_owner(self, mock_db, mock_push):
        _call(battery_level=0.26, was_alerted=True, was_warn_alerted=True)
        kwargs = mock_push.call_args[1]
        assert kwargs.get("exclude_user_id") == OWNER_ID

    def test_exactly_at_clear_threshold(self, mock_db, mock_push):
        """battery_level == 0.25 must recover (condition is >=, not >)."""
        result = _call(battery_level=0.25, was_alerted=True, was_warn_alerted=True)
        assert result == {"low_battery_warn_alerted": False, "low_battery_alerted": False}
        mock_db.alerts.find_one_and_update.assert_called_once()

    def test_no_alert_insert_on_recovery(self, mock_db, mock_push):
        _call(battery_level=0.30, was_alerted=True, was_warn_alerted=True)
        mock_db.alerts.insert_one.assert_not_called()

    def test_only_warn_flag_set_still_recovers(self, mock_db, mock_push):
        """Warning fired but critical never did — recovery still clears."""
        result = _call(battery_level=0.26, was_alerted=False, was_warn_alerted=True)
        assert result == {"low_battery_warn_alerted": False, "low_battery_alerted": False}
        mock_push.assert_called_once()


# ── TestIsChargingReset ───────────────────────────────────────────────────────

class TestIsChargingReset:
    """is_charging=True resets both flags even when battery is still below 25 %."""

    def test_charging_at_low_battery_resets(self, mock_db, mock_push):
        """Phone starts charging at 20 % — still below clear threshold but should reset."""
        result = _call(
            battery_level=0.20,
            was_alerted=True,
            was_warn_alerted=True,
            is_charging=True,
        )
        assert result == {"low_battery_warn_alerted": False, "low_battery_alerted": False}
        mock_push.assert_called_once()

    def test_charging_at_critical_level_resets(self, mock_db, mock_push):
        """Phone plugged in at 14 % — recovery fires immediately."""
        result = _call(
            battery_level=0.14,
            was_alerted=True,
            was_warn_alerted=True,
            is_charging=True,
        )
        assert result == {"low_battery_warn_alerted": False, "low_battery_alerted": False}
        mock_db.alerts.insert_one.assert_not_called()

    def test_not_charging_no_reset_below_25(self, mock_db, mock_push):
        """is_charging=False below 25 % — no reset."""
        result = _call(
            battery_level=0.20,
            was_alerted=True,
            was_warn_alerted=True,
            is_charging=False,
        )
        assert result == {}

    def test_charging_no_flags_still_fires_critical(self, mock_db, mock_push):
        """Phone plugged in at 14 % with no prior alert — critical tier still fires.

        is_charging only affects the *reset* path (when flags are already set).
        If the phone drops to 14 % and is then plugged in before the next PATCH
        arrives, the reset block is skipped (both flags are False) and the
        critical alert fires normally.  The server will resolve it on the next
        reading once battery climbs ≥ 25 % with charging=True.
        """
        result = _call(battery_level=0.14, was_alerted=False, was_warn_alerted=False, is_charging=True)
        assert result == {"low_battery_alerted": True, "low_battery_warn_alerted": True}
        mock_db.alerts.insert_one.assert_called_once()


# ── TestConcurrentRecovery ────────────────────────────────────────────────────

class TestConcurrentRecovery:
    """Both upload paths recover at the same moment — exactly one push must fire."""

    def test_first_caller_sends_push(self, mock_db, mock_push):
        _call(battery_level=0.26, was_alerted=True, was_warn_alerted=True)
        mock_push.assert_called_once()

    def test_second_caller_skips_push(self, mock_db, mock_push):
        mock_db.alerts.find_one_and_update.return_value = None
        _call(battery_level=0.26, was_alerted=True, was_warn_alerted=True)
        mock_push.assert_not_called()

    def test_second_caller_still_clears_both_flags(self, mock_db, mock_push):
        mock_db.alerts.find_one_and_update.return_value = None
        result = _call(battery_level=0.26, was_alerted=True, was_warn_alerted=True)
        assert result == {"low_battery_warn_alerted": False, "low_battery_alerted": False}

    def test_second_caller_still_calls_find_one_and_update(self, mock_db, mock_push):
        mock_db.alerts.find_one_and_update.return_value = None
        _call(battery_level=0.26, was_alerted=True, was_warn_alerted=True)
        mock_db.alerts.find_one_and_update.assert_called_once()


# ── TestRetrigger ─────────────────────────────────────────────────────────────

class TestRetrigger:
    """Full lifecycle: trigger → recovery → trigger again."""

    def test_critical_after_full_recovery(self, mock_db, mock_push):
        """Simulate charged to 26 % (flags reset) → drops to 14 % again."""
        result = _call(battery_level=0.14, was_alerted=False, was_warn_alerted=False)
        assert result == {"low_battery_alerted": True, "low_battery_warn_alerted": True}
        mock_db.alerts.insert_one.assert_called_once()
        mock_push.assert_called_once()

    def test_warning_after_full_recovery(self, mock_db, mock_push):
        """After recovery, drops to 19 % — warning fires again."""
        result = _call(battery_level=0.19, was_alerted=False, was_warn_alerted=False)
        assert result == {"low_battery_warn_alerted": True}
        mock_db.alerts.insert_one.assert_called_once()
        doc = mock_db.alerts.insert_one.call_args[0][0]
        assert doc["type"] == "low_battery_warning"

    def test_no_alert_without_reset(self, mock_db, mock_push):
        """Without completing a recovery cycle the flag stays True — no re-alert."""
        result = _call(battery_level=0.08, was_alerted=True, was_warn_alerted=True)
        assert result == {}
        mock_db.alerts.insert_one.assert_not_called()
