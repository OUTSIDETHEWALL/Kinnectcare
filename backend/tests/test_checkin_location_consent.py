"""Real check-in/welfare endpoints; atomic predicate model, no external services."""
import asyncio
import copy
from unittest.mock import AsyncMock, patch
from types import SimpleNamespace

import pytest

from test_location_consent_write_race import Harness, matches, run, server


class CheckinHarness(Harness):
    def __init__(self):
        super().__init__()
        self.member["location_name"] = "Old place"
        self.checkins = {}
        self.requests = {}
        self.db.checkins.insert_one = AsyncMock(side_effect=self.insert_checkin)
        self.db.checkins.find_one = AsyncMock(side_effect=self.find_checkin)
        self.db.checkin_requests.find_one = AsyncMock(side_effect=self.find_request)
        self.db.checkin_requests.update_one = AsyncMock(side_effect=self.update_request)
        self.db.alerts.update_many = AsyncMock()
        self.push = AsyncMock()
        self.delivery = AsyncMock()

    async def insert_checkin(self, doc):
        key = doc.get("_id", doc["id"])
        if key in self.checkins:
            raise RuntimeError("duplicate canonical receipt")
        self.checkins[key] = copy.deepcopy(doc)

    async def find_checkin(self, query, *args):
        return next((copy.deepcopy(d) for d in self.checkins.values()
                     if matches(d, query)), None)

    async def find_request(self, query, *args):
        return next((copy.deepcopy(d) for d in self.requests.values()
                     if matches(d, query)), None)

    async def update_request(self, query, mutation):
        for doc in self.requests.values():
            if matches(doc, query):
                doc.update(mutation.get("$set", {}))
                for key in mutation.get("$unset", {}):
                    doc.pop(key, None)
                return SimpleNamespace(matched_count=1, modified_count=1)
        return SimpleNamespace(matched_count=0, modified_count=0)

    def submit(self, kind, latitude=3.0, name="Private place"):
        data = server.CheckInCreate(
            member_id="member", latitude=latitude,
            longitude=latitude + 1 if latitude is not None else None,
            location_name=name,
        )
        if kind == "daily":
            return server.create_checkin(data, self.current)
        request_id = f"request-{len(self.requests)}"
        self.requests[request_id] = {
            "id": request_id, "family_group_id": "family",
            "member_id": "member", "member_name": "Test",
            "requester_id": "caregiver", "target_user_id": "user",
            "status": "pending",
        }
        if kind == "adapter":
            return server.respond_to_member_welfare_check(
                "member", server.WelfareCheckResponseCreate(
                    request_id=request_id, latitude=data.latitude,
                    longitude=data.longitude, location_name=data.location_name,
                ), self.current,
            )
        return server.respond_to_checkin_request(request_id, data, self.current)

    def assert_receipts_location_free(self, receipt, all_finished=True):
        assert (receipt.latitude, receipt.longitude, receipt.location_name) == (None, None, None)
        for doc in self.checkins.values():
            assert (doc["latitude"], doc["longitude"], doc["location_name"]) == (None, None, None)
        for call in self.push.await_args_list:
            assert "Private place" not in call.args[2]
        for call in self.delivery.await_args_list:
            assert call.args[2] is None
        if not all_finished:
            return
        assert self.db.alerts.update_many.await_count == len(self.checkins)
        for request in self.requests.values():
            assert request["status"] == "responded"
            assert request["checkin_id"] in {d["id"] for d in self.checkins.values()}


@pytest.fixture
def h():
    harness = CheckinHarness()
    with patch.object(server, "db", harness.db), \
            patch.object(server, "push_to_family_group", harness.push), \
            patch.object(server, "deliver_welfare_response_notification", harness.delivery):
        yield harness


@pytest.mark.parametrize("kind", ["daily", "welfare", "adapter"])
def test_sharing_already_off_keeps_successful_checkin_location_free(h, kind):
    async def scenario():
        await h.sharing(False)
        before = copy.deepcopy(h.member)
        receipt = await h.submit(kind)
        h.assert_cleared()
        assert h.member["location_name"] == before["location_name"]
        assert h.member["location_consent_generation"] == before["location_consent_generation"]
        assert not h.publication_filters
        h.assert_receipts_location_free(receipt)
    run(scenario())


@pytest.mark.parametrize("kind", ["daily", "welfare", "adapter"])
def test_withdrawal_at_final_atomic_write_wins_but_checkin_succeeds(h, kind):
    async def scenario():
        h.pause()
        task = asyncio.create_task(h.submit(kind))
        await h.admitted(task)
        # Even the already inserted durable receipt contains no location.
        assert all(d["latitude"] is None and d["location_name"] is None
                   for d in h.checkins.values())
        await h.sharing(False)
        h.assert_cleared()
        generation = h.member["location_consent_generation"]
        h.release.set()
        receipt = await task
        h.assert_cleared()
        assert h.member["location_name"] == "Location Sharing Off"
        assert h.member["location_consent_generation"] == generation
        assert h.member["status"] == "healthy"
        h.assert_receipts_location_free(receipt)
    run(scenario())


@pytest.mark.parametrize("kind", ["daily", "welfare", "adapter"])
@pytest.mark.parametrize("new_first", [False, True])
def test_off_on_cannot_revive_undated_gps_but_checkin_still_succeeds(h, kind, new_first):
    async def scenario():
        h.pause()
        old = asyncio.create_task(h.submit(kind))
        await h.admitted(old)
        await h.sharing(False)
        h.assert_cleared()
        await h.sharing(True)
        generation = h.member["location_consent_generation"]
        if new_first:
            receipt = await h.submit(kind, latitude=8.0)
            h.assert_receipts_location_free(receipt, all_finished=False)
        before = copy.deepcopy(h.member)
        h.release.set()
        receipt = await old
        assert (h.member["latitude"], h.member["longitude"],
                h.member["coordinate_captured_at"], h.member["location_name"]) == (
            before["latitude"], before["longitude"],
            before["coordinate_captured_at"], before["location_name"])
        assert h.member["location_sharing_enabled"] is True
        assert h.member["location_consent_generation"] == generation
        h.assert_receipts_location_free(receipt)
        if not new_first:
            receipt = await h.submit(kind, latitude=8.0)
            h.assert_receipts_location_free(receipt)
        assert (h.member["latitude"], h.member["longitude"]) == (None, None)
        assert h.member["coordinate_captured_at"] is None
        assert h.member["location_consent_generation"] == generation
    run(scenario())


@pytest.mark.parametrize("kind", ["daily", "welfare", "adapter"])
def test_normal_on_publication_keeps_capture_age_unknown(h, kind):
    # An unknown-age tuple may replace only another unknown-age tuple.
    h.member["coordinate_captured_at"] = None
    h.member["captured_at"] = None
    receipt = run(h.submit(kind))
    assert (h.member["latitude"], h.member["longitude"]) == (3.0, 4.0)
    assert h.member["location_name"] == "Private place"
    assert h.member["coordinate_captured_at"] is None
    assert h.member["location_consent_generation"] == 0
    query = h.publication_filters[0]
    assert query["location_sharing_enabled"] is True
    assert query["user_id"] == "user" and query["family_group_id"] == "family"
    assert "$and" in query
    h.assert_receipts_location_free(receipt)


@pytest.mark.parametrize("kind", ["daily", "welfare"])
@pytest.mark.parametrize("flag", [None, False])
def test_no_affirmative_entry_consent_does_not_gain_authority(h, kind, flag):
    if flag is None:
        h.member.pop("location_sharing_enabled")
    else:
        h.member["location_sharing_enabled"] = flag
    before = copy.deepcopy(h.member)
    receipt = run(h.submit(kind))
    for field in ("latitude", "longitude", "coordinate_captured_at", "location_name"):
        assert h.member[field] == before[field]
    assert not h.publication_filters
    h.assert_receipts_location_free(receipt)


@pytest.mark.parametrize("kind", ["daily", "welfare"])
def test_legacy_generation_zero_is_not_a_consent_exemption(h, kind):
    h.member.pop("location_consent_generation")
    h.member["coordinate_captured_at"] = None
    h.member["captured_at"] = None
    receipt = run(h.submit(kind))
    assert h.member["latitude"] == 3.0
    assert "location_consent_generation" not in h.member
    h.assert_receipts_location_free(receipt)


@pytest.mark.parametrize("kind", ["daily", "welfare"])
def test_location_name_alone_is_not_published_while_off(h, kind):
    async def scenario():
        await h.sharing(False)
        receipt = await h.submit(kind, latitude=None)
        h.assert_cleared()
        assert h.member["location_name"] == "Location Sharing Off"
        h.assert_receipts_location_free(receipt)
    run(scenario())


@pytest.mark.parametrize("status", ["pending", "responded"])
def test_legacy_welfare_receipt_recovery_does_not_republish_its_location(h, status):
    async def scenario():
        legacy = server.CheckIn(
            owner_id="user", family_group_id="family", member_id="member",
            member_name="Test", latitude=40.0, longitude=50.0,
            location_name="Private place", source="request_response",
        ).model_dump()
        legacy["_id"] = "welfare-check:request-0"
        h.checkins[legacy["_id"]] = copy.deepcopy(legacy)
        await h.sharing(False)
        if status == "pending":
            receipt = await h.submit("welfare")
        else:
            h.requests["request-0"] = {
                "id": "request-0", "family_group_id": "family",
                "member_id": "member", "status": "responded",
                "checkin_id": legacy["id"], "response_notification_status": "pending",
            }
            receipt = await server.respond_to_checkin_request(
                "request-0", server.CheckInCreate(member_id="member"), h.current,
            )
        h.assert_cleared()
        assert (receipt.latitude, receipt.longitude, receipt.location_name) == (None, None, None)
        assert h.checkins[legacy["_id"]] == legacy  # No historical-data migration.
        assert len(h.checkins) == 1
        assert h.delivery.await_args.args[2] is None
    run(scenario())
