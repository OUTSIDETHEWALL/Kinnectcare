"""Actual member/upload/preferences endpoints, predicate-enforcing offline model."""
import asyncio
import copy
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from bson.int64 import Int64
from fastapi.testclient import TestClient

from test_location_history_consent import HistoryHarness
from test_location_consent_write_race import matches, run, server

LAT = 33.1234567
LON = LAT + 1
LABEL = "Private precise diagnostic address"
MAP = "https://maps.example/private-precise-position"


class PipelineHarness(HistoryHarness):
    def __init__(self):
        super().__init__()
        self.db.members.find = MagicMock(side_effect=self.find_members)
        self.geocode = AsyncMock(side_effect=self.resolve)
        self.family = {"id": "caregiver", "family_group_id": "family",
                       "family_group_role": "owner"}

    def find_members(self, query, projection):
        async def to_list(length):
            docs = [copy.deepcopy(self.member)] if matches(self.member, query) else []
            if any(value == 1 for value in projection.values()):
                docs = [{key: value for key, value in d.items()
                         if projection.get(key) == 1} for d in docs]
            await self.barrier("list_read")
            return docs
        return SimpleNamespace(to_list=to_list)

    async def resolve(self, *args, **kwargs):
        await self.barrier("geocode")
        return LABEL, None

    async def view(self, endpoint, own=False, requester=None):
        current = requester or (self.current if own else self.family)
        if endpoint == "single":
            result = await server.get_member("member", current=current)
            return [result.model_dump(mode="json")]
        result = await server.list_members(current=current)
        return [member.model_dump(mode="json") for member in result]

    def add_nested_evidence(self):
        self.member["location_pipeline"].update(
            address=LABEL, map_url=MAP,
            provider_payload={"native": {"position": [LAT, LON], "label": LABEL}},
            unexpected_alias={"lat": LAT, "lng": LON},
        )


@pytest.fixture
def h():
    harness = PipelineHarness()
    with patch.object(server, "db", harness.db), \
            patch.object(server, "stamp_device_presence", AsyncMock()), \
            patch.object(server, "_trace_record_gps"), \
            patch.object(server.geocoding, "GEOCODE_BACKEND_ENABLED", True), \
            patch.object(server.geocoding, "resolve_location_name", harness.geocode):
        yield harness


def assert_private(response):
    """Inspect the complete JSON response, including arbitrary nested aliases."""
    encoded = json.dumps(response)
    for secret in (str(LAT), str(LON), LABEL, MAP):
        assert secret not in encoded
    for member in response:
        assert member["location_pipeline"] is None
        for key in ("latitude", "longitude", "coordinate_captured_at"):
            assert member[key] is None
        # The static OFF notice is not an address. captured_at is retained for
        # ordering after re-enable, without a coordinate tuple or pipeline.
        assert member["location_name"] in (None, "Location Sharing Off")
        if member["location_sharing_enabled"] is False:
            assert member["captured_at"] is None


@pytest.mark.parametrize("endpoint", ["single", "list"])
def test_real_withdrawal_hides_entire_pipeline_and_preserves_private_storage(h, endpoint):
    async def scenario():
        await h.upload(latitude=LAT)
        h.add_nested_evidence()
        before = copy.deepcopy(h.member["location_pipeline"])
        assert (await h.view(endpoint))[0]["location_pipeline"]["native_latitude"] == LAT
        await h.sharing(False)
        h.assert_cleared()
        response = await h.view(endpoint)
        assert response[0]["location_sharing_enabled"] is False
        assert_private(response)
        assert h.member["location_pipeline"] == before
    run(scenario())


@pytest.mark.parametrize("endpoint", ["single", "list"])
def test_only_linked_self_can_keep_own_off_diagnostics(h, endpoint):
    async def scenario():
        await h.upload(latitude=LAT)
        h.add_nested_evidence()
        await h.sharing(False)
        own = (await h.view(endpoint, own=True))[0]
        assert own["location_pipeline"]["native_latitude"] == LAT
        assert own["location_pipeline"]["provider_payload"]["native"]["position"] == [LAT, LON]
        h.member["owner_id"] = "caregiver"
        assert_private(await h.view(endpoint))  # Creator + group owner is NOT self.
    run(scenario())


@pytest.mark.parametrize("endpoint", ["single", "list"])
@pytest.mark.parametrize("generation", ["missing", 0, Int64(7)])
def test_off_on_cannot_revive_old_pipeline_but_fresh_upload_works(h, endpoint, generation):
    async def scenario():
        if generation == "missing":
            h.member.pop("location_consent_generation")
        else:
            h.member["location_consent_generation"] = generation
        await h.upload(latitude=LAT)
        old = copy.deepcopy(h.member["location_pipeline"])
        await h.sharing(False)
        await h.sharing(True)
        assert_private(await h.view(endpoint))
        assert h.member["location_pipeline"] == old
        fresh = await h.upload(latitude=8.0)
        assert fresh.location_write_accepted is True
        response = (await h.view(endpoint))[0]
        assert (response["latitude"], response["longitude"]) == (8.0, 9.0)
        trace = response["location_pipeline"]
        assert trace["native_latitude"] == trace["stored_latitude"] == 8.0
        assert trace["location_consent_generation"] == h.member["location_consent_generation"]
        assert trace["subject_user_id"] == "user"
        assert trace["mongo_write_at"] and trace["members_response_at"]
    run(scenario())


@pytest.mark.parametrize("endpoint", ["single", "list"])
@pytest.mark.parametrize("cycle", [False, True])
def test_withdrawal_at_real_atomic_pipeline_write_boundary_wins(h, endpoint, cycle):
    async def scenario():
        await h.upload(latitude=LAT)
        original = copy.deepcopy(h.member["location_pipeline"])
        h.pause()  # Real update_one containing coordinates AND pipeline.
        task = asyncio.create_task(h.upload(latitude=LAT + 0.01))
        await h.admitted(task)
        await h.sharing(False)
        if cycle:
            await h.sharing(True)
        h.release.set()
        receipt = await task
        assert receipt.location_write_accepted is False
        assert h.member["location_pipeline"] == original
        assert_private(await h.view(endpoint))
    run(scenario())


@pytest.mark.parametrize("endpoint", ["single", "list"])
@pytest.mark.parametrize("change", ["off", "off_on", "relink"])
def test_final_response_fence_after_async_geocode(h, endpoint, change):
    async def scenario():
        await h.upload(latitude=LAT)
        h.pause_history("geocode")
        pending = asyncio.create_task(h.view(endpoint))
        await h.admitted(pending)
        if change == "relink":
            h.member["user_id"] = "replacement"
        else:
            await h.sharing(False)
            if change == "off_on":
                await h.sharing(True)
        h.release.set()
        assert_private(await pending)
    run(scenario())


@pytest.mark.parametrize("endpoint", ["single", "list"])
def test_self_identity_is_rechecked_after_async_work(h, endpoint):
    async def scenario():
        await h.upload(latitude=LAT)
        h.pause_history("geocode")
        pending = asyncio.create_task(h.view(endpoint, own=True))
        await h.admitted(pending)
        h.member["user_id"] = "replacement"
        h.release.set()
        assert_private(await pending)
    run(scenario())


@pytest.mark.parametrize("endpoint", ["single", "list"])
def test_family_move_during_read_cannot_return_old_member(h, endpoint):
    async def scenario():
        await h.upload(latitude=LAT)
        h.pause_history("geocode")
        pending = asyncio.create_task(h.view(endpoint))
        await h.admitted(pending)
        h.member["family_group_id"] = "different"
        h.release.set()
        if endpoint == "single":
            with pytest.raises(server.HTTPException) as exc:
                await pending
            assert exc.value.status_code == 404
        else:
            assert await pending == []
    run(scenario())


@pytest.mark.parametrize("flag", [False, None, 0, "false", "missing"])
def test_nonaffirmative_family_authority_is_fail_closed(h, flag):
    async def scenario():
        await h.upload(latitude=LAT)
        h.add_nested_evidence()
        if flag == "missing":
            h.member.pop("location_sharing_enabled")
        else:
            h.member["location_sharing_enabled"] = flag
        assert_private(await h.view("single"))
    run(scenario())


@pytest.mark.parametrize("bad_scope", ["legacy", "foreign_subject", "missing_subject",
                                      "invalid_generation", "boolean_generation"])
def test_unverified_trace_never_inherits_family_authority(h, bad_scope):
    async def scenario():
        await h.upload(latitude=LAT)
        trace = h.member["location_pipeline"]
        if bad_scope == "legacy":
            trace.pop("subject_user_id")
            trace.pop("location_consent_generation")
        elif bad_scope == "foreign_subject":
            trace["subject_user_id"] = "other"
        elif bad_scope == "missing_subject":
            trace.pop("subject_user_id")
        elif bad_scope == "invalid_generation":
            trace["location_consent_generation"] = None
        else:
            trace["location_consent_generation"] = True
            h.member["location_consent_generation"] = 1
        assert (await h.view("single"))[0]["location_pipeline"] is None
        if bad_scope == "legacy":
            await h.sharing(False)
            assert (await h.view("single", own=True))[0]["location_pipeline"]["native_latitude"] == LAT
        if bad_scope == "foreign_subject":
            assert (await h.view("single", own=True))[0]["location_pipeline"] is None
    run(scenario())


@pytest.mark.parametrize("endpoint", ["single", "list"])
def test_unrelated_family_has_no_member_access(h, endpoint):
    async def scenario():
        await h.upload(latitude=LAT)
        requester = {"id": "outsider", "family_group_id": "other"}
        if endpoint == "single":
            with pytest.raises(server.HTTPException) as exc:
                await h.view(endpoint, requester=requester)
            assert exc.value.status_code == 404
        else:
            assert await h.view(endpoint, requester=requester) == []
    run(scenario())


@pytest.mark.parametrize("path", ["/api/members", "/api/members/member"])
def test_member_http_endpoints_require_authentication(h, path):
    response = TestClient(server.app).get(path)  # No lifespan or DB startup.
    assert response.status_code in (401, 403)
    assert not h.db.members.find.called
    assert not h.db.members.find_one.called


def test_owner_assisted_upload_response_does_not_echo_private_retained_pipeline(h):
    async def scenario():
        await h.upload(latitude=LAT)
        await h.sharing(False)
        h.member["owner_id"] = h.family["id"]
        data = server.LocationUpdate(latitude=LAT, longitude=LON)
        response = await server.update_member_location("member", data, h.family)
        assert response.location_write_accepted is False
        assert_private([response.model_dump(mode="json")])
        assert h.member["location_pipeline"]["native_latitude"] == LAT
    run(scenario())


def test_stale_owner_assisted_response_after_accepted_write_is_fenced(h):
    async def scenario():
        h.member["owner_id"] = h.family["id"]
        h.pause_history("insert")  # CAS already accepted; response not yet sent.
        data = server.LocationUpdate(latitude=LAT, longitude=LON,
                                     timestamp=server.datetime.now(server.timezone.utc).isoformat())
        pending = asyncio.create_task(
            server.update_member_location("member", data, h.family)
        )
        await h.admitted(pending)
        assert h.member["location_pipeline"]["native_latitude"] == LAT
        await h.sharing(False)
        h.release.set()
        response = await pending
        assert response.location_write_accepted is True  # Truthful historical CAS result.
        assert_private([response.model_dump(mode="json")])
    run(scenario())
