"""Focused coverage for server-authoritative device presence."""

import asyncio
import copy
import os
import sys
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import Response
from fastapi import HTTPException
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


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _member(**overrides):
    doc = {
        "id": "member-1",
        "owner_id": "owner-1",
        "family_group_id": "family-1",
        "user_id": "user-1",
        "name": "Pat",
        "age": 70,
        "phone": "+15550000000",
        "gender": "other",
        "role": "senior",
        "last_seen": datetime.now(timezone.utc),
        "created_at": datetime.now(timezone.utc),
    }
    doc.update(overrides)
    return doc


def test_presence_uses_atomic_legacy_safe_self_targeted_update():
    database = MagicMock()
    database.members.update_one = AsyncMock(
        return_value=SimpleNamespace(modified_count=1)
    )
    with patch.object(server, "db", database):
        assert _run(server.stamp_device_presence(
            {"id": "user-1", "family_group_id": "family-1"}, "test"
        ))

    query, update = database.members.update_one.call_args.args
    assert query["user_id"] == "user-1"
    assert query["family_group_id"] == "family-1"
    assert {"device_presence_at": {"$exists": False}} in query["$or"]
    assert "device_presence_at" in update["$set"]


def test_legacy_member_without_presence_field_deserializes():
    member = server.FamilyMember(**_member())
    assert member.device_presence_at is None


def test_foreground_middleware_stamps_only_after_successful_authenticated_call():
    request = SimpleNamespace(
        headers={"X-Kinnship-Presence-Source": "foreground-api"},
        state=SimpleNamespace(current_user={"id": "user-1", "family_group_id": "family-1"}),
    )
    with patch.object(server, "stamp_device_presence", AsyncMock()) as stamp:
        _run(server.stamp_foreground_api_presence(
            request, AsyncMock(return_value=Response(status_code=204))
        ))
    stamp.assert_awaited_once_with(request.state.current_user, "foreground-api")


def test_foreground_middleware_does_not_stamp_failed_response():
    request = SimpleNamespace(
        headers={"X-Kinnship-Presence-Source": "foreground-api"},
        state=SimpleNamespace(current_user={"id": "user-1", "family_group_id": "family-1"}),
    )
    with patch.object(server, "stamp_device_presence", AsyncMock()) as stamp:
        _run(server.stamp_foreground_api_presence(
            request, AsyncMock(return_value=Response(status_code=401))
        ))
    stamp.assert_not_awaited()


def test_presence_atomic_predicate_deduplicates_recent_and_accepts_stale_rows():
    now = datetime.now(timezone.utc)
    recent = now - timedelta(minutes=4)
    stale = now - timedelta(minutes=6)
    # This verifies the predicate supplied to Mongo.  MongoDB, not this mock,
    # performs the concurrent conditional-update behavior in production.
    database = MagicMock()
    database.members.update_one = AsyncMock(
        side_effect=[
            SimpleNamespace(modified_count=0),
            SimpleNamespace(modified_count=1),
        ]
    )
    with patch.object(server, "db", database):
        assert not _run(server.stamp_device_presence(
            {"id": "user-1", "family_group_id": "family-1"}, "test"
        ))
        assert _run(server.stamp_device_presence(
            {"id": "user-1", "family_group_id": "family-1"}, "test"
        ))
    first_query = database.members.update_one.call_args_list[0].args[0]
    cutoff = next(
        clause["device_presence_at"]["$lt"]
        for clause in first_query["$or"]
        if isinstance(clause.get("device_presence_at"), dict)
        and "$lt" in clause["device_presence_at"]
    )
    expected_cutoff = now - timedelta(minutes=5)
    assert expected_cutoff <= cutoff <= expected_cutoff + timedelta(seconds=1)
    assert recent > cutoff
    assert stale < cutoff


def test_self_battery_patch_stamps_presence():
    member = _member(battery_level=0.5, is_charging=False)
    database = MagicMock()
    database.members.find_one = AsyncMock(side_effect=[
        copy.deepcopy(member), {**member, "battery_level": 0.6},
    ])
    database.members.update_one = AsyncMock()
    current = {"id": "user-1", "family_group_id": "family-1"}
    with patch.object(server, "db", database), \
         patch.object(server, "check_low_battery", AsyncMock(return_value={})), \
         patch.object(server, "stamp_device_presence", AsyncMock()) as stamp:
        _run(server.patch_member_battery(
            "member-1", server.BatteryUpdate(battery_level=0.6), current
        ))
    stamp.assert_awaited_once_with(current, "battery-patch")


def test_battery_and_snapshot_reject_caregiver_spoofing_other_member():
    database = MagicMock()
    database.members.find_one = AsyncMock(return_value=_member(user_id="senior-user"))
    caregiver = {"id": "caregiver-user", "family_group_id": "family-1"}
    with patch.object(server, "db", database):
        with pytest.raises(HTTPException, match="own member"):
            _run(server.patch_member_battery(
                "member-1", server.BatteryUpdate(battery_level=.6), caregiver
            ))
        with pytest.raises(HTTPException, match="own device snapshot"):
            _run(server.put_device_snapshot(
                "member-1", server.DeviceSnapshotUpdate(), caregiver
            ))
    database.members.update_one.assert_not_called()


def test_battery_response_is_reread_after_presence_stamp():
    before = _member(battery_level=.5)
    after = _member(
        battery_level=.6,
        device_presence_at=datetime.now(timezone.utc),
    )
    database = MagicMock()
    database.members.find_one = AsyncMock(side_effect=[before, after])
    database.members.update_one = AsyncMock()
    current = {"id": "user-1", "family_group_id": "family-1"}
    with patch.object(server, "db", database), \
         patch.object(server, "check_low_battery", AsyncMock(return_value={})), \
         patch.object(server, "stamp_device_presence", AsyncMock()):
        result = _run(server.patch_member_battery(
            "member-1", server.BatteryUpdate(battery_level=.6), current
        ))
    assert result.device_presence_at == after["device_presence_at"]


def test_privacy_suppressed_location_stamps_presence_without_location_mutation():
    original = _member(
        latitude=47.61,
        longitude=-122.33,
        location_name="Home",
        captured_at=datetime.now(timezone.utc) - timedelta(hours=1),
    )
    fresh = {**original, "device_presence_at": datetime.now(timezone.utc)}
    database = MagicMock()
    database.members.find_one = AsyncMock(side_effect=[
        {"id": "member-1", "user_id": "user-1"},
        fresh,
    ])
    database.users.find_one = AsyncMock(return_value={"location_sharing_enabled": False})
    database.members.update_one = AsyncMock()
    current = {"id": "user-1", "family_group_id": "family-1"}
    with patch.object(server, "db", database), \
         patch.object(server, "stamp_device_presence", AsyncMock()) as stamp:
        result = _run(server.update_member_location(
            "member-1",
            server.LocationUpdate(latitude=40.0, longitude=-73.0),
            current,
        ))
    stamp.assert_awaited_once_with(current, "location-upload")
    database.members.update_one.assert_not_called()
    assert result.latitude == original["latitude"]
    assert result.longitude == original["longitude"]
    assert result.captured_at == original["captured_at"]
    assert result.last_seen == original["last_seen"]
    assert result.device_presence_at == fresh["device_presence_at"]


def test_location_response_is_reread_after_presence_stamp():
    before = _member(latitude=1.0, longitude=2.0)
    written = _member(latitude=40.0, longitude=-73.0, location_name=None)
    fresh = {
        **written,
        "device_presence_at": datetime.now(timezone.utc),
    }
    database = MagicMock()
    database.members.find_one = AsyncMock(side_effect=[
        {"id": "member-1", "user_id": "user-1"},
        before,
        written,
        fresh,
    ])
    database.members.update_one = AsyncMock(
        return_value=SimpleNamespace(matched_count=1, modified_count=1)
    )
    database.users.find_one = AsyncMock(return_value={"location_sharing_enabled": True})
    database.location_ingest_log.insert_one = AsyncMock()
    database.location_history.insert_one = AsyncMock()
    current = {"id": "user-1", "family_group_id": "family-1"}
    with patch.object(server, "db", database), \
         patch.object(server.geocoding, "GEOCODE_BACKEND_ENABLED", True), \
         patch.object(server, "stamp_device_presence", AsyncMock()):
        result = _run(server.update_member_location(
            "member-1",
            server.LocationUpdate(latitude=40.0, longitude=-73.0),
            current,
        ))
    assert result.device_presence_at == fresh["device_presence_at"]


def test_foreground_members_list_includes_immediate_self_presence_only():
    self_member = _member(user_id="user-1")
    relative = _member(id="member-2", user_id="relative-user", name="Relative")
    cursor = MagicMock()
    cursor.to_list = AsyncMock(return_value=[self_member, relative])
    database = MagicMock()
    database.members.find.return_value = cursor
    stamped_at = datetime.now(timezone.utc)
    request = SimpleNamespace(
        headers={"X-Kinnship-Presence-Source": "foreground-api"},
    )
    current = {"id": "user-1", "family_group_id": "family-1"}
    with patch.object(server, "db", database), \
         patch.object(server, "stamp_device_presence", AsyncMock(return_value=stamped_at)):
        result = _run(server.list_members(current=current, request=request))
    assert result[0].device_presence_at == stamped_at
    assert result[1].device_presence_at is None