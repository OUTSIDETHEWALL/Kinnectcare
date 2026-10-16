"""Offline endpoint tests: no HTTP service or real MongoDB is contacted."""
import asyncio
import copy
import os
import sys
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "kinnship_test")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
with patch("motor.motor_asyncio.AsyncIOMotorClient", MagicMock()):
    import server


def run(coro):
    with asyncio.Runner(loop_factory=asyncio.new_event_loop) as runner:
        return runner.run(coro)


@pytest.mark.parametrize("kind", ["fresh", "replay", "older", "missing", "future"])
def test_coordinate_timestamp_is_atomic_with_displayed_tuple(kind):
    now = datetime.now(timezone.utc)
    old = now - timedelta(hours=2)
    document = {
        "id": "member", "user_id": "user", "family_group_id": "family",
        "owner_id": "user", "name": "Test", "age": 70, "phone": "",
        "gender": "", "role": "senior", "status": "healthy",
        "latitude": 1.0, "longitude": 2.0, "captured_at": old,
        "coordinate_captured_at": old, "last_seen": old,
    }
    before = copy.deepcopy(document)
    captured = {
        "fresh": now, "replay": now - timedelta(minutes=10),
        "older": old - timedelta(minutes=1), "missing": None,
        "future": now + timedelta(hours=1),
    }[kind]
    db = MagicMock()
    db.users.find_one = AsyncMock(return_value={"location_sharing_enabled": True})
    db.members.find_one = AsyncMock(side_effect=lambda *a, **k: copy.deepcopy(document))

    async def update(query, mutation):
        candidate = mutation.get("$set", {})
        matched = True
        if "$or" in query:
            incoming = query["$or"][1]["captured_at"]["$lt"]
            matched = document["captured_at"] < incoming
        if matched:
            document.update(candidate)
        return MagicMock(matched_count=int(matched), modified_count=int(matched))

    db.members.update_one = AsyncMock(side_effect=update)
    db.location_ingest_log.insert_one = AsyncMock()
    db.location_history.insert_one = AsyncMock()
    data = {"latitude": 3.0, "longitude": 4.0}
    if captured is not None:
        data["timestamp"] = captured.isoformat()
    with patch.object(server, "db", db), patch.object(server, "stamp_device_presence", AsyncMock()), \
            patch.object(server.geocoding, "GEOCODE_BACKEND_ENABLED", True):
        result = run(server.update_member_location(
            "member", server.LocationUpdate(**data),
            {"id": "user", "family_group_id": "family", "family_group_role": "member"},
        ))
    if kind in ("replay", "older"):
        assert (document["latitude"], document["longitude"], document["coordinate_captured_at"]) == (
            before["latitude"], before["longitude"], before["coordinate_captured_at"],
        )
    elif kind in ("missing", "future"):
        assert document["latitude"] == 3.0
        assert document["coordinate_captured_at"] is None
    else:
        assert document["latitude"] == 3.0
        assert document["coordinate_captured_at"] == captured
        assert result.coordinate_captured_at == captured
    assert document["last_seen"] > old


def test_legacy_member_capture_time_is_explicitly_unknown():
    member = server.FamilyMember(
        id="member", owner_id="owner", name="Test", age=70,
        phone="", gender="", role="senior",
    )
    assert member.coordinate_captured_at is None
    assert member.model_dump(mode="json")["coordinate_captured_at"] is None
