"""Adversarial sequences against the actual handler; exclusively in-memory DB."""
import asyncio
import copy
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch
import pytest
from test_coordinate_capture_integrity import server, run


def matches(query, doc):
    for key, wanted in query.items():
        if key == "$and":
            if not all(matches(q, doc) for q in wanted):
                return False
        elif key == "$or":
            if not any(matches(q, doc) for q in wanted):
                return False
        elif isinstance(wanted, dict):
            if "$exists" in wanted and (key in doc) != wanted["$exists"]:
                return False
            if "$lt" in wanted and not (doc.get(key) is not None and doc[key] < wanted["$lt"]):
                return False
        elif doc.get(key) != wanted:
            return False
    return True


@pytest.fixture
def harness():
    now = datetime.now(timezone.utc)
    doc = dict(id="member", user_id="user", owner_id="user", family_group_id="family",
               name="Test", age=70, phone="", gender="", role="senior", status="healthy",
               location_sharing_enabled=True, location_consent_generation=1)
    db = MagicMock()
    db.users.find_one = AsyncMock(return_value={"location_sharing_enabled": True})
    db.members.find_one = AsyncMock(side_effect=lambda *a, **k: copy.deepcopy(doc))
    inject = [None]

    async def update(query, mutation):
        if "latitude" in mutation.get("$set", {}) and inject[0]:
            callback, inject[0] = inject[0], None
            callback(doc)
        accepted = matches(query, doc)
        if accepted:
            doc.update(mutation.get("$set", {}))
        return MagicMock(matched_count=int(accepted), modified_count=int(accepted))

    db.members.update_one = AsyncMock(side_effect=update)
    db.location_ingest_log.insert_one = AsyncMock()
    db.location_history.insert_one = AsyncMock()

    async def put(t, latitude=3, generation=1):
        data = dict(latitude=latitude, longitude=4)
        if t is not None:
            data["timestamp"] = t.isoformat()
        if generation is not None:
            data["consent_generation"] = generation
        return await server.update_member_location("member", server.LocationUpdate(**data),
            dict(id="user", family_group_id="family", family_group_role="member"))

    with patch.object(server, "db", db), patch.object(server, "stamp_device_presence", AsyncMock()), \
            patch.object(server.geocoding, "GEOCODE_BACKEND_ENABLED", True):
        yield now, doc, put, inject, db


@pytest.mark.parametrize("following", ["replay", "older", "newer"])
def test_verified_undated_following_publication(harness, following):
    now, doc, put, _, _ = harness

    async def scenario():
        assert (await put(now)).location_write_accepted
        tuple_before = (doc["latitude"], doc["longitude"], doc["coordinate_captured_at"])
        unknown = await put(None, latitude=99)
        assert not unknown.location_write_accepted
        assert unknown.location_write_rejection_reason == "capture_time_unknown"
        assert (doc["latitude"], doc["longitude"], doc["coordinate_captured_at"]) == tuple_before
        next_time = now + timedelta(seconds=1 if following == "newer" else -1 if following == "older" else 0)
        result = await put(next_time, latitude=5)
        assert result.location_write_accepted is (following == "newer")
        assert doc["coordinate_captured_at"] == (next_time if following == "newer" else now)
        assert doc["latitude"] == (5 if following == "newer" else 3)
    run(scenario())


@pytest.mark.parametrize("race,reason", [
    ({"location_sharing_enabled": False, "location_consent_generation": 2}, "sharing_disabled"),
    ({"location_consent_generation": 2}, "consent_changed"),
    ({"user_id": "replacement"}, "owner_changed"),
])
def test_atomic_publication_cannot_cross_policy_or_owner_replacement(harness, race, reason):
    now, doc, put, inject, _ = harness

    async def scenario():
        assert (await put(now)).location_write_accepted
        before = doc["coordinate_captured_at"]
        inject[0] = lambda d: d.update(race)
        result = await put(now + timedelta(seconds=1), latitude=99)
        assert not result.location_write_accepted
        assert result.location_write_rejection_reason == reason
        assert doc["coordinate_captured_at"] == before
        assert doc["latitude"] == 3
    run(scenario())


def test_off_on_before_request_admission_does_not_revive_client_lifetime(harness):
    now, doc, put, _, _ = harness
    doc["location_consent_generation"] = 3
    result = run(put(now, generation=1))
    assert not result.location_write_accepted
    assert result.location_write_rejection_reason == "consent_changed"
    assert "latitude" not in doc


def test_omitted_generation_cannot_adopt_current_consent_lifetime(harness):
    now, doc, put, _, _ = harness
    doc["location_consent_generation"] = 4
    rejected = run(put(now, generation=None))
    assert rejected.location_write_accepted is False
    assert rejected.location_write_rejection_reason == "consent_changed"
    accepted = run(put(now, generation=4))
    assert accepted.location_write_accepted is True
    assert accepted.location_write_consent_generation == 4


def test_native_extras_are_acquisition_provenance_not_current_server_defaults(harness):
    now, doc, _, _, _ = harness
    doc["location_consent_generation"] = 4
    data = server.LocationUpdate.model_validate({
        "coords": {"latitude": 3, "longitude": 4},
        "timestamp": now.isoformat(), "uuid": "native-fix",
        "extras": {"consent_generation": 4},
    })
    assert data.consent_generation == 4
    result = run(server.update_member_location("member", data,
        dict(id="user", family_group_id="family", family_group_role="member")))
    assert result.location_write_accepted is True
    assert result.location_write_capture_uuid == "native-fix"
    assert result.location_write_captured_at == now
    assert result.location_write_consent_generation == 4


def test_out_of_order_and_undated_concurrent_publications(harness):
    now, doc, put, _, _ = harness

    async def scenario():
        await put(now)
        await asyncio.gather(put(now + timedelta(seconds=2), latitude=5),
            put(None, latitude=99), put(now + timedelta(seconds=1), latitude=6))
        assert doc["latitude"] == 5
        assert doc["coordinate_captured_at"] == now + timedelta(seconds=2)
        assert doc["captured_at"] == doc["coordinate_captured_at"]
    run(scenario())


def test_unknown_write_still_accepts_independent_battery_and_presence(harness):
    now, doc, put, _, db = harness

    async def scenario():
        await put(now)
        with patch.object(server, "_accept_battery_telemetry", AsyncMock(return_value=(False, None))) as battery:
            result = await server.update_member_location("member", server.LocationUpdate(
                latitude=99, longitude=99, battery_level=.8),
                dict(id="user", family_group_id="family", family_group_role="member"))
        assert battery.await_count == 1
        assert not result.location_write_accepted
        assert doc["latitude"] == 3
        assert doc["last_seen"] >= now
    run(scenario())
