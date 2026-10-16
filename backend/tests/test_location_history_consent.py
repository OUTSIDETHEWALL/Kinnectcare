"""Actual upload/preference/history endpoints; no external services or database."""
import ast
import asyncio
import copy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from bson.int64 import Int64
from fastapi.testclient import TestClient

from test_location_consent_write_race import Harness, matches, run, server


class HistoryHarness(Harness):
    def __init__(self):
        super().__init__()
        self.records = []
        self.boundary = None
        self.db.location_history.insert_one = AsyncMock(side_effect=self.insert_history)
        self.db.location_history.find = MagicMock(side_effect=self.find_history)
        self.db.location_ingest_log.insert_one = AsyncMock(side_effect=self.ingest)

    def pause_history(self, boundary):
        self.boundary = boundary
        self.entered, self.release = asyncio.Event(), asyncio.Event()

    async def barrier(self, boundary):
        if self.boundary == boundary:
            self.boundary = None
            self.entered.set()
            await self.release.wait()

    async def ingest(self, doc):
        await self.barrier("before_payload")

    async def insert_history(self, doc):
        await self.barrier("insert")
        self.records.append(copy.deepcopy(doc))

    def find_history(self, query, projection, sort, limit):
        assert sort == [("accepted_at", -1)] and projection == {"_id": 0}
        docs = sorted(
            [copy.deepcopy(doc) for doc in self.records if matches(doc, query)],
            key=lambda doc: doc["accepted_at"], reverse=True,
        )[:limit]

        async def to_list(length):
            assert length == limit
            await self.barrier("read")
            return docs
        return SimpleNamespace(to_list=to_list)

    def history(self, own=False, limit=50, requester=None):
        requester = requester or (
            self.current if own else {"id": "caregiver", "family_group_id": "family",
                                      "family_group_role": "owner"}
        )
        return server.get_location_history("member", limit=limit, current=requester)


@pytest.fixture
def h():
    harness = HistoryHarness()
    with patch.object(server, "db", harness.db), \
            patch.object(server, "stamp_device_presence", AsyncMock()), \
            patch.object(server, "_trace_record_gps"), \
            patch.object(server.geocoding, "GEOCODE_BACKEND_ENABLED", True):
        yield harness


def test_existing_history_on_then_off_is_private_to_linked_self(h):
    async def scenario():
        await h.upload()
        public = await h.history()
        assert len(public) == 1
        assert (public[0]["latitude"], public[0]["longitude"]) == (3.0, 4.0)
        before = copy.deepcopy(h.records)
        await h.sharing(False)
        h.assert_cleared()
        assert await h.history() == []
        own = await h.history(own=True)
        assert (own[0]["latitude"], own[0]["longitude"]) == (3.0, 4.0)
        assert h.records == before  # Access control, not deletion or TTL reset.
    run(scenario())


@pytest.mark.parametrize("boundary", ["before_payload", "insert"])
@pytest.mark.parametrize("generation", [None, 0, 7])
def test_withdrawal_at_history_persistence_cannot_publish_to_family(h, boundary, generation):
    async def scenario():
        if generation is None:
            h.member.pop("location_consent_generation")
        else:
            h.member["location_consent_generation"] = generation
        h.pause_history(boundary)
        task = asyncio.create_task(h.upload())
        await h.admitted(task)
        assert h.member["latitude"] == 3.0  # Live CAS accepted before withdrawal.
        assert not h.records
        await h.sharing(False)
        h.assert_cleared()
        assert h.member["location_consent_generation"] == (generation or 0) + 1
        h.release.set()
        await task
        h.assert_cleared()
        assert len(h.records) == 1  # Retained private evidence, never newer authority.
        assert h.records[0]["location_consent_generation"] == (generation or 0)
        assert h.records[0]["subject_user_id"] == "user"
        assert await h.history() == []
        assert (await h.history(own=True))[0]["latitude"] == 3.0
    run(scenario())


@pytest.mark.parametrize("toggles", [[False, True], [False, True, False]])
def test_old_insert_cannot_inherit_reenabled_consent(h, toggles):
    async def scenario():
        h.pause_history("insert")
        task = asyncio.create_task(h.upload())
        await h.admitted(task)
        for enabled in toggles:
            await h.sharing(enabled)
        h.release.set()
        await task
        assert h.records[0]["location_consent_generation"] == 0
        assert await h.history() == []
        if not toggles[-1]:
            await h.sharing(True)
        current_generation = h.member["location_consent_generation"]
        await h.upload(latitude=8.0)
        family = await h.history()
        assert len(family) == 1 and family[0]["latitude"] == 8.0
        assert family[0]["location_consent_generation"] == current_generation
        assert len(await h.history(own=True)) == 2
    run(scenario())


@pytest.mark.parametrize("change", ["off", "off_on", "relink", "family_move"])
def test_history_read_revalidates_after_async_fetch(h, change):
    async def scenario():
        await h.upload()
        h.pause_history("read")
        task = asyncio.create_task(h.history())
        await h.admitted(task)
        if change == "off":
            await h.sharing(False)
        elif change == "off_on":
            await h.sharing(False)
            await h.sharing(True)
        elif change == "relink":
            h.member["user_id"] = "replacement"
        else:
            h.member["family_group_id"] = "other"
        h.release.set()
        assert await task == []
    run(scenario())


@pytest.mark.parametrize("change", ["relink", "family_move"])
def test_self_diagnostic_read_also_requires_final_linked_identity(h, change):
    async def scenario():
        await h.upload()
        h.pause_history("read")
        task = asyncio.create_task(h.history(own=True))
        await h.admitted(task)
        h.member["user_id" if change == "relink" else "family_group_id"] = "replacement"
        h.release.set()
        assert await task == []
    run(scenario())


@pytest.mark.parametrize("flag", [False, None, 0, "false", "missing"])
def test_nonaffirmative_family_access_returns_no_metadata(h, flag):
    async def scenario():
        await h.upload()
        h.records[0].update(location_name="Private place", map_url="private-map",
                            position={"lat": 3.0, "lng": 4.0})
        if flag == "missing":
            h.member.pop("location_sharing_enabled")
        else:
            h.member["location_sharing_enabled"] = flag
        h.member["owner_id"] = "caregiver"  # Creator/group owner is still NOT self.
        assert await h.history() == []
    run(scenario())


@pytest.mark.parametrize("generation", [None, -1, True, "0"])
def test_unverified_generation_fails_closed_for_family(h, generation):
    async def scenario():
        await h.upload()
        h.member["location_consent_generation"] = generation
        assert await h.history() == []
    run(scenario())


def test_valid_bson_int64_generation_retains_normal_family_access(h):
    async def scenario():
        h.member["location_consent_generation"] = Int64(7)
        await h.upload()
        assert [doc["latitude"] for doc in await h.history()] == [3.0]
    run(scenario())


def test_legacy_history_stays_self_only_and_foreign_subject_is_not_self(h):
    async def scenario():
        await h.upload()
        legacy = copy.deepcopy(h.records[0])
        legacy.pop("location_consent_generation")
        legacy.pop("subject_user_id")
        legacy["latitude"] = 5.0
        foreign = {**h.records[0], "subject_user_id": "other", "latitude": 6.0}
        h.records += [legacy, foreign]
        assert [doc["latitude"] for doc in await h.history()] == [3.0]
        await h.sharing(False)
        assert await h.history() == []
        assert [doc["latitude"] for doc in await h.history(own=True)] == [3.0, 5.0]
    run(scenario())


def test_unrelated_family_and_missing_identity_are_denied(h):
    async def scenario():
        await h.upload()
        with pytest.raises(server.HTTPException) as exc:
            await h.history(requester={"id": "outsider", "family_group_id": "other"})
        assert exc.value.status_code == 404
        with pytest.raises(server.HTTPException) as exc:
            await h.history(requester={"family_group_id": "family"})
        assert exc.value.status_code == 403
    run(scenario())


def test_no_token_http_request_is_denied_without_reading_history(h):
    client = TestClient(server.app)  # No context manager: no startup/database routines.
    response = client.get("/api/members/member/location-history")
    assert response.status_code in (401, 403)
    assert not h.db.location_history.find.called


def test_rejected_live_upload_never_creates_history(h):
    async def scenario():
        h.pause()
        task = asyncio.create_task(h.upload())
        await h.admitted(task)
        await h.sharing(False)
        h.release.set()
        assert (await task).location_write_accepted is False
        assert h.records == []
        assert await h.history() == []
    run(scenario())


@pytest.mark.parametrize("limit,expected", [(0, 1), (50, 50), (200, 100)])
def test_limit_order_serialization_and_retention_not_changed(h, limit, expected):
    async def scenario():
        await h.upload()
        original = copy.deepcopy(h.records[0])
        h.records = [
            {**original, "accepted_at": original["accepted_at"] - timedelta(seconds=n)}
            for n in range(105)
        ]
        before = copy.deepcopy(h.records)
        response = await h.history(limit=limit)
        assert len(response) == expected
        assert response[0]["accepted_at"] == original["accepted_at"].isoformat().replace("+00:00", "Z")
        assert h.records == before
        assert not h.db.location_history.update_one.called
        # Static configured TTL check, not a claim about a real database index.
        tree = ast.parse(Path(server.__file__).read_text())
        ttl = [
            node for node in ast.walk(tree) if isinstance(node, ast.Tuple)
            and len(node.elts) == 4 and isinstance(node.elts[0], ast.Constant)
            and node.elts[0].value == "location_history"
        ]
        assert len(ttl) == 1
        assert ttl[0].elts[1].value == "accepted_at"
        assert ast.unparse(ttl[0].elts[2]) == "7 * 86400"
    run(scenario())
