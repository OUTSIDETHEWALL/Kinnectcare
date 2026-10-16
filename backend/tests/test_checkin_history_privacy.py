"""Legacy production writer -> real withdrawal -> actual family history readers.

Offline predicate-enforcing collections; no production/real MongoDB access.
The pinned writer fixture avoids requiring git history in test distributions.
"""
import ast
import copy
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from test_checkin_location_consent import CheckinHarness
from test_location_consent_write_race import run, server


PRIVATE = {
    "latitude": 33.448381,
    "longitude": -112.074037,
    "location_name": "Precise test apartment 417",
}
SAFE_KEYS = {
    "id", "owner_id", "family_group_id", "member_id", "member_name",
    "confirmed_by", "source", "created_at",
}
RECEIPT_KEYS = SAFE_KEYS | {"latitude", "longitude", "location_name"}
READERS = ("member", "recent")


def matches(doc, query):
    for key, value in query.items():
        if isinstance(value, dict):
            assert set(value) == {"$gte"}
            if doc.get(key) is None or doc[key] < value["$gte"]:
                return False
        elif doc.get(key) != value:
            return False
    return True


class HistoryHarness(CheckinHarness):
    def __init__(self):
        super().__init__()
        self.current["timezone"] = "UTC"
        self.family = {
            "id": "caregiver", "family_group_id": "family",
            "family_group_role": "owner", "timezone": "UTC",
        }
        self.db.checkins.find = MagicMock(side_effect=self.find_history)
        tree = ast.parse(
            Path(__file__).with_name("fixtures").joinpath(
                "legacy_create_checkin.py.txt",
            ).read_text()
        )
        writer = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef))
        namespace = dict(vars(server))
        exec(compile(ast.Module(body=[writer], type_ignores=[]),
                     "<pinned-supplied-base-checkin-writer>", "exec"), namespace)
        self.legacy_writer = namespace["create_checkin"]

    def find_history(self, query, projection):
        assert projection == {"_id": 0}
        docs = [copy.deepcopy(d) for d in self.checkins.values()
                if matches(d, query)]

        def sort(field, direction):
            assert (field, direction) == ("created_at", -1)
            docs.sort(key=lambda d: d[field], reverse=True)
            return SimpleNamespace(to_list=to_list)

        async def to_list(limit):
            assert limit in (100, 200)
            return docs[:limit]

        return SimpleNamespace(sort=sort)

    def legacy(self):
        return self.legacy_writer(server.CheckInCreate(
            member_id="member", **PRIVATE,
        ), self.current)

    async def read(self, reader, viewer=None):
        viewer = viewer or self.family
        receipts = (
            await server.list_member_checkins("member", viewer)
            if reader == "member" else await server.list_recent_checkins(viewer)
        )
        return [r.model_dump(mode="json") for r in receipts]


@pytest.fixture
def h():
    harness = HistoryHarness()
    with patch.object(server, "db", harness.db), \
            patch.object(server, "push_to_family_group", harness.push), \
            patch.object(server, "deliver_welfare_response_notification", harness.delivery):
        # The historical function has its own isolated globals.
        harness.legacy_writer.__globals__.update(
            db=harness.db, push_to_family_group=harness.push,
        )
        yield harness


def assert_safe(rows, original):
    assert len(rows) == 1
    row = rows[0]
    assert set(row) == RECEIPT_KEYS
    assert {k: row[k] for k in SAFE_KEYS} == {
        k: server.CheckIn(**original).model_dump(mode="json")[k]
        for k in SAFE_KEYS
    }
    assert all(row[key] is None for key in PRIVATE)
    encoded = json.dumps(rows)
    assert all(str(value) not in encoded for value in PRIVATE.values())
    return row


@pytest.mark.parametrize("reader", READERS)
def test_real_legacy_writer_then_real_withdrawal_preserves_only_safe_history(h, reader):
    async def scenario():
        receipt = await h.legacy()
        original = copy.deepcopy(h.checkins[receipt.id])
        assert {k: original[k] for k in PRIVATE} == PRIVATE
        await h.sharing(False)
        h.assert_cleared()
        assert_safe(await h.read(reader), original)
        assert h.checkins[receipt.id] == original
        h.db.checkins.update_one.assert_not_called()
        h.db.checkins.delete_many.assert_not_called()
    run(scenario())


@pytest.mark.parametrize("reader", READERS)
@pytest.mark.parametrize("toggles", [[], [False], [False, True], [False, True, False]])
def test_legacy_gps_never_inherits_current_or_reenabled_family_consent(h, reader, toggles):
    async def scenario():
        receipt = await h.legacy()
        original = copy.deepcopy(h.checkins[receipt.id])
        assert "location_consent_generation" not in original
        for enabled in toggles:
            await h.sharing(enabled)
        assert h.member["location_consent_generation"] == len(toggles)
        assert_safe(await h.read(reader), original)
        assert h.checkins[receipt.id] == original
    run(scenario())


def test_both_readers_agree_for_same_legacy_receipt_after_withdrawal(h):
    async def scenario():
        receipt = await h.legacy()
        await h.sharing(False)
        member = await h.read("member")
        recent = await h.read("recent")
        assert member == recent
        assert_safe(member, h.checkins[receipt.id])
    run(scenario())


@pytest.mark.parametrize("reader", READERS)
@pytest.mark.parametrize("identity", ["linked_self", "caregiver", "creator", "owner", "family"])
def test_no_private_self_or_privileged_family_location_exception(h, reader, identity):
    async def scenario():
        receipt = await h.legacy()
        await h.sharing(False)
        viewer = h.current if identity == "linked_self" else {
            "id": identity, "family_group_id": "family", "timezone": "UTC",
            "family_group_role": "owner" if identity in {"owner", "caregiver"} else "member",
        }
        assert_safe(await h.read(reader, viewer), h.checkins[receipt.id])
    run(scenario())


@pytest.mark.parametrize("reader", READERS)
@pytest.mark.parametrize("kind", ["daily", "welfare", "adapter"])
def test_current_daily_and_welfare_receipts_keep_event_time_source_confirmation(h, reader, kind):
    async def scenario():
        await h.sharing(False)
        receipt = await h.submit(kind)
        original = copy.deepcopy(next(
            d for d in h.checkins.values() if d["id"] == receipt.id
        ))
        row = assert_safe(await h.read(reader), original)
        assert row["source"] == ("self" if kind == "daily" else "request_response")
        assert row["confirmed_by"] == h.member["name"]
        assert row["created_at"]
        assert next(d for d in h.checkins.values() if d["id"] == receipt.id) == original
    run(scenario())


@pytest.mark.parametrize("reader", READERS)
def test_complete_serialization_drops_coordinate_aliases_maps_and_nested_extras(h, reader):
    async def scenario():
        receipt = await h.legacy()
        h.checkins[receipt.id].update(
            lat=PRIVATE["latitude"], lon=PRIVATE["longitude"],
            map_url="https://maps.example/?q=33.448381,-112.074037",
            address=PRIVATE["location_name"],
            coordinates=[PRIVATE["longitude"], PRIVATE["latitude"]],
            gps={"native": {"provider": {"coords": PRIVATE}}},
            metadata={"location": PRIVATE, "map": "geo:33.448381,-112.074037"},
            location_consent_generation=999,
        )
        original = copy.deepcopy(h.checkins[receipt.id])
        await h.sharing(False)
        assert_safe(await h.read(reader), original)
        assert h.checkins[receipt.id] == original
    run(scenario())


@pytest.mark.parametrize("reader", READERS)
def test_unrelated_family_cannot_read_target_receipts(h, reader):
    async def scenario():
        await h.legacy()
        assert await h.read(reader, {
            "id": "outsider", "family_group_id": "other", "timezone": "UTC",
        }) == []
    run(scenario())


@pytest.mark.parametrize("path", ["/api/checkins/member/member", "/api/checkins/recent"])
def test_http_authentication_required_before_history_read(h, path):
    response = TestClient(server.app).get(path)
    assert response.status_code in (401, 403)
    h.db.checkins.find.assert_not_called()


@pytest.mark.parametrize("path", ["/api/checkins/member/member", "/api/checkins/recent"])
def test_actual_http_serialization_is_safe_for_legacy_records(h, path):
    async def prepare():
        receipt = await h.legacy()
        await h.sharing(False)
        return copy.deepcopy(h.checkins[receipt.id])
    original = run(prepare())
    with patch.dict(server.app.dependency_overrides, {
        server.get_current_user: lambda: h.family,
    }):
        response = TestClient(server.app).get(path)
    assert response.status_code == 200
    assert_safe(response.json(), original)


@pytest.mark.parametrize("reader,limit", [("member", 100), ("recent", 200)])
def test_history_order_limits_and_storage_unchanged(h, reader, limit):
    async def scenario():
        receipt = await h.legacy()
        original = copy.deepcopy(h.checkins[receipt.id])
        # Distinct, same-day samples exercise ordering without crossing midnight.
        anchor = original["created_at"].replace(hour=12, minute=0, second=0, microsecond=0)
        for n in range(210):
            h.checkins[str(n)] = {
                **original, "id": str(n),
                "created_at": anchor - timedelta(seconds=n),
            }
        before = copy.deepcopy(h.checkins)
        rows = await h.read(reader)
        assert len(rows) == limit
        assert rows == sorted(rows, key=lambda row: row["created_at"], reverse=True)
        assert h.checkins == before
        h.db.checkins.update_one.assert_not_called()
        h.db.checkins.delete_many.assert_not_called()
    run(scenario())


def test_recent_reader_preserves_local_day_filter(h):
    async def scenario():
        receipt = await h.legacy()
        h.checkins["old"] = {
            **copy.deepcopy(h.checkins[receipt.id]), "id": "old",
            "created_at": datetime.now(timezone.utc) - timedelta(days=1),
        }
        assert len(await h.read("member")) == 2
        assert [row["id"] for row in await h.read("recent")] == [receipt.id]
    run(scenario())
