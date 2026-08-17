"""
test_build48_alert_phone_backfill.py
Task #83 — Confirm the Call button appears on older low-battery alert rows
         after the Build 48 backfill runs.

What this file proves
---------------------
The Build 48 startup migration (_migrate_alerts_phone_backfill_v48) sweeps
every low_battery alert that is missing member_phone and copies the phone
number from the corresponding family_members document.

Coverage:
  1. Pre-existing alert with no member_phone → member_phone populated after migration.
  2. Pre-existing alert with empty-string member_phone → member_phone populated.
  3. Alert whose member has no phone → alert left untouched (no phone to copy).
  4. Alert for a member that no longer exists → alert skipped gracefully.
  5. Migration is idempotent — re-running when the sentinel doc exists is a no-op.
  6. Frontend guard simulation: after backfill, the Call button condition
     (type === 'low_battery' && !!member_phone) evaluates to True for rows
     that now have a phone number.
"""

import asyncio
import os
import sys
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

# ── bootstrap — stub env vars so server.py imports without a real Mongo ───────
_ENV_STUBS = {
    "MONGO_URL": "mongodb://localhost:27017",
    "DB_NAME":   "kinnship_test",
    "JWT_SECRET": "test-secret",
}
for _k, _v in _ENV_STUBS.items():
    os.environ.setdefault(_k, _v)

with patch("motor.motor_asyncio.AsyncIOMotorClient", MagicMock()):
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
    import server  # noqa: E402


# ── helpers ───────────────────────────────────────────────────────────────────

def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


class _AsyncCursor:
    """Minimal async iterator that wraps a list, mimicking Motor's cursor."""

    def __init__(self, docs):
        self._docs = iter(docs)

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return next(self._docs)
        except StopIteration:
            raise StopAsyncIteration


def _make_db(
    *,
    alerts: list,
    member_phone: str | None,
    member_exists: bool = True,
    sentinel_exists: bool = False,
):
    """
    Build a minimal mock DB for _migrate_alerts_phone_backfill_v48.

    Parameters
    ----------
    alerts        : raw alert docs the find() cursor will yield
    member_phone  : phone stored on the family_members doc (None = no phone)
    member_exists : whether find_one({"id": ...}) returns a doc
    sentinel_exists: whether the migrations sentinel doc already exists
    """
    m = MagicMock()

    # migrations.find_one — controls the idempotency guard
    m.migrations.find_one = AsyncMock(
        return_value={"_id": "alerts_phone_backfill_v48"} if sentinel_exists else None
    )
    m.migrations.update_one = AsyncMock()

    # alerts.find — returns the seeded alert list
    m.alerts.find = MagicMock(return_value=_AsyncCursor(alerts))
    m.alerts.update_one = AsyncMock(return_value=MagicMock(modified_count=1))

    # family_members.find_one — returns the member (or None)
    if member_exists and member_phone is not None:
        member_doc = {"id": "member-001", "phone": member_phone}
    elif member_exists:
        member_doc = {"id": "member-001"}  # no phone key at all
    else:
        member_doc = None
    m.family_members.find_one = AsyncMock(return_value=member_doc)

    return m


MIGRATION_FN = server._migrate_alerts_phone_backfill_v48

ALERT_NO_PHONE = {
    "_id": "mongo-oid-001",
    "id":  "alert-uuid-001",
    "type": "low_battery",
    "member_id": "member-001",
    "member_phone": None,
}

ALERT_EMPTY_PHONE = {
    "_id": "mongo-oid-002",
    "id":  "alert-uuid-002",
    "type": "low_battery",
    "member_id": "member-001",
    "member_phone": "",
}

MEMBER_PHONE = "+14805550100"


# ── Test 1: alert missing member_phone gets it filled in ─────────────────────

class TestBackfillsAlertWithNoPhone:
    """A low_battery alert that has member_phone=None must have it set after the migration."""

    def test_update_one_called_with_correct_phone(self):
        db = _make_db(alerts=[ALERT_NO_PHONE], member_phone=MEMBER_PHONE)
        with patch.object(server, "db", db):
            _run(MIGRATION_FN())

        db.alerts.update_one.assert_called_once()
        filter_doc, update_doc = db.alerts.update_one.call_args[0]
        assert filter_doc == {"_id": "mongo-oid-001"}
        assert update_doc == {"$set": {"member_phone": MEMBER_PHONE}}

    def test_sentinel_written_after_backfill(self):
        db = _make_db(alerts=[ALERT_NO_PHONE], member_phone=MEMBER_PHONE)
        with patch.object(server, "db", db):
            _run(MIGRATION_FN())

        db.migrations.update_one.assert_called_once()
        _, sentinel_doc = db.migrations.update_one.call_args[0]
        assert sentinel_doc["$set"]["_id"] == "alerts_phone_backfill_v48"
        assert "run_at" in sentinel_doc["$set"]

    def test_frontend_guard_satisfied_after_backfill(self):
        """After the migration the alert doc would pass type==='low_battery' && !!member_phone."""
        db = _make_db(alerts=[ALERT_NO_PHONE], member_phone=MEMBER_PHONE)
        with patch.object(server, "db", db):
            _run(MIGRATION_FN())

        # Reconstruct what the updated alert looks like in memory
        _, update_doc = db.alerts.update_one.call_args[0]
        patched_phone = update_doc["$set"]["member_phone"]

        # Mirror of the frontend guard: type === 'low_battery' && !!member_phone
        would_show_call_button = (
            ALERT_NO_PHONE["type"] == "low_battery" and bool(patched_phone)
        )
        assert would_show_call_button is True, (
            f"Call button guard failed after backfill: type={ALERT_NO_PHONE['type']!r}, "
            f"member_phone={patched_phone!r}"
        )


# ── Test 2: empty-string member_phone also gets backfilled ──────────────────

class TestBackfillsAlertWithEmptyPhone:
    """An alert with member_phone='' must also be updated by the migration."""

    def test_empty_string_phone_gets_backfilled(self):
        db = _make_db(alerts=[ALERT_EMPTY_PHONE], member_phone=MEMBER_PHONE)
        with patch.object(server, "db", db):
            _run(MIGRATION_FN())

        db.alerts.update_one.assert_called_once()
        _, update_doc = db.alerts.update_one.call_args[0]
        assert update_doc["$set"]["member_phone"] == MEMBER_PHONE

    def test_frontend_guard_satisfied_after_empty_phone_backfill(self):
        db = _make_db(alerts=[ALERT_EMPTY_PHONE], member_phone=MEMBER_PHONE)
        with patch.object(server, "db", db):
            _run(MIGRATION_FN())

        _, update_doc = db.alerts.update_one.call_args[0]
        patched_phone = update_doc["$set"]["member_phone"]
        would_show_call_button = (
            ALERT_EMPTY_PHONE["type"] == "low_battery" and bool(patched_phone)
        )
        assert would_show_call_button is True


# ── Test 3: member has no phone → alert must not be updated ─────────────────

class TestSkipsAlertWhenMemberHasNoPhone:
    """If the member document has no phone, update_one must not be called — there's
    nothing to backfill, and the Call button should remain hidden."""

    def test_update_one_not_called_when_member_has_no_phone(self):
        db = _make_db(alerts=[ALERT_NO_PHONE], member_phone=None, member_exists=True)
        with patch.object(server, "db", db):
            _run(MIGRATION_FN())

        db.alerts.update_one.assert_not_called()

    def test_sentinel_still_written_even_when_no_updates(self):
        """Migration must persist its sentinel even if no alerts needed patching."""
        db = _make_db(alerts=[ALERT_NO_PHONE], member_phone=None, member_exists=True)
        with patch.object(server, "db", db):
            _run(MIGRATION_FN())

        db.migrations.update_one.assert_called_once()


# ── Test 4: member doc missing → alert skipped gracefully ───────────────────

class TestSkipsAlertWhenMemberNotFound:
    """If the family_members doc for an alert's member_id is gone, the alert
    must be skipped without crashing."""

    def test_update_one_not_called_when_member_missing(self):
        db = _make_db(alerts=[ALERT_NO_PHONE], member_phone=None, member_exists=False)
        with patch.object(server, "db", db):
            _run(MIGRATION_FN())

        db.alerts.update_one.assert_not_called()

    def test_migration_completes_without_exception_when_member_missing(self):
        db = _make_db(alerts=[ALERT_NO_PHONE], member_phone=None, member_exists=False)
        with patch.object(server, "db", db):
            # Must not raise
            _run(MIGRATION_FN())


# ── Test 5: idempotency — sentinel already present means no-op ──────────────

class TestMigrationIdempotency:
    """Once the sentinel doc exists, re-running the migration must be a no-op:
    no alerts queried, no updates written."""

    def test_no_db_writes_when_sentinel_exists(self):
        db = _make_db(alerts=[ALERT_NO_PHONE], member_phone=MEMBER_PHONE, sentinel_exists=True)
        with patch.object(server, "db", db):
            _run(MIGRATION_FN())

        # find() must never have been called on alerts
        db.alerts.find.assert_not_called()
        db.alerts.update_one.assert_not_called()
        # sentinel doc must not be re-written
        db.migrations.update_one.assert_not_called()


# ── Test 6: multiple alerts in one pass ─────────────────────────────────────

class TestMultipleAlertsBackfilled:
    """The migration must iterate over all matching alerts in one sweep."""

    def test_all_phoneless_alerts_are_updated(self):
        alert_a = {**ALERT_NO_PHONE, "_id": "oid-a", "id": "uuid-a", "member_id": "member-001"}
        alert_b = {**ALERT_NO_PHONE, "_id": "oid-b", "id": "uuid-b", "member_id": "member-001"}

        db = _make_db(alerts=[alert_a, alert_b], member_phone=MEMBER_PHONE)
        with patch.object(server, "db", db):
            _run(MIGRATION_FN())

        assert db.alerts.update_one.call_count == 2, (
            f"Expected 2 update_one calls, got {db.alerts.update_one.call_count}"
        )

    def test_frontend_guard_satisfied_for_all_backfilled_rows(self):
        alert_a = {**ALERT_NO_PHONE, "_id": "oid-a", "id": "uuid-a", "member_id": "member-001"}
        alert_b = {**ALERT_NO_PHONE, "_id": "oid-b", "id": "uuid-b", "member_id": "member-001"}

        db = _make_db(alerts=[alert_a, alert_b], member_phone=MEMBER_PHONE)
        with patch.object(server, "db", db):
            _run(MIGRATION_FN())

        for c in db.alerts.update_one.call_args_list:
            _, update_doc = c[0]
            patched_phone = update_doc["$set"]["member_phone"]
            assert bool(patched_phone), (
                f"Backfilled member_phone is falsy: {patched_phone!r}"
            )
            # Mirror of the frontend guard
            assert alert_a["type"] == "low_battery" and bool(patched_phone)
