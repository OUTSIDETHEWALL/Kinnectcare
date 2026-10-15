"""Startup OFF synchronization uses actual endpoints and an atomic predicate model."""
import asyncio
import copy
from unittest.mock import AsyncMock, patch

import pytest

from test_startup_repair_consent_race import RepairHarness
from test_location_consent_write_race import run, server


class SyncHarness(RepairHarness):
    def __init__(self):
        super().__init__()
        self.member["owner_id"] = "user"  # The previously persistent self-row case.
        self.user["location_sharing_enabled"] = False
        self.sync_filters = []
        self.sync_results = []

    def find_candidates(self, query, projection):
        assert query["user_id"] == {"$ne": None, "$exists": True}
        docs = []
        if self.member.get("user_id") and (
            "location_sharing_enabled" not in query
            or self.member.get("location_sharing_enabled") == query["location_sharing_enabled"]
        ):
            docs.append({key: copy.deepcopy(self.member[key]) for key, included in projection.items()
                         if included and key in self.member})

        async def cursor():
            for doc in docs:
                yield doc
        return cursor()

    async def update_member(self, query, mutation):
        if mutation.get("$set", {}).get("location_sharing_enabled") is False:
            self.sync_filters.append(copy.deepcopy(query))
            if self.pause_at == "write":
                self.pause_at = None
                self.entered.set()
                await self.release.wait()
            result = await super().update_member(query, mutation)
            self.sync_results.append(result.matched_count)
            return result
        return await super().update_member(query, mutation)


@pytest.fixture
def h():
    harness = SyncHarness()
    with patch.object(server, "db", harness.db), \
            patch.object(server, "stamp_device_presence", AsyncMock()), \
            patch.object(server, "_trace_record_gps"), \
            patch.object(server.geocoding, "GEOCODE_BACKEND_ENABLED", True), \
            patch.object(server, "push_to_family_group", harness.push), \
            patch.object(server, "deliver_welfare_response_notification", harness.delivery):
        yield harness


@pytest.mark.parametrize("boundary", ["lookup", "write"])
@pytest.mark.parametrize("generation", [None, 0, 7])
def test_old_off_sync_cannot_defeat_new_on_or_clear_new_fix(h, boundary, generation):
    async def scenario():
        if generation is None:
            h.member.pop("location_consent_generation")
        else:
            h.member["location_consent_generation"] = generation
        h.pause_repair(boundary)
        task = asyncio.create_task(server._sync_user_sharing_pref_to_members())
        await h.admitted(task)
        await h.sharing(True)
        assert h.user["location_sharing_enabled"] is True
        assert h.member["location_sharing_enabled"] is True
        assert h.member["location_consent_generation"] == (generation or 0) + 1
        receipt = await h.upload(latitude=8.0)
        assert receipt.location_write_accepted is True
        before = copy.deepcopy(h.member)
        h.release.set()
        await task
        assert h.member == before  # Includes accepted tuple/time and new authority.
        assert h.sync_results == [0]
        receipt = await h.upload(latitude=9.0)
        assert receipt.location_write_accepted is True
        assert (h.member["latitude"], h.member["longitude"]) == (9.0, 10.0)
        assert h.member["coordinate_captured_at"] == h.member["captured_at"]
        after = copy.deepcopy(h.member)
        await server._sync_user_sharing_pref_to_members()
        await server._heal_cross_user_sharing_leaks()
        assert h.member == after  # Self-created row stays enabled across startup.
        query = h.sync_filters[0]
        assert query["user_id"] == "user" and query["owner_id"] == "user"
        assert query["location_sharing_enabled"] is False
        assert "$and" in query
        assert h.db.members.find.call_args.args[1]["location_consent_generation"] == 1
    run(scenario())


@pytest.mark.parametrize("boundary", ["lookup", "write"])
@pytest.mark.parametrize("toggles", [[True, False], [True, False, True]])
def test_generation_cycles_do_not_resurrect_old_sync(h, boundary, toggles):
    async def scenario():
        h.pause_repair(boundary)
        task = asyncio.create_task(server._sync_user_sharing_pref_to_members())
        await h.admitted(task)
        for enabled in toggles:
            await h.sharing(enabled)
        before = copy.deepcopy(h.member)
        h.release.set()
        await task
        assert h.member == before
        assert h.sync_results == [0]
        assert h.member["location_consent_generation"] == 7 + len(toggles)
        if not toggles[-1]:
            h.assert_cleared()
    run(scenario())


@pytest.mark.parametrize("state", ["missing", False, True])
@pytest.mark.parametrize("generation", [None, 0, 7])
def test_legitimate_off_sync_still_clears_stale_location_without_rewriting_generation(h, state, generation):
    if state == "missing":
        h.member.pop("location_sharing_enabled")
    else:
        h.member["location_sharing_enabled"] = state
    if generation is None:
        h.member.pop("location_consent_generation")
    else:
        h.member["location_consent_generation"] = generation
    h.member.update(latitude=1.0, longitude=2.0, coordinate_captured_at=h.member["last_seen"])
    before = copy.deepcopy(h.member)
    run(server._sync_user_sharing_pref_to_members())
    h.assert_cleared()
    assert h.member["location_name"] == "Location Sharing Off"
    assert h.member.get("location_consent_generation") == before.get("location_consent_generation")
    assert ("location_consent_generation" in h.member) == ("location_consent_generation" in before)
    assert h.member["last_seen"] == before["last_seen"]
    assert h.sync_results == [1]


@pytest.mark.parametrize("boundary", ["lookup", "write"])
def test_new_withdrawal_still_wins_over_obsolete_sync(h, boundary):
    async def scenario():
        h.member["location_sharing_enabled"] = True
        h.pause_repair(boundary)
        task = asyncio.create_task(server._sync_user_sharing_pref_to_members())
        await h.admitted(task)
        await h.sharing(False)
        before = copy.deepcopy(h.member)
        h.release.set()
        await task
        assert h.member == before
        assert h.sync_results == [0]
        receipt = await h.submit("daily")
        h.assert_cleared()
        h.assert_receipts_location_free(receipt)
    run(scenario())


@pytest.mark.parametrize("field", ["user_id", "owner_id"])
def test_stale_sync_cannot_mutate_relinked_or_reowned_member(h, field):
    async def scenario():
        h.pause_repair("write")
        task = asyncio.create_task(server._sync_user_sharing_pref_to_members())
        await h.admitted(task)
        h.member[field] = "replacement"
        before = copy.deepcopy(h.member)
        h.release.set()
        await task
        assert h.member == before
        assert h.sync_results == [0]
    run(scenario())


@pytest.mark.parametrize("preference", [True, None, "missing"])
def test_only_explicit_off_preference_authorizes_destructive_sync(h, preference):
    if preference == "missing":
        h.user.pop("location_sharing_enabled")
    else:
        h.user["location_sharing_enabled"] = preference
    before = copy.deepcopy(h.member)
    run(server._sync_user_sharing_pref_to_members())
    assert h.member == before
    assert not h.sync_filters
