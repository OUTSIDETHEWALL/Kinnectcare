"""
test_call_button_phone_field.py
Task #47 — Confirm the 'Call' button appears and dials correctly on a real battery-low alert.

Verifies that check_low_battery() correctly writes (or omits) member_phone
in the alert document so the frontend can render (or hide) the "Call" button.

Coverage:
  1. Member with phone: member_phone is written into the alert doc.
  2. Member without phone: member_phone is absent / None in the alert doc.
  3. Empty-string phone: treated the same as no phone (falsy → None).
  4. Phone value matches the member's stored phone exactly (no transformation).
"""

import asyncio
import sys
import os
import pytest
from unittest.mock import AsyncMock, MagicMock, patch, call as mock_call

# ── bootstrap ────────────────────────────────────────────────────────────────
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

MEMBER_ID       = "test-member-call-001"
FAMILY_GROUP_ID = "test-fg-call-001"
OWNER_ID        = "test-owner-call-001"
MEMBER_PHONE    = "+14805550100"


# ── runner ────────────────────────────────────────────────────────────────────

def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _call(battery_level: float, prev_doc: dict):
    """Invoke check_low_battery() with the given battery level and member doc."""
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
    m = MagicMock()
    m.alerts.insert_one = AsyncMock()
    m.alerts.find_one_and_update = AsyncMock(return_value={"_id": "alert-id-001"})
    m.members.update_one = AsyncMock()
    with patch.object(server, "db", m):
        yield m


@pytest.fixture(autouse=True)
def mock_push():
    m = AsyncMock(return_value=0)
    with patch.object(server, "push_to_family_group", m):
        yield m


# ── Test 1: member WITH phone — member_phone written into alert doc ───────────

class TestMemberWithPhone:
    """When the member document has a phone number, it must appear in the alert."""

    def test_member_phone_written_to_alert(self, mock_db, mock_push):
        prev_doc = {
            "low_battery_alerted": False,
            "name": "Joyce",
            "phone": MEMBER_PHONE,
        }
        _call(battery_level=0.10, prev_doc=prev_doc)

        mock_db.alerts.insert_one.assert_called_once()
        doc = mock_db.alerts.insert_one.call_args[0][0]
        assert doc["member_phone"] == MEMBER_PHONE, (
            f"Expected member_phone='{MEMBER_PHONE}' in alert doc, got {doc.get('member_phone')!r}"
        )

    def test_member_phone_exact_value_preserved(self, mock_db, mock_push):
        """No reformatting: the raw phone string stored on the member is passed through."""
        raw_phone = "602-555-0100"
        prev_doc = {"low_battery_alerted": False, "name": "Joyce", "phone": raw_phone}
        _call(battery_level=0.10, prev_doc=prev_doc)

        doc = mock_db.alerts.insert_one.call_args[0][0]
        assert doc["member_phone"] == raw_phone

    def test_alert_type_is_low_battery(self, mock_db, mock_push):
        """Sanity: type must be 'low_battery' so the frontend guard matches."""
        prev_doc = {"low_battery_alerted": False, "name": "Joyce", "phone": MEMBER_PHONE}
        _call(battery_level=0.10, prev_doc=prev_doc)

        doc = mock_db.alerts.insert_one.call_args[0][0]
        assert doc["type"] == "low_battery"


# ── Test 2: member WITHOUT phone — member_phone is None/absent ────────────────

class TestMemberWithoutPhone:
    """When the member has no phone, member_phone must be None so the frontend
    hides the Call button (the guard is: type==='low_battery' && !!member_phone)."""

    def test_member_phone_is_none_when_absent(self, mock_db, mock_push):
        prev_doc = {"low_battery_alerted": False, "name": "Joyce"}  # no 'phone' key
        _call(battery_level=0.10, prev_doc=prev_doc)

        mock_db.alerts.insert_one.assert_called_once()
        doc = mock_db.alerts.insert_one.call_args[0][0]
        # member_phone must be None (falsy) so the frontend !!member_phone guard hides the button
        assert doc.get("member_phone") is None, (
            f"Expected member_phone=None, got {doc.get('member_phone')!r}"
        )

    def test_empty_string_phone_treated_as_none(self, mock_db, mock_push):
        """An empty-string phone is indistinguishable from no phone — must be stored as None."""
        prev_doc = {"low_battery_alerted": False, "name": "Joyce", "phone": ""}
        _call(battery_level=0.10, prev_doc=prev_doc)

        doc = mock_db.alerts.insert_one.call_args[0][0]
        # prev_doc.get("phone") or None collapses "" to None
        assert doc.get("member_phone") is None, (
            f"Empty-string phone should be None in alert doc, got {doc.get('member_phone')!r}"
        )

    def test_no_phone_still_creates_alert(self, mock_db, mock_push):
        """Missing phone must not block alert creation — just hide the Call button."""
        prev_doc = {"low_battery_alerted": False, "name": "Joyce"}
        result = _call(battery_level=0.10, prev_doc=prev_doc)
        mock_db.alerts.insert_one.assert_called_once()
        assert result == {"low_battery_alerted": True}


# ── Test 3: guard-condition simulation ────────────────────────────────────────

class TestFrontendGuardCondition:
    """Verify that the values written to the alert doc behave correctly under
    the frontend's JavaScript guard: type === 'low_battery' && !!member_phone.

    This is a Python-side simulation of the boolean logic in alerts.tsx so the
    guard contract is tested at the source (alert creation), not just in the UI.
    """

    def _would_show_call_button(self, doc: dict) -> bool:
        """Mirror of the frontend guard: type === 'low_battery' && !!member_phone."""
        return doc.get("type") == "low_battery" and bool(doc.get("member_phone"))

    def test_call_button_shown_for_member_with_phone(self, mock_db, mock_push):
        prev_doc = {"low_battery_alerted": False, "name": "Joyce", "phone": MEMBER_PHONE}
        _call(battery_level=0.10, prev_doc=prev_doc)
        doc = mock_db.alerts.insert_one.call_args[0][0]
        assert self._would_show_call_button(doc) is True

    def test_call_button_hidden_for_member_without_phone(self, mock_db, mock_push):
        prev_doc = {"low_battery_alerted": False, "name": "Joyce"}
        _call(battery_level=0.10, prev_doc=prev_doc)
        doc = mock_db.alerts.insert_one.call_args[0][0]
        assert self._would_show_call_button(doc) is False

    def test_call_button_hidden_for_empty_string_phone(self, mock_db, mock_push):
        prev_doc = {"low_battery_alerted": False, "name": "Joyce", "phone": ""}
        _call(battery_level=0.10, prev_doc=prev_doc)
        doc = mock_db.alerts.insert_one.call_args[0][0]
        assert self._would_show_call_button(doc) is False

    def test_tel_url_construction_matches_phone(self, mock_db, mock_push):
        """The tel: URL the frontend will open must use the exact stored phone value."""
        prev_doc = {"low_battery_alerted": False, "name": "Joyce", "phone": MEMBER_PHONE}
        _call(battery_level=0.10, prev_doc=prev_doc)
        doc = mock_db.alerts.insert_one.call_args[0][0]
        tel_url = f"tel:{doc['member_phone']}"
        assert tel_url == f"tel:{MEMBER_PHONE}"
