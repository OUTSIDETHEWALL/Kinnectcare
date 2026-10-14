"""Offline races through the real endpoints and a predicate-enforcing DB model."""
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
    # Do not disturb the ambient loop used by legacy tests.
    with asyncio.Runner(loop_factory=asyncio.new_event_loop) as runner:
        return runner.run(coro)


def matches(doc, query):
    """Enforce every clause; in particular do not mock away the consent CAS."""
    for key, value in query.items():
        if key == "$or":
            if not any(matches(doc, clause) for clause in value):
                return False
        elif key == "$and":
            if not all(matches(doc, clause) for clause in value):
                return False
        elif isinstance(value, dict):
            for op, operand in value.items():
                if op == "$exists" and (key in doc) != operand:
                    return False
                if op == "$lt" and (key not in doc or not doc[key] < operand):
                    return False
                if op not in ("$exists", "$lt"):
                    raise AssertionError(f"Unmodeled query operator: {op}")
        elif doc.get(key) != value:
            return False
    return True


class Harness:
    def __init__(self):
        self.current = {"id": "user", "family_group_id": "family", "family_group_role": "member"}
        old = datetime.now(timezone.utc) - timedelta(hours=1)
        self.member = {
            "id": "member", "user_id": "user", "family_group_id": "family",
            "owner_id": "user", "name": "Test", "age": 70, "phone": "",
            "gender": "", "role": "senior", "status": "healthy",
            "location_sharing_enabled": True, "location_consent_generation": 0,
            "latitude": 1.0, "longitude": 2.0, "captured_at": old,
            "coordinate_captured_at": old, "last_seen": old,
        }
        self.user = {"id": "user", "location_sharing_enabled": True}
        self.db = MagicMock()
        self.db.users.find_one = AsyncMock(side_effect=lambda *a, **k: copy.deepcopy(self.user))
        self.db.users.update_one = AsyncMock(side_effect=self.update_user)
        self.db.members.find_one = AsyncMock(side_effect=lambda query, *a, **k:
            copy.deepcopy(self.member) if matches(self.member, query) else None)
        self.db.members.update_one = AsyncMock(side_effect=self.update_member)
        self.db.members.update_many = AsyncMock(side_effect=self.update_many)
        self.db.location_ingest_log.insert_one = AsyncMock()
        self.db.location_history.insert_one = AsyncMock()
        self.pause_next = False
        self.entered = None
        self.release = None
        self.publication_filters = []

    async def update_user(self, query, mutation):
        self.user.update(mutation.get("$set", {}))
        return MagicMock(matched_count=1, modified_count=1)

    def apply(self, mutation):
        self.member.update(mutation.get("$set", {}))
        for key, increment in mutation.get("$inc", {}).items():
            self.member[key] = self.member.get(key, 0) + increment
        for key in mutation.get("$currentDate", {}):
            self.member[key] = datetime.now(timezone.utc)

    async def update_member(self, query, mutation):
        if "latitude" in mutation.get("$set", {}):
            self.publication_filters.append(copy.deepcopy(query))
            if self.pause_next:
                self.pause_next = False
                self.entered.set()
                await self.release.wait()
        # No await between predicate evaluation and mutation: model Mongo atomicity.
        accepted = matches(self.member, query)
        if accepted:
            self.apply(mutation)
        return MagicMock(matched_count=int(accepted), modified_count=int(accepted))

    async def update_many(self, query, mutation):
        accepted = matches(self.member, query)
        if accepted:
            self.apply(mutation)
        return MagicMock(matched_count=int(accepted), modified_count=int(accepted))

    def pause(self):
        self.pause_next = True
        self.entered = asyncio.Event()
        self.release = asyncio.Event()

    async def admitted(self, task):
        waiter = asyncio.create_task(self.entered.wait())
        done, _ = await asyncio.wait((task, waiter), return_when=asyncio.FIRST_COMPLETED)
        if task in done:
            waiter.cancel()
            await task  # Surface endpoint errors instead of hanging at the barrier.
            raise AssertionError("Upload did not reach publication barrier")
        await waiter

    def upload(self, timestamp="fresh", latitude=3.0):
        payload = {"latitude": latitude, "longitude": latitude + 1}
        if timestamp == "fresh":
            payload["timestamp"] = datetime.now(timezone.utc).isoformat()
        elif timestamp is not None:
            payload["timestamp"] = timestamp.isoformat()
        return server.update_member_location("member", server.LocationUpdate(**payload), self.current)

    def sharing(self, enabled):
        return server.update_my_preferences(
            server.PreferencesUpdate(location_sharing_enabled=enabled), self.current,
        )

    def assert_cleared(self):
        assert self.member["location_sharing_enabled"] is False
        assert (self.member["latitude"], self.member["longitude"],
                self.member["coordinate_captured_at"]) == (None, None, None)


@pytest.fixture
def harness():
    h = Harness()
    with patch.object(server, "db", h.db), \
            patch.object(server, "stamp_device_presence", AsyncMock()), \
            patch.object(server, "_trace_record_gps", MagicMock()), \
            patch.object(server.geocoding, "GEOCODE_BACKEND_ENABLED", True):
        yield h


@pytest.mark.parametrize("timestamp", ["fresh", None])
def test_admitted_upload_cannot_restore_location_after_withdrawal(harness, timestamp):
    async def scenario():
        h = harness
        h.pause()
        pending = asyncio.create_task(h.upload(timestamp))
        await h.admitted(pending)  # Initial consent passed; final mutation not evaluated.
        response = await h.sharing(False)
        assert response.location_sharing_enabled is False
        h.assert_cleared()
        generation = h.member["location_consent_generation"]
        h.release.set()
        receipt = await pending
        h.assert_cleared()
        assert h.member["location_consent_generation"] == generation
        assert receipt.coordinate_captured_at is None
        assert receipt.location_write_accepted is False
        assert receipt.location_write_rejection_reason == "sharing_disabled"
        assert h.publication_filters[0]["location_sharing_enabled"] is True
        assert "$and" in h.publication_filters[0]
        assert not h.db.location_history.insert_one.called
        log = h.db.location_ingest_log.insert_one.call_args.args[0]
        assert log["write_accepted"] is False
        assert log["rejection_reason"] == "sharing_disabled"
    run(scenario())


def test_normal_authorized_write_accepts_the_atomic_coordinate_tuple(harness):
    receipt = run(harness.upload())
    assert receipt.location_write_accepted is True
    assert receipt.location_write_rejection_reason is None
    assert (harness.member["latitude"], harness.member["longitude"]) == (3.0, 4.0)
    assert harness.member["coordinate_captured_at"] == harness.member["captured_at"]
    assert receipt.coordinate_captured_at == harness.member["coordinate_captured_at"]
    assert receipt.model_dump(mode="json")["location_write_accepted"] is True
    assert "location_write_accepted" not in harness.member


@pytest.mark.parametrize("kind", ["older", "replay"])
def test_consent_guard_preserves_timestamp_and_replay_guards(harness, kind):
    before = copy.deepcopy(harness.member)
    captured = (before["captured_at"] - timedelta(minutes=1) if kind == "older"
                else datetime.now(timezone.utc) - timedelta(minutes=10))
    receipt = run(harness.upload(captured))
    assert (harness.member["latitude"], harness.member["longitude"],
            harness.member["coordinate_captured_at"]) == (
        before["latitude"], before["longitude"], before["coordinate_captured_at"])
    assert receipt.location_write_accepted is False
    assert receipt.location_write_rejection_reason == (
        "older_timestamp" if kind == "older" else "replay_suppressed")


def test_already_disabled_request_does_not_attempt_publication(harness):
    async def scenario():
        await harness.sharing(False)
        receipt = await harness.upload()
        harness.assert_cleared()
        assert not harness.publication_filters
        assert receipt.location_write_accepted is False
        assert receipt.location_write_rejection_reason == "sharing_disabled"
    run(scenario())


@pytest.mark.parametrize("publish_new", [False, True])
def test_reenable_allows_new_request_but_cannot_revive_prewithdrawal_request(harness, publish_new):
    async def scenario():
        h = harness
        h.pause()
        old = asyncio.create_task(h.upload())
        await h.admitted(old)
        await h.sharing(False)
        h.assert_cleared()
        await h.sharing(True)
        assert h.member["latitude"] is None
        assert h.member["coordinate_captured_at"] is None
        assert h.member["location_consent_generation"] == 2
        if publish_new:
            fresh = await h.upload(latitude=5.0)
            assert fresh.location_write_accepted is True
        before = copy.deepcopy(h.member)
        h.release.set()
        rejected = await old
        assert rejected.location_write_accepted is False
        assert rejected.location_write_rejection_reason == "consent_changed"
        for key in ("latitude", "longitude", "coordinate_captured_at",
                    "captured_at", "location_consent_generation"):
            assert h.member[key] == before[key]
        assert h.member["location_sharing_enabled"] is True
    run(scenario())


def test_legacy_missing_flag_is_initialized_without_coordinates(harness):
    del harness.member["location_sharing_enabled"]
    del harness.member["location_consent_generation"]
    receipt = run(harness.upload())
    assert receipt.location_write_accepted is True
    assert harness.member["location_sharing_enabled"] is True
    initialization = harness.db.members.update_one.call_args_list[0]
    assert initialization.args[1] == {"$set": {"location_sharing_enabled": True}}
    assert initialization.args[0]["location_consent_generation"] == {"$exists": False}


def test_legacy_initialization_cannot_overwrite_concurrent_withdrawal(harness):
    del harness.member["location_sharing_enabled"]
    del harness.member["location_consent_generation"]
    original = harness.db.members.update_one.side_effect

    async def update(query, mutation):
        if mutation == {"$set": {"location_sharing_enabled": True}}:
            await harness.sharing(False)
        return await original(query, mutation)

    harness.db.members.update_one.side_effect = update
    receipt = run(harness.upload())
    harness.assert_cleared()
    assert receipt.location_write_accepted is False


def test_failed_consent_mirror_is_not_reported_as_success(harness):
    harness.db.members.update_many.side_effect = RuntimeError("storage unavailable")
    with pytest.raises(server.HTTPException) as error:
        run(harness.sharing(False))
    assert error.value.status_code == 503
    assert harness.user["location_sharing_enabled"] is True
    assert not harness.db.users.update_one.called
