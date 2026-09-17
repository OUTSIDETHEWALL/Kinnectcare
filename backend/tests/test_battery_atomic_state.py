"""Stateful race coverage for the shared battery write/lifecycle machine."""

import asyncio
import copy
import os
import sys
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from pymongo.errors import DuplicateKeyError

for _key, _value in {
    "MONGO_URL": "mongodb://localhost:27017",
    "DB_NAME": "kinnship_test",
    "JWT_SECRET": "test-suite-only-signing-secret-that-is-long-enough",
}.items():
    os.environ.setdefault(_key, _value)

with patch("motor.motor_asyncio.AsyncIOMotorClient", MagicMock()):
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
    import server  # noqa: E402


MEMBER_ID = "atomic-battery-member"
FAMILY_ID = "atomic-battery-family"
OWNER_ID = "atomic-battery-owner"


def _matches(document, filter_doc):
    for key, expected in filter_doc.items():
        if key == "$or":
            if not any(_matches(document, branch) for branch in expected):
                return False
        elif isinstance(expected, dict) and "$exists" in expected:
            if (key in document) != expected["$exists"]:
                return False
        elif isinstance(expected, dict) and "$ne" in expected:
            if document.get(key) == expected["$ne"]:
                return False
        elif isinstance(expected, dict) and "$lt" in expected:
            if key not in document or not document[key] < expected["$lt"]:
                return False
        elif isinstance(expected, dict) and "$in" in expected:
            if document.get(key) not in expected["$in"]:
                return False
        elif document.get(key) != expected:
            return False
    return True


class _StatefulMembers:
    """A tiny atomic Mongo fake: each returned document is the next state."""

    def __init__(self, document, claim_barrier=None):
        self.document = document
        self.claim_barrier = claim_barrier
        self._lock = asyncio.Lock()

    async def find_one_and_update(self, filter_doc, update_doc, **_kwargs):
        # Hold both contenders at the member claim to exercise Mongo's
        # conditional-update election rather than scheduling luck.
        if (
            self.claim_barrier is not None
            and update_doc.get("$set", {}).get("battery_recovery_claimed") is True
        ):
            await self.claim_barrier.wait()
        async with self._lock:
            if not _matches(self.document, filter_doc):
                return None
            self.document.update(update_doc.get("$set", {}))
            if "battery_updated_at" in update_doc.get("$set", {}):
                self.document["battery_updated_at"] = (
                    self.document["battery_updated_at"].replace(
                        microsecond=(
                            self.document["battery_updated_at"].microsecond // 1000
                        )
                        * 1000
                    )
                )
            return copy.deepcopy(self.document)


class _StatefulAlerts:
    def __init__(self):
        self.documents = []
        self._lock = asyncio.Lock()

    async def find_one(self, filter_doc):
        async with self._lock:
            for document in self.documents:
                if _matches(document, filter_doc):
                    return copy.deepcopy(document)
        return None

    async def insert_one(self, document):
        async with self._lock:
            if any(
                existing["member_id"] == document["member_id"]
                and existing["family_group_id"] == document["family_group_id"]
                and existing["type"] == document["type"]
                and existing.get("resolved") is not True
                for existing in self.documents
            ):
                raise DuplicateKeyError("battery tier already active")
            self.documents.append(copy.deepcopy(document))

    async def find_one_and_update(self, filter_doc, update_doc, **_kwargs):
        async with self._lock:
            for document in self.documents:
                if _matches(document, filter_doc):
                    document.update(update_doc.get("$set", {}))
                    return copy.deepcopy(document)
        return None

    async def update_many(self, filter_doc, update_doc):
        async with self._lock:
            for document in self.documents:
                if _matches(document, filter_doc):
                    document.update(update_doc.get("$set", {}))


class _StatefulDb:
    def __init__(self, document, claim_barrier=None):
        self.members = _StatefulMembers(document, claim_barrier)
        self.alerts = _StatefulAlerts()


def _run(coro):
    try:
        return asyncio.run(coro)
    finally:
        # Keep a current loop for the repository's legacy synchronous tests,
        # which intentionally use get_event_loop().run_until_complete().
        asyncio.set_event_loop(asyncio.new_event_loop())


def _run_gather(*coros):
    async def _gather():
        return await asyncio.gather(*coros)

    return _run(_gather())


def _base_document(**overrides):
    document = {
        "id": MEMBER_ID,
        "family_group_id": FAMILY_ID,
        "name": "Atomic Member",
        "phone": "+15550000000",
    }
    document.update(overrides)
    return document


async def _accepted_reading(db, level, charging, timestamp):
    timestamp = server._normalize_battery_timestamp(timestamp)
    accepted, document = await server._accept_battery_telemetry(
        member_id=MEMBER_ID,
        family_group_id=FAMILY_ID,
        battery_level=level,
        is_charging=charging,
        incoming_ts=timestamp,
    )
    if accepted:
        await server.check_low_battery(
            member_id=MEMBER_ID,
            family_group_id=FAMILY_ID,
            owner_id=OWNER_ID,
            exclude_user_id=OWNER_ID,
            battery_level=level,
            is_charging=charging,
            prev_doc=document,
            battery_updated_at=timestamp,
        )
    return accepted, document


def test_warning_escalates_same_row_then_concurrent_charging_claims_one_recovery():
    database = _StatefulDb(_base_document(), claim_barrier=asyncio.Barrier(2))
    push = AsyncMock()
    base = server._normalize_battery_timestamp(datetime.now(timezone.utc))
    with patch.object(server, "db", database), patch.object(
        server, "push_to_family_group", push
    ):
        _run(_accepted_reading(database, 0.20, False, base + timedelta(seconds=1)))
        _run(_accepted_reading(database, 0.15, False, base + timedelta(seconds=2)))

        first_ok, first_doc = _run(server._accept_battery_telemetry(
            member_id=MEMBER_ID,
            family_group_id=FAMILY_ID,
            battery_level=0.15,
            is_charging=True,
            incoming_ts=base + timedelta(seconds=3),
        ))
        second_ok, second_doc = _run(server._accept_battery_telemetry(
            member_id=MEMBER_ID,
            family_group_id=FAMILY_ID,
            battery_level=0.15,
            is_charging=True,
            incoming_ts=base + timedelta(seconds=4),
        ))
        assert first_ok and second_ok
        _run_gather(
            server.check_low_battery(
                member_id=MEMBER_ID, family_group_id=FAMILY_ID,
                owner_id=OWNER_ID, exclude_user_id=OWNER_ID,
                battery_level=0.15, is_charging=True, prev_doc=first_doc,
                battery_updated_at=base + timedelta(seconds=3),
            ),
            server.check_low_battery(
                member_id=MEMBER_ID, family_group_id=FAMILY_ID,
                owner_id=OWNER_ID, exclude_user_id=OWNER_ID,
                battery_level=0.15, is_charging=True, prev_doc=second_doc,
                battery_updated_at=base + timedelta(seconds=4),
            ),
        )

    assert len(database.alerts.documents) == 1
    assert database.alerts.documents[0]["type"] == "low_battery"
    assert database.alerts.documents[0]["battery_stage"] == "critical"
    assert all(row["resolved"] is True for row in database.alerts.documents)
    assert [call.kwargs["data"]["type"] for call in push.call_args_list] == [
        "low_battery_warning",
        "low_battery",
        "battery_recovered",
    ]


def test_accepted_old_reading_cannot_claim_after_newer_reading_wins():
    database = _StatefulDb(_base_document())
    push = AsyncMock()
    base = server._normalize_battery_timestamp(datetime.now(timezone.utc))
    with patch.object(server, "db", database), patch.object(
        server, "push_to_family_group", push
    ):
        old_ok, old_doc = _run(server._accept_battery_telemetry(
            member_id=MEMBER_ID, family_group_id=FAMILY_ID,
            battery_level=0.15, is_charging=False,
            incoming_ts=base + timedelta(seconds=1),
        ))
        new_ok, _ = _run(_accepted_reading(
            database, 0.80, False, base + timedelta(seconds=2)
        ))
        assert old_ok and new_ok
        _run(server.check_low_battery(
            member_id=MEMBER_ID, family_group_id=FAMILY_ID,
            owner_id=OWNER_ID, exclude_user_id=OWNER_ID,
            battery_level=0.15, is_charging=False, prev_doc=old_doc,
            battery_updated_at=base + timedelta(seconds=1),
        ))

    assert database.alerts.documents == []
    push.assert_not_called()


def test_bson_millisecond_timestamp_is_used_for_acceptance_and_claim():
    database = _StatefulDb(_base_document())
    push = AsyncMock()
    raw_timestamp = datetime.now(timezone.utc).replace(microsecond=123456)
    normalized = server._normalize_battery_timestamp(raw_timestamp)
    with patch.object(server, "db", database), patch.object(
        server, "push_to_family_group", push
    ):
        accepted, document = _run(server._accept_battery_telemetry(
            member_id=MEMBER_ID,
            family_group_id=FAMILY_ID,
            battery_level=0.20,
            is_charging=False,
            incoming_ts=raw_timestamp,
        ))
        assert accepted is True
        assert document["battery_updated_at"] == normalized
        _run(server.check_low_battery(
            member_id=MEMBER_ID,
            family_group_id=FAMILY_ID,
            owner_id=OWNER_ID,
            exclude_user_id=OWNER_ID,
            battery_level=0.20,
            is_charging=False,
            prev_doc=document,
            battery_updated_at=normalized,
        ))

    assert database.members.document["battery_updated_at"] == normalized
    assert database.alerts.documents[0]["type"] == "low_battery"
    assert database.alerts.documents[0]["battery_stage"] == "low"
    assert push.call_count == 1


def test_claimed_recovery_stays_quiet_until_real_clear_then_new_cycle_alerts():
    database = _StatefulDb(_base_document())
    push = AsyncMock()
    base = server._normalize_battery_timestamp(datetime.now(timezone.utc))
    with patch.object(server, "db", database), patch.object(
        server, "push_to_family_group", push
    ):
        # Initial critical alert, then charging below 25% resolves its row and
        # claims recovery for the cycle.
        _run(_accepted_reading(database, 0.15, False, base + timedelta(seconds=1)))
        _run(_accepted_reading(database, 0.15, True, base + timedelta(seconds=2)))
        assert database.members.document["battery_recovery_claimed"] is True
        assert len(database.alerts.documents) == 1

        # Unplug/replug and low readings remain a no-op.  In particular, the
        # resolved critical row is never repaired and no push is repeated.
        for offset, level, charging in (
            (3, 0.15, False),
            (4, 0.17, True),
            (5, 0.17, False),
            (6, 0.18, False),
            (7, 0.18, True),
        ):
            _run(_accepted_reading(
                database, level, charging, base + timedelta(seconds=offset)
            ))
        assert database.members.document["battery_recovery_claimed"] is True
        assert len(database.alerts.documents) == 1
        assert push.call_count == 2

        # Only a genuine >=25% reading ends the cycle.  The next low reading
        # can claim a fresh critical tier and reset recovery_claimed.
        _run(_accepted_reading(database, 0.25, False, base + timedelta(seconds=8)))
        assert database.members.document["battery_recovery_claimed"] is True
        assert database.members.document["low_battery_alerted"] is False
        _run(_accepted_reading(database, 0.15, False, base + timedelta(seconds=9)))

    assert len(database.alerts.documents) == 2
    assert push.call_count == 3
    assert [call.kwargs["data"]["type"] for call in push.call_args_list] == [
        "low_battery",
        "battery_recovered",
        "low_battery",
    ]


def test_cycle_boundary_clears_warning_claim_before_direct_critical_cycle():
    database = _StatefulDb(_base_document())
    push = AsyncMock()
    base = server._normalize_battery_timestamp(datetime.now(timezone.utc))
    with patch.object(server, "db", database), patch.object(
        server, "push_to_family_group", push
    ):
        # Cycle 1 genuinely claims the warning tier.
        _run(_accepted_reading(database, 0.20, False, base + timedelta(seconds=1)))
        assert database.members.document["battery_warning_claimed"] is True
        _run(_accepted_reading(database, 0.25, False, base + timedelta(seconds=2)))
        assert database.members.document["battery_warning_claimed"] is False

        # Cycle 2 starts directly at critical.  The rebound into 16–20% must
        # not repair cycle 1's warning row or send a retroactive warning push.
        _run(_accepted_reading(database, 0.15, False, base + timedelta(seconds=3)))
        _run(_accepted_reading(database, 0.18, False, base + timedelta(seconds=4)))

    assert [row["type"] for row in database.alerts.documents] == [
        "low_battery",
        "low_battery",
    ]
    assert [row["battery_stage"] for row in database.alerts.documents] == [
        "low",
        "critical",
    ]
    assert database.alerts.documents[0]["resolved"] is True
    assert database.alerts.documents[1]["resolved"] is False
    assert [call.kwargs["data"]["type"] for call in push.call_args_list] == [
        "low_battery_warning",
        "battery_recovered",
        "low_battery",
    ]


def test_concurrent_clear_and_older_low_only_newer_clear_wins():
    database = _StatefulDb(_base_document())
    push = AsyncMock()
    base = server._normalize_battery_timestamp(datetime.now(timezone.utc))
    with patch.object(server, "db", database), patch.object(
        server, "push_to_family_group", push
    ):
        _run(_accepted_reading(database, 0.20, False, base + timedelta(seconds=1)))
        low_ok, low_doc = _run(server._accept_battery_telemetry(
            member_id=MEMBER_ID, family_group_id=FAMILY_ID,
            battery_level=0.18, is_charging=False,
            incoming_ts=base + timedelta(seconds=2),
        ))
        clear_ok, clear_doc = _run(server._accept_battery_telemetry(
            member_id=MEMBER_ID, family_group_id=FAMILY_ID,
            battery_level=0.25, is_charging=False,
            incoming_ts=base + timedelta(seconds=3),
        ))
        assert low_ok and clear_ok
        _run_gather(
            server.check_low_battery(
                member_id=MEMBER_ID, family_group_id=FAMILY_ID,
                owner_id=OWNER_ID, exclude_user_id=OWNER_ID,
                battery_level=0.18, is_charging=False, prev_doc=low_doc,
                battery_updated_at=base + timedelta(seconds=2),
            ),
            server.check_low_battery(
                member_id=MEMBER_ID, family_group_id=FAMILY_ID,
                owner_id=OWNER_ID, exclude_user_id=OWNER_ID,
                battery_level=0.25, is_charging=False, prev_doc=clear_doc,
                battery_updated_at=base + timedelta(seconds=3),
            ),
        )

    assert database.members.document.get("low_battery_warn_alerted") is False
    assert database.members.document.get("low_battery_alerted") is False
    assert push.call_count == 2