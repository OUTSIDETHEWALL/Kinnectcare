"""Real startup repair and preference/check-in endpoints; offline atomic CAS model."""
import asyncio
import copy
from unittest.mock import MagicMock, patch

import pytest

from test_checkin_location_consent import CheckinHarness
from test_location_consent_write_race import matches, run, server


class RepairHarness(CheckinHarness):
    def __init__(self, generation=7):
        super().__init__()
        # Repairable legacy inconsistency: linked policy ON, member mirror OFF.
        self.member.update(owner_id="caregiver", location_sharing_enabled=False,
                           latitude=None, longitude=None, coordinate_captured_at=None,
                           location_name="Location Sharing Off")
        if generation is None:
            self.member.pop("location_consent_generation")
        else:
            self.member["location_consent_generation"] = generation
        self.db.members.find = MagicMock(side_effect=self.find_candidates)
        self.db.users.find_one.side_effect = self.lookup
        self.pause_at = None
        self.repair_filters = []
        self.repair_results = []

    def find_candidates(self, query, projection):
        assert query["location_sharing_enabled"] is False
        docs = []
        if self.member.get("location_sharing_enabled") is False and self.member.get("user_id"):
            docs.append({key: copy.deepcopy(self.member[key]) for key, included in projection.items()
                         if included and key in self.member})

        async def cursor():
            for doc in docs:
                yield doc
        return cursor()

    def apply(self, mutation):
        super().apply(mutation)
        for key in mutation.get("$unset", {}):
            self.member.pop(key, None)

    async def lookup(self, *args, **kwargs):
        snapshot = copy.deepcopy(self.user)
        if self.pause_at == "lookup":
            self.pause_at = None
            self.entered.set()  # Evidence captured, but caller has not resumed.
            await self.release.wait()
        return snapshot

    async def update_member(self, query, mutation):
        if mutation.get("$set", {}).get("location_sharing_enabled") is True:
            self.repair_filters.append(copy.deepcopy(query))
            if self.pause_at == "write":
                self.pause_at = None
                self.entered.set()
                await self.release.wait()
            # Parent evaluates every predicate and applies atomically, no await.
            result = await super().update_member(query, mutation)
            self.repair_results.append(result.matched_count)
            return result
        return await super().update_member(query, mutation)

    def pause_repair(self, boundary):
        self.pause_at = boundary
        self.entered = asyncio.Event()
        self.release = asyncio.Event()


@pytest.fixture
def h():
    harness = RepairHarness()
    with patch.object(server, "db", harness.db), \
            patch.object(server, "push_to_family_group", harness.push), \
            patch.object(server, "deliver_welfare_response_notification", harness.delivery):
        yield harness


@pytest.mark.parametrize("boundary", ["lookup", "write"])
@pytest.mark.parametrize("generation", [None, 0, 7])
@pytest.mark.parametrize("kind", ["daily", "welfare"])
def test_withdrawal_wins_and_subsequent_checkin_cannot_publish(h, boundary, generation, kind):
    async def scenario():
        if generation is None:
            h.member.pop("location_consent_generation")
        else:
            h.member["location_consent_generation"] = generation
        h.pause_repair(boundary)
        task = asyncio.create_task(server._heal_cross_user_sharing_leaks())
        await h.admitted(task)
        await h.sharing(False)
        h.assert_cleared()
        before = copy.deepcopy(h.member)
        assert before["location_consent_generation"] == (generation or 0) + 1
        h.release.set()
        await task
        assert h.member == before  # Includes label, consent, generation and timestamps.
        assert h.repair_results == [0]
        receipt = await h.submit(kind)
        h.assert_cleared()
        assert h.member["location_name"] == before["location_name"]
        assert h.member["location_consent_generation"] == before["location_consent_generation"]
        h.assert_receipts_location_free(receipt)
        assert not h.publication_filters
        query = h.repair_filters[0]
        assert query["location_sharing_enabled"] is False
        assert query["user_id"] == "user" and query["owner_id"] == "caregiver"
        assert "$and" in query
        assert h.db.members.find.call_args.args[1]["location_consent_generation"] == 1
    run(scenario())


@pytest.mark.parametrize("boundary", ["lookup", "write"])
def test_off_on_old_repair_cannot_change_new_authority_or_location(h, boundary):
    async def scenario():
        h.pause_repair(boundary)
        task = asyncio.create_task(server._heal_cross_user_sharing_leaks())
        await h.admitted(task)
        await h.sharing(False)
        h.assert_cleared()
        await h.sharing(True)
        receipt = await h.submit("daily", latitude=8.0)
        h.assert_receipts_location_free(receipt)
        before = copy.deepcopy(h.member)
        h.release.set()
        await task
        assert h.member == before
        assert h.repair_results == [0]
        assert h.member["location_consent_generation"] == 9
        assert (h.member["latitude"], h.member["longitude"]) == (8.0, 9.0)
    run(scenario())


@pytest.mark.parametrize("generation", [None, 0, 7])
def test_unchanged_affirmative_legacy_policy_still_repairs_without_generation_change(h, generation):
    async def scenario():
        if generation is None:
            h.member.pop("location_consent_generation")
        else:
            h.member["location_consent_generation"] = generation
        before = copy.deepcopy(h.member)
        await server._heal_cross_user_sharing_leaks()
        expected = {**before, "location_sharing_enabled": True}
        expected.pop("location_name")
        assert h.member == expected
        assert h.repair_results == [1]
        receipt = await h.submit("daily")
        assert (h.member["latitude"], h.member["longitude"]) == (3.0, 4.0)
        assert h.member["coordinate_captured_at"] is None
        h.assert_receipts_location_free(receipt)
    run(scenario())


@pytest.mark.parametrize("preference", [False, None, "missing"])
def test_nonaffirmative_linked_preference_cannot_authorize_repair(h, preference):
    if preference == "missing":
        h.user.pop("location_sharing_enabled")
    else:
        h.user["location_sharing_enabled"] = preference
    before = copy.deepcopy(h.member)
    run(server._heal_cross_user_sharing_leaks())
    assert h.member == before
    assert not h.repair_filters


@pytest.mark.parametrize("field", ["user_id", "owner_id"])
def test_relinked_member_invalidates_observed_repair_identity(h, field):
    async def scenario():
        h.pause_repair("write")
        task = asyncio.create_task(server._heal_cross_user_sharing_leaks())
        await h.admitted(task)
        h.member[field] = "replacement"
        before = copy.deepcopy(h.member)
        h.release.set()
        await task
        assert h.member == before
        assert h.repair_results == [0]
    run(scenario())
