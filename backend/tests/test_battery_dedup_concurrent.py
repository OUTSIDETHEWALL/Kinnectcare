"""
test_battery_dedup_concurrent.py — Regression test for the concurrent
duplicate-push guard in check_low_battery().

Task #43: Confirm caregivers can't receive two 'battery low' pushes when
both upload paths (PUT /members/{id}/location and PATCH /members/{id}/battery)
fire at the same moment for the same member.

Mechanism under test
---------------------
check_low_battery() inserts an alert document into db.alerts.  A partial
unique index on (family_group_id, member_id) scoped to
{type: "low_battery", resolved: false} ensures that only the FIRST
concurrent insert succeeds; every subsequent concurrent insert raises a
DuplicateKeyError.  check_low_battery() catches DuplicateKeyError and
returns {"low_battery_alerted": True} WITHOUT sending a push, so caregivers
receive exactly one notification regardless of how many upload paths race.

These tests reproduce that race by:
  1. Patching db.alerts.insert_one so the first call succeeds and every
     subsequent call raises DuplicateKeyError (mimicking the MongoDB index).
  2. Running two check_low_battery() coroutines with asyncio.gather() so
     they interleave on the event loop.
  3. Asserting db.alerts.insert_one was called twice (both paths tried) but
     push_to_family_group was called exactly once (only the winner pushed).

All tests are offline — no live MongoDB or Expo push service required.
"""

import asyncio
import os
import sys
import pytest
from unittest.mock import AsyncMock, MagicMock, patch, call
from pymongo.errors import DuplicateKeyError as MongoDupKeyError

# ── bootstrap ─────────────────────────────────────────────────────────────────
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

# ── constants ──────────────────────────────────────────────────────────────────

MEMBER_ID       = "test-member-dedup-001"
FAMILY_GROUP_ID = "test-fg-dedup-001"
OWNER_ID        = "test-owner-dedup-001"

_LOW_BATTERY    = 0.10   # well below the 0.15 trigger threshold


# ── helpers ───────────────────────────────────────────────────────────────────

def _make_prev_doc(*, was_alerted: bool = False, name: str = "Joyce") -> dict:
    # When critical fired (was_alerted=True), warn was also set — mirror real state.
    return {
        "low_battery_alerted":      was_alerted,
        "low_battery_warn_alerted": was_alerted,
        "name":                     name,
    }


def _make_coro():
    """Return a coroutine that calls check_low_battery() with a low battery."""
    return server.check_low_battery(
        member_id=MEMBER_ID,
        family_group_id=FAMILY_GROUP_ID,
        owner_id=OWNER_ID,
        exclude_user_id=OWNER_ID,
        battery_level=_LOW_BATTERY,
        prev_doc=_make_prev_doc(was_alerted=False),
    )


def _run_concurrent(*coros):
    """Run a set of coroutines concurrently and return their results."""
    return asyncio.get_event_loop().run_until_complete(asyncio.gather(*coros))


# ── fixtures ──────────────────────────────────────────────────────────────────

def _make_db_mock(*, second_insert_raises: bool = True):
    """Return a mock db where the second insert_one raises DuplicateKeyError.

    Uses AsyncMock(side_effect=...) so call_count is available for assertions.
    """
    m = MagicMock()

    insert_call_count = {"n": 0}

    def _insert_side_effect(doc):
        insert_call_count["n"] += 1
        if second_insert_raises and insert_call_count["n"] > 1:
            # Simulate the partial unique index on the second concurrent insert
            raise MongoDupKeyError(
                "E11000 duplicate key error collection: kinnship.alerts "
                "index: uniq_active_low_battery_per_member dup key: "
                f"{{ family_group_id: '{FAMILY_GROUP_ID}', member_id: '{MEMBER_ID}' }}"
            )
        # First insert succeeds (return value unused by check_low_battery)
        return MagicMock()

    m.alerts.insert_one       = AsyncMock(side_effect=_insert_side_effect)
    m.alerts.update_one       = AsyncMock()
    m.alerts.update_many      = AsyncMock()
    m.alerts.find_one_and_update = AsyncMock(return_value={"_id": "alert-id-001"})
    m.members.update_one      = AsyncMock()
    return m


# ── TestConcurrentDedup ───────────────────────────────────────────────────────

class TestConcurrentDedup:
    """
    Both upload paths fire simultaneously.  The partial unique index lets
    only one insert succeed; the other must catch DuplicateKeyError and
    skip the push.
    """

    def test_insert_attempted_twice(self):
        """Both paths reach insert_one — confirming neither short-circuits early."""
        mock_db = _make_db_mock()
        push_mock = AsyncMock(return_value=0)
        with patch.object(server, "db", mock_db), \
             patch.object(server, "push_to_family_group", push_mock):
            results = _run_concurrent(_make_coro(), _make_coro())

        assert mock_db.alerts.insert_one.call_count == 2, (
            "Both upload paths must attempt the insert so the index can arbitrate "
            f"(got {mock_db.alerts.insert_one.call_count} calls)"
        )

    def test_exactly_one_push_sent(self):
        """Only the winner of the DB race sends a push; the loser is silenced."""
        mock_db = _make_db_mock()
        push_mock = AsyncMock(return_value=0)
        with patch.object(server, "db", mock_db), \
             patch.object(server, "push_to_family_group", push_mock):
            _run_concurrent(_make_coro(), _make_coro())

        assert push_mock.call_count == 1, (
            f"Expected exactly 1 push notification, got {push_mock.call_count}. "
            "Caregivers would receive duplicate 'battery low' alerts."
        )

    def test_both_results_flag_true(self):
        """Both paths must return low_battery_alerted=True so both callers
        mark the member document correctly regardless of who won the race."""
        mock_db = _make_db_mock()
        push_mock = AsyncMock(return_value=0)
        with patch.object(server, "db", mock_db), \
             patch.object(server, "push_to_family_group", push_mock):
            results = _run_concurrent(_make_coro(), _make_coro())

        expected = {"low_battery_alerted": True, "low_battery_warn_alerted": True}
        for i, result in enumerate(results):
            assert result == expected, (
                f"Path {i} returned {result!r} instead of "
                f"{expected!r} — the member document would not be updated correctly."
            )

    def test_exactly_one_alert_in_db(self):
        """Exactly one alert insert succeeds — db.alerts ends up with one doc."""
        # Track successful inserts separately so we can count them
        successful_inserts = []
        insert_call_count = {"n": 0}

        async def _controlled_insert(doc):
            insert_call_count["n"] += 1
            if insert_call_count["n"] > 1:
                raise MongoDupKeyError(
                    "E11000 duplicate key error "
                    "index: uniq_active_low_battery_per_member"
                )
            successful_inserts.append(doc)
            return MagicMock()

        mock_db = MagicMock()
        mock_db.alerts.insert_one = _controlled_insert
        mock_db.alerts.update_one = AsyncMock()
        mock_db.members.update_one = AsyncMock()

        push_mock = AsyncMock(return_value=0)
        with patch.object(server, "db", mock_db), \
             patch.object(server, "push_to_family_group", push_mock):
            _run_concurrent(_make_coro(), _make_coro())

        assert len(successful_inserts) == 1, (
            f"Expected 1 successful alert insert, got {len(successful_inserts)}."
        )
        alert_doc = successful_inserts[0]
        assert alert_doc["type"] == "low_battery"
        assert alert_doc["member_id"] == MEMBER_ID
        assert alert_doc["family_group_id"] == FAMILY_GROUP_ID
        assert alert_doc["resolved"] is False

    def test_push_payload_correct(self):
        """The single push that fires must carry the correct type and member_id."""
        mock_db = _make_db_mock()
        push_mock = AsyncMock(return_value=0)
        with patch.object(server, "db", mock_db), \
             patch.object(server, "push_to_family_group", push_mock):
            _run_concurrent(_make_coro(), _make_coro())

        kwargs = push_mock.call_args[1]
        data = kwargs.get("data", {})
        assert data["type"] == "low_battery", (
            f"Expected data.type='low_battery', got {data.get('type')!r}"
        )
        assert data["member_id"] == MEMBER_ID, (
            f"Expected data.member_id='{MEMBER_ID}', got {data.get('member_id')!r}"
        )
        assert "alert_id" in data, "Push data must include alert_id for deep-link routing"

    def test_push_excludes_owner(self):
        """The push must exclude the member's own device (avoid self-notification)."""
        mock_db = _make_db_mock()
        push_mock = AsyncMock(return_value=0)
        with patch.object(server, "db", mock_db), \
             patch.object(server, "push_to_family_group", push_mock):
            _run_concurrent(_make_coro(), _make_coro())

        kwargs = push_mock.call_args[1]
        assert kwargs.get("exclude_user_id") == OWNER_ID


# ── TestIndexEnsured ──────────────────────────────────────────────────────────

class TestIndexEnsured:
    """
    Verify that _ensure_alert_dedup_index() creates the correct partial
    unique index on db.alerts so the guard is present at runtime.
    """

    def test_dedup_index_creation_called(self):
        """startup handler must call db.alerts.create_index for the low-battery
        dedup index with the expected name and partial filter."""
        mock_db = MagicMock()
        mock_db.alerts.create_index = AsyncMock()
        mock_db.alerts.aggregate = MagicMock(
            return_value=_empty_async_gen()
        )

        asyncio.get_event_loop().run_until_complete(_run_startup(mock_db))

        # Find the low-battery dedup index call among potentially multiple calls
        calls_made = mock_db.alerts.create_index.call_args_list
        dedup_calls = [
            c for c in calls_made
            if c[1].get("name") == "uniq_active_low_battery_per_member"
        ]
        assert len(dedup_calls) == 1, (
            f"Expected exactly one create_index call for "
            f"'uniq_active_low_battery_per_member', found {len(dedup_calls)}. "
            f"All calls: {calls_made}"
        )

        index_call = dedup_calls[0]
        assert index_call[1]["unique"] is True
        pfe = index_call[1]["partialFilterExpression"]
        assert pfe.get("type") == "low_battery", (
            f"partialFilterExpression must restrict to type='low_battery'; got {pfe!r}"
        )
        assert pfe.get("resolved") is False, (
            f"partialFilterExpression must restrict to resolved=False; got {pfe!r}"
        )


# ── helpers for TestIndexEnsured ─────────────────────────────────────────────

async def _empty_async_gen():
    """Async generator that yields nothing — simulates no pre-existing duplicates."""
    return
    yield  # make it an async generator


async def _run_startup(mock_db):
    """Run _ensure_alert_dedup_index() with the given db mock."""
    with patch.object(server, "db", mock_db):
        await server._ensure_alert_dedup_index()


# ── TestSingleUploadPath ──────────────────────────────────────────────────────

class TestSingleUploadPath:
    """
    Baseline: a single upload path still triggers the alert and push
    normally.  Ensures the dedup guard doesn't break the happy path.
    """

    def test_single_path_creates_alert_and_push(self):
        mock_db = _make_db_mock(second_insert_raises=False)
        push_mock = AsyncMock(return_value=0)
        with patch.object(server, "db", mock_db), \
             patch.object(server, "push_to_family_group", push_mock):
            result = asyncio.get_event_loop().run_until_complete(_make_coro())

        assert result == {"low_battery_alerted": True, "low_battery_warn_alerted": True}
        assert mock_db.alerts.insert_one.call_count == 1
        assert push_mock.call_count == 1

    def test_already_alerted_no_duplicate(self):
        """If low_battery_alerted is already True, no insert or push fires."""
        mock_db = _make_db_mock(second_insert_raises=False)
        push_mock = AsyncMock(return_value=0)
        with patch.object(server, "db", mock_db), \
             patch.object(server, "push_to_family_group", push_mock):
            result = asyncio.get_event_loop().run_until_complete(
                server.check_low_battery(
                    member_id=MEMBER_ID,
                    family_group_id=FAMILY_GROUP_ID,
                    owner_id=OWNER_ID,
                    exclude_user_id=OWNER_ID,
                    battery_level=_LOW_BATTERY,
                    prev_doc=_make_prev_doc(was_alerted=True),
                )
            )

        assert result == {}
        assert mock_db.alerts.insert_one.call_count == 0
        assert push_mock.call_count == 0
