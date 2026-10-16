"""Offline real helper/startup/preferences/publication with atomic creation model."""
import asyncio
import copy
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from pymongo.errors import DuplicateKeyError

from test_checkin_location_consent import CheckinHarness
from test_location_consent_write_race import matches, run, server

fg = server.fg
CALLERS = (
    "startup_migration", "signup_invite", "signup_solo", "login_invite",
    "login_heal", "join_already_member", "join",
)


class CreationHarness(CheckinHarness):
    def __init__(self):
        super().__init__()
        self.rows = []
        self.user.update(family_group_id="family", full_name="Test")
        self.pause_at = None
        self.db.members.find_one = AsyncMock(side_effect=self.find_member)
        self.db.members.update_one = AsyncMock(side_effect=self.update_member)
        self.db.members.update_many = AsyncMock(side_effect=self.update_many)
        self.db.members.insert_one = AsyncMock(side_effect=AssertionError("Unfenced insert"))
        self.db.users.find = MagicMock(side_effect=self.users_cursor)
        self.db.migrations.insert_one = AsyncMock()

    def users_cursor(self, *args):
        snapshot = copy.deepcopy(self.user)

        async def cursor():
            yield snapshot
        return cursor()

    async def barrier(self, boundary):
        if self.pause_at == boundary:
            self.pause_at = None
            self.entered.set()
            await self.release.wait()

    async def find_member(self, query, projection=None):
        result = next((copy.deepcopy(doc) for doc in self.rows if matches(doc, query)), None)
        await self.barrier("lookup")
        if result and projection:
            result = {key: value for key, value in result.items()
                      if projection.get(key, 1)}
        return result

    async def update_member(self, query, mutation, upsert=False):
        if upsert:
            await self.barrier("upsert")
            # Unique _id comparison and $setOnInsert are one atomic model step.
            row = next((doc for doc in self.rows if matches(doc, query)), None)
            inserted = row is None
            if inserted:
                row = {**query, **copy.deepcopy(mutation["$setOnInsert"])}
                self.rows.append(row)
            self.member = row
            await self.barrier("after_upsert")
            return SimpleNamespace(matched_count=int(not inserted), modified_count=0,
                                   upserted_id=row["_id"] if inserted else None)
        row = next((doc for doc in self.rows if matches(doc, query)), None)
        if row is not None:
            self.member = row
            self.apply(mutation)
        return SimpleNamespace(matched_count=int(row is not None),
                               modified_count=int(row is not None))

    async def update_many(self, query, mutation):
        affected = 0
        for row in self.rows:
            if matches(row, query):
                self.member = row
                self.apply(mutation)
                affected += 1
        return SimpleNamespace(matched_count=affected, modified_count=affected)

    def create(self, caller="login_heal", snapshot=None):
        snapshot = copy.deepcopy(self.user if snapshot is None else snapshot)
        if caller == "startup_migration":
            return server._heal_missing_self_member_rows()
        return fg.ensure_self_member_row(self.db, snapshot, "family", caller=caller)

    def checkin(self):
        return server.create_checkin(server.CheckInCreate(
            member_id=self.member["id"], latitude=3.0, longitude=4.0,
            location_name="Private place",
        ), self.current)

    def upload(self):
        return server.update_member_location(
            self.member["id"], server.LocationUpdate(
                latitude=8.0, longitude=9.0,
                timestamp=datetime.now(timezone.utc).isoformat(),
                # Model a CURRENT client, not an unversioned legacy write
                # silently adopting a renewed consent lifetime.
                consent_generation=self.member["location_consent_generation"],
            ), self.current,
        )


@pytest.fixture
def h():
    harness = CreationHarness()
    with patch.object(server, "db", harness.db), \
            patch.object(server, "push_to_family_group", harness.push), \
            patch.object(server, "stamp_device_presence", AsyncMock()), \
            patch.object(server, "_trace_record_gps"), \
            patch.object(server.geocoding, "GEOCODE_BACKEND_ENABLED", True):
        yield harness


@pytest.mark.parametrize("caller", CALLERS)
@pytest.mark.parametrize("boundary", ["lookup", "upsert"])
def test_withdrawal_before_creation_wins_for_every_caller_input(h, caller, boundary):
    async def scenario():
        snapshot = copy.deepcopy(h.user)
        snapshot["location_consent_generation"] = 99  # Never import stale authority.
        h.pause_at = boundary
        h.entered, h.release = asyncio.Event(), asyncio.Event()
        task = asyncio.create_task(h.create(caller, snapshot))
        await h.admitted(task)
        response = await h.sharing(False)  # No row exists: the original loophole.
        assert response.location_sharing_enabled is False
        assert h.rows == []
        h.release.set()
        await task
        assert len(h.rows) == 1
        h.assert_cleared()
        assert h.member["location_consent_generation"] == 0
        assert h.user["location_sharing_enabled"] is False
        before = copy.deepcopy(h.member)
        receipt = await h.checkin()
        h.assert_receipts_location_free(receipt)
        h.assert_cleared()
        for key in ("location_consent_generation", "latitude", "longitude",
                    "coordinate_captured_at", "location_name"):
            assert h.member[key] == before[key]
        assert not h.publication_filters
    run(scenario())


def test_member_first_withdrawal_gap_cannot_authorize_new_row(h):
    async def scenario():
        entered, release = asyncio.Event(), asyncio.Event()
        original = h.db.users.update_one.side_effect

        async def delayed_user_mirror(query, mutation):
            entered.set()
            await release.wait()
            return await original(query, mutation)
        h.db.users.update_one.side_effect = delayed_user_mirror
        withdrawal = asyncio.create_task(h.sharing(False))
        await entered.wait()
        assert h.user["location_sharing_enabled"] is True
        assert not h.rows  # Member withdrawal has finished before creation.
        await h.create()
        h.assert_cleared()
        release.set()
        await withdrawal
        receipt = await h.checkin()
        h.assert_receipts_location_free(receipt)
        h.assert_cleared()
    run(scenario())


@pytest.mark.parametrize("preference", [True, False, None, "missing"])
def test_new_row_fails_closed_but_current_explicit_on_recovers(h, preference):
    async def scenario():
        if preference == "missing":
            h.user.pop("location_sharing_enabled")
        else:
            h.user["location_sharing_enabled"] = preference
        await h.create()
        h.assert_cleared()
        assert h.member["location_consent_generation"] == 0
        receipt = await h.checkin()
        h.assert_receipts_location_free(receipt)
        h.assert_cleared()
        await h.sharing(True)  # Even if the user mirror was already True.
        assert h.user["location_sharing_enabled"] is True
        assert h.member["location_sharing_enabled"] is True
        assert h.member["location_consent_generation"] == 1
        receipt = await h.upload()
        assert receipt.location_write_accepted is True
        assert (h.member["latitude"], h.member["longitude"]) == (8.0, 9.0)
        assert h.member["coordinate_captured_at"] == h.member["captured_at"]
        captured = h.member["coordinate_captured_at"]
        receipt = await h.checkin()
        # The primary check-in succeeds; its undated optional coordinates
        # cannot destroy the dated tuple or adopt renewed consent.
        assert (h.member["latitude"], h.member["longitude"]) == (8.0, 9.0)
        assert h.member["coordinate_captured_at"] == captured
        h.assert_receipts_location_free(receipt)
    run(scenario())


def test_old_creation_cannot_inherit_later_on_or_reset_generation(h):
    async def scenario():
        h.pause_at = "after_upsert"
        h.entered, h.release = asyncio.Event(), asyncio.Event()
        task = asyncio.create_task(h.create())
        await h.admitted(task)
        await h.sharing(True)
        await h.sharing(False)
        await h.sharing(True)
        await h.upload()
        before = copy.deepcopy(h.member)
        assert before["location_consent_generation"] == 3
        h.release.set()
        returned = await task
        assert h.member == before
        assert returned["location_consent_generation"] == 3
        # Retry never replays $setOnInsert over current consent or coordinates.
        await h.create(snapshot={"id": "user", "location_sharing_enabled": False})
        assert h.member == before
    run(scenario())


@pytest.mark.parametrize("duplicate_key", [False, True])
def test_concurrent_creation_converges_without_resetting_winner(h, duplicate_key):
    async def scenario():
        first_waiting, release_first = asyncio.Event(), asyncio.Event()
        atomic_upsert = h.db.members.update_one.side_effect
        calls = 0

        async def interleaved(query, mutation, upsert=False):
            nonlocal calls
            if not upsert:
                return await atomic_upsert(query, mutation, upsert)
            calls += 1
            if calls == 1:
                first_waiting.set()
                await release_first.wait()
                if duplicate_key:
                    raise DuplicateKeyError("Other creator won unique _id")
            return await atomic_upsert(query, mutation, upsert)
        h.db.members.update_one.side_effect = interleaved
        first = asyncio.create_task(h.create("signup_solo"))
        await first_waiting.wait()
        second = await h.create("join")
        await h.sharing(True)
        await h.upload()
        before = copy.deepcopy(h.member)
        release_first.set()
        result = await first
        assert len(h.rows) == 1
        assert result["id"] == second["id"]
        assert h.member == before
        assert h.member["location_consent_generation"] == 1
    run(scenario())


def test_recreation_has_new_public_identity_and_rejects_old_publication(h):
    async def scenario():
        await h.create()
        await h.sharing(True)
        old_id, old_generation = h.member["id"], h.member["location_consent_generation"]
        old_key = h.member["_id"]
        h.rows.clear()  # Model a separately authorized deletion.
        await h.create()
        assert h.member["_id"] == old_key
        assert h.member["id"] != old_id  # Do not reuse publication identity.
        await h.sharing(True)
        assert h.member["location_consent_generation"] == old_generation
        outcome = await h.db.members.update_one(
            {"id": old_id, **server._location_consent_condition(old_generation)},
            {"$set": {"latitude": 99.0}},
        )
        assert outcome.matched_count == 0
        assert h.member["latitude"] is None
    run(scenario())


@pytest.mark.parametrize("boundary", ["lookup", "upsert"])
def test_preinsertion_on_off_on_cycle_cannot_authorize_old_creation(h, boundary):
    async def scenario():
        h.pause_at = boundary
        h.entered, h.release = asyncio.Event(), asyncio.Event()
        task = asyncio.create_task(h.create())
        await h.admitted(task)
        await h.sharing(False)
        await h.sharing(True)
        assert h.rows == []
        h.release.set()
        await task
        assert h.user["location_sharing_enabled"] is True
        h.assert_cleared()  # The later ON did not cover this then-absent row.
        assert h.member["location_consent_generation"] == 0
        h.assert_receipts_location_free(await h.checkin())
        h.assert_cleared()
        await h.sharing(True)
        assert h.member["location_consent_generation"] == 1
        assert (await h.upload()).location_write_accepted is True
    run(scenario())


def test_invite_metadata_and_membership_creation_are_preserved(h):
    async def scenario():
        result = await fg.ensure_self_member_row(
            h.db, h.user, "family", {"role": "senior", "relationship": "Mom"},
            caller="signup_invite",
        )
        assert result["user_id"] == result["owner_id"] == "user"
        assert result["family_group_id"] == "family" and result["name"] == "Test"
        assert (result["age"], result["phone"], result["gender"]) == (0, "", "")
        assert (result["role"], result["relationship"], result["daily_checkin_time"]) == (
            "senior", "Mom", "09:00",
        )
        assert "_id" not in result
        h.assert_cleared()
    run(scenario())


@pytest.mark.parametrize("enabled", [False, True])
@pytest.mark.parametrize("generation", [None, 0, 7])
def test_existing_legacy_row_is_not_overwritten_by_creation(h, enabled, generation):
    async def scenario():
        h.member["location_sharing_enabled"] = enabled
        if generation is None:
            h.member.pop("location_consent_generation")
        else:
            h.member["location_consent_generation"] = generation
        h.rows.append(copy.deepcopy(h.member))
        before = copy.deepcopy(h.member)
        returned = await h.create(snapshot={"id": "user", "location_sharing_enabled": False})
        assert returned == before and h.member == before
        assert not h.db.members.update_one.called
    run(scenario())
