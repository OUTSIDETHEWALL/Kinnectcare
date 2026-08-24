"""Task 107 — battery freshness while the monitored phone is stationary.

These tests cover the server half of the stationary/force-killed flow:
headless PATCH requests may omit a client timestamp and must receive a fresh
server timestamp, while an explicitly older replay must never overwrite the
newer battery state.
"""

import asyncio
import copy
import os
import sys
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


for _key, _value in {
    "MONGO_URL": "mongodb://localhost:27017",
    "DB_NAME": "kinnship_test",
    "JWT_SECRET": "test-secret",
}.items():
    os.environ.setdefault(_key, _value)

with patch("motor.motor_asyncio.AsyncIOMotorClient", MagicMock()):
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
    import server  # noqa: E402


MEMBER_ID = "task-107-joyce"
FAMILY_GROUP_ID = "task-107-family"
OWNER_ID = "task-107-owner"


def _member_doc(**overrides):
    document = {
        "id": MEMBER_ID,
        "owner_id": OWNER_ID,
        "family_group_id": FAMILY_GROUP_ID,
        "user_id": "joyce-user",
        "name": "Joyce",
        "age": 78,
        "phone": "+15550001234",
        "gender": "female",
        "role": "senior",
        "status": "healthy",
        "last_seen": datetime.now(timezone.utc),
        "created_at": datetime.now(timezone.utc),
        "battery_level": 0.70,
        "is_charging": False,
        "battery_updated_at": datetime.now(timezone.utc) - timedelta(minutes=20),
    }
    document.update(overrides)
    return document


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def test_headless_patch_without_client_timestamp_advances_battery_timestamp():
    """A force-killed/headless caller can keep battery_updated_at fresh."""
    before = datetime.now(timezone.utc)
    member = _member_doc()
    database = MagicMock()
    database.members.find_one = AsyncMock(side_effect=[
        copy.deepcopy(member),
        {**member, "battery_level": 0.82, "is_charging": False},
    ])
    database.members.update_one = AsyncMock()

    current = {"id": OWNER_ID, "family_group_id": FAMILY_GROUP_ID}
    with patch.object(server, "db", database), patch.object(
        server, "check_low_battery", AsyncMock(return_value={})
    ):
        result = _run(
            server.patch_member_battery(
                MEMBER_ID,
                server.BatteryUpdate(battery_level=0.82, is_charging=False),
                current,
            )
        )

    update = database.members.update_one.call_args.args[1]["$set"]
    assert update["battery_level"] == 0.82
    assert update["is_charging"] is False
    assert update["battery_updated_at"] >= before
    assert result.battery_level == 0.82


def test_old_replay_cannot_hide_newer_stationary_battery_state():
    """An out-of-order upload must not replace the fresh headless reading."""
    stored_at = datetime.now(timezone.utc) - timedelta(minutes=3)
    old_capture = stored_at - timedelta(minutes=20)
    member = _member_doc(
        battery_level=0.82,
        is_charging=True,
        battery_updated_at=stored_at,
    )
    database = MagicMock()
    database.members.find_one = AsyncMock(return_value=copy.deepcopy(member))
    database.members.update_one = AsyncMock()
    current = {"id": OWNER_ID, "family_group_id": FAMILY_GROUP_ID}

    with patch.object(server, "db", database), patch.object(
        server, "check_low_battery", AsyncMock()
    ):
        result = _run(
            server.patch_member_battery(
                MEMBER_ID,
                server.BatteryUpdate(
                    battery_level=0.18,
                    is_charging=False,
                    battery_updated_at=old_capture,
                ),
                current,
            )
        )

    database.members.update_one.assert_not_called()
    assert result.battery_level == 0.82
    assert result.is_charging is True
    assert result.battery_updated_at == stored_at