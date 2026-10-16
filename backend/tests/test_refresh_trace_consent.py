"""Real trace request/upload/preference/read paths; no services or real database."""
import asyncio
import copy
import json
from unittest.mock import AsyncMock, patch

import pytest
from bson.int64 import Int64
from fastapi.testclient import TestClient

from test_location_pipeline_consent import PipelineHarness, LAT, LON, LABEL, MAP
from test_location_consent_write_race import matches, run, server


class TraceHarness(PipelineHarness):
    def __init__(self):
        super().__init__()
        self.user["family_group_id"] = "family"
        self.viewer = {"id": "viewer", "family_group_id": "family"}
        self.users = {"user": self.user, "caregiver": self.family, "viewer": self.viewer}
        self.db.users.find_one = AsyncMock(side_effect=self.find_user)

    async def find_user(self, query, *args, **kwargs):
        await self.barrier("viewer")
        doc = self.users.get(query.get("id"))
        return copy.deepcopy(doc) if doc and matches(doc, query) else None

    async def request(self):
        # Real authenticated request path, no push token -> safe no_tokens status.
        return await server.request_location_refresh("member", current=self.family)

    def read(self, viewer=None, limit=20, member_id=None):
        return server.diagnostics_refresh_traces(
            member_id=member_id, limit=limit, current=viewer or self.viewer,
        )


@pytest.fixture
def h():
    harness = TraceHarness()
    with patch.object(server, "db", harness.db), \
            patch.object(server, "stamp_device_presence", AsyncMock()), \
            patch.object(server.geocoding, "GEOCODE_BACKEND_ENABLED", True), \
            patch.object(server.geocoding, "resolve_location_name", harness.geocode), \
            patch.object(server, "_REFRESH_TRACE_LOG", server._deque(maxlen=200)), \
            patch.object(server, "_REFRESH_PUSH_THROTTLE", {}):
        yield harness


def assert_no_gps(response):
    encoded = json.dumps(response)
    for secret in (str(LAT), str(LON), LABEL, MAP):
        assert secret not in encoded
    for trace in response["traces"]:
        assert trace["gps_lat"] is None and trace["gps_lon"] is None


@pytest.mark.parametrize("viewer", ["viewer", "caregiver"])
def test_real_refresh_upload_withdrawal_preserves_status_not_family_gps(h, viewer):
    async def scenario():
        request = await h.request()
        assert request["sent_to"] == 0
        assert (await h.upload(latitude=LAT)).location_write_accepted is True
        before = await h.read(h.users[viewer])
        assert before["traces"][0]["gps_lat"] == LAT
        original = copy.deepcopy(server._REFRESH_TRACE_LOG[0])
        await h.sharing(False)
        assert h.member["location_consent_generation"] == 1
        response = await h.read(h.users[viewer])
        assert_no_gps(response)
        trace = response["traces"][0]
        assert trace["request_id"] == request["request_id"]
        assert trace["push_skipped_reason"] == "no_tokens"
        assert trace["requested_at"] and trace["gps_received_at"]
        assert trace["gps_received_after_ms"] >= 0
        assert server._REFRESH_TRACE_LOG[0] == original
    run(scenario())


def test_linked_self_not_requester_keeps_own_private_trace(h):
    async def scenario():
        await h.request()
        await h.upload(latitude=LAT)
        await h.sharing(False)
        own = await h.read(h.current)
        assert own["traces"][0]["gps_lat"] == LAT
        h.member["owner_id"] = "caregiver"
        assert_no_gps(await h.read(h.family))
    run(scenario())


@pytest.mark.parametrize("generation", ["missing", Int64(7)])
def test_off_on_old_trace_never_inherits_new_lifetime_fresh_trace_works(h, generation):
    async def scenario():
        if generation == "missing":
            h.member.pop("location_consent_generation")
        else:
            h.member["location_consent_generation"] = generation
        old_request = await h.request()
        await h.upload(latitude=LAT)
        await h.sharing(False)
        await h.sharing(True)
        assert_no_gps(await h.read())
        await h.request()
        await h.upload(latitude=8.0)
        result = await h.read()
        assert result["traces"][0]["gps_lat"] == 8.0
        old = next(t for t in result["traces"] if t["request_id"] == old_request["request_id"])
        assert old["gps_lat"] is None
    run(scenario())


@pytest.mark.parametrize("boundary", ["before_payload", "insert"])
@pytest.mark.parametrize("cycle", [False, True])
def test_real_delayed_gps_recorder_uses_original_upload_authority(h, boundary, cycle):
    async def scenario():
        await h.request()
        h.pause_history(boundary)  # Real await AFTER live CAS, BEFORE trace recorder.
        task = asyncio.create_task(h.upload(latitude=LAT))
        await h.admitted(task)
        assert server._REFRESH_TRACE_LOG[0]["gps_lat"] is None
        await h.sharing(False)
        if cycle:
            await h.sharing(True)
        h.release.set()
        await task
        trace = server._REFRESH_TRACE_LOG[0]
        assert trace["gps_lat"] == LAT  # Retained private evidence, not discarded timing.
        assert trace["gps_consent_generation"] == 0
        assert trace["gps_subject_user_id"] == "user"
        assert_no_gps(await h.read())
        assert (await h.read(h.current))["traces"][0]["gps_lat"] == LAT
    run(scenario())


def test_rejected_live_write_cannot_grant_family_trace_gps(h):
    async def scenario():
        await h.request()
        h.pause()
        pending = asyncio.create_task(h.upload(latitude=LAT))
        await h.admitted(pending)
        await h.sharing(False)
        await h.sharing(True)
        h.release.set()
        assert (await pending).location_write_accepted is False
        assert server._REFRESH_TRACE_LOG[0]["gps_publication_accepted"] is False
        assert_no_gps(await h.read())
        assert (await h.read(h.current))["traces"][0]["gps_lat"] == LAT
    run(scenario())


@pytest.mark.parametrize("viewer", ["viewer", "user"])
def test_unattributed_legacy_gps_is_not_guessed_even_for_requester_or_current_self(h, viewer):
    async def scenario():
        await h.request()
        await h.upload(latitude=LAT)
        trace = server._REFRESH_TRACE_LOG[0]
        for key in list(trace):
            if key.startswith("gps_") and key not in ("gps_received_at", "gps_lat", "gps_lon"):
                trace.pop(key)
        result = await h.read(h.users[viewer])
        assert result["count"] == 1
        assert_no_gps(result)
    run(scenario())


@pytest.mark.parametrize("generation", [None, -1, True, "0"])
def test_invalid_trace_generation_cannot_grant_family_authority(h, generation):
    async def scenario():
        await h.request()
        await h.upload(latitude=LAT)
        server._REFRESH_TRACE_LOG[0]["gps_consent_generation"] = generation
        assert_no_gps(await h.read())
    run(scenario())


@pytest.mark.parametrize("change", ["trace_subject", "member_subject"])
def test_foreign_subject_is_not_owned_by_current_self_or_family(h, change):
    async def scenario():
        await h.request()
        await h.upload(latitude=LAT)
        if change == "trace_subject":
            server._REFRESH_TRACE_LOG[0]["gps_subject_user_id"] = "foreign"
        else:
            h.member["user_id"] = "replacement"
        assert_no_gps(await h.read(h.current))
        assert_no_gps(await h.read())
    run(scenario())


@pytest.mark.parametrize("change", ["off", "off_on", "relink", "member_move", "viewer_move"])
def test_final_reader_boundary_revalidates_current_authority(h, change):
    async def scenario():
        await h.request()
        await h.upload(latitude=LAT)
        h.pause_history("viewer")
        pending = asyncio.create_task(h.read())
        await h.admitted(pending)
        if change in ("off", "off_on"):
            await h.sharing(False)
            if change == "off_on":
                await h.sharing(True)
        elif change == "relink":
            h.member["user_id"] = "replacement"
        elif change == "member_move":
            h.member["family_group_id"] = "different"
        else:
            h.viewer["family_group_id"] = "different"
        h.release.set()
        assert_no_gps(await pending)
    run(scenario())


def test_former_family_requester_retains_safe_status_not_precise_gps(h):
    async def scenario():
        await h.request()
        await h.upload(latitude=LAT)
        stale_principal = dict(h.family)
        h.family["family_group_id"] = "different"
        response = await h.read(stale_principal)
        assert response["count"] == 1
        assert_no_gps(response)
    run(scenario())


def test_unrelated_family_has_no_trace_status(h):
    async def scenario():
        await h.request()
        await h.upload(latitude=LAT)
        assert await h.read({"id": "outsider", "family_group_id": "other"}) == {
            "count": 0, "traces": [],
        }
    run(scenario())


def test_missing_authenticated_identity_is_rejected(h):
    async def scenario():
        with pytest.raises(server.HTTPException) as exc:
            await h.read({"family_group_id": "family"})
        assert exc.value.status_code == 403
    run(scenario())


def test_trace_http_requires_authentication_without_database_startup(h):
    response = TestClient(server.app).get("/api/diagnostics/refresh-traces")
    assert response.status_code in (401, 403)
    assert not h.db.members.find.called


def test_entire_response_excludes_arbitrary_precise_metadata_bags(h):
    async def scenario():
        await h.request()
        await h.upload(latitude=LAT)
        server._REFRESH_TRACE_LOG[0].update(
            position={"latitude": LAT, "longitude": LON}, location_name=LABEL,
            map_url=MAP, native_payload={"stored": [LAT, LON]},
        )
        await h.sharing(False)
        assert_no_gps(await h.read())
        own = (await h.read(h.current))["traces"][0]
        assert own["gps_lat"] == LAT
        assert "position" not in own and "map_url" not in own
    run(scenario())


@pytest.mark.parametrize("limit,expected", [(-1, 1), (2, 2), (200, 100)])
def test_limit_filter_order_and_pending_safe_status_remain_functional(h, limit, expected):
    async def scenario():
        for n in range(105):
            server._trace_record_request("member", "caregiver", f"request-{n}")
        result = await h.read(limit=limit, member_id="member")
        assert result["count"] == expected
        assert result["traces"][0]["request_id"] == "request-104"
        assert result["traces"][0]["gps_received_after_ms"] is None
        assert_no_gps(result)
        assert (await h.read(member_id="unrelated"))["count"] == 0
    run(scenario())


def test_non_sensitive_failure_and_success_timing_are_preserved(h):
    async def scenario():
        await h.request()
        entry = server._REFRESH_TRACE_LOG[0]
        entry["push_skipped_reason"] = "push_error:TimeoutError"
        failed = (await h.read())["traces"][0]
        assert failed["push_skipped_reason"] == "push_error:TimeoutError"
        entry["push_sent_at"] = entry["requested_at"] + 10
        await h.upload(latitude=LAT)
        result = (await h.read())["traces"][0]
        assert result["push_sent_after_ms"] == 10
        assert result["gps_received_at"] is not None
    run(scenario())
