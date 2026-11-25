"""Focused real-endpoint checks; no production database or network."""
import asyncio
import copy
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import pytest

from test_location_history_consent import h  # noqa: F401 -- shared endpoint fixture
from test_location_consent_write_race import run, server


def test_newest_first_backlog_preserves_every_original_fix_without_map_regression(h):
    async def scenario():
        now = datetime.now(timezone.utc)
        fresh = now - timedelta(seconds=1)
        points = [fresh] + [now - timedelta(minutes=n) for n in range(30, 0, -1)]
        # Newest selected first, then arbitrary/backlogged order. Never change
        # the capture timestamp to the upload/receipt time to fake freshness.
        for i, captured in enumerate(points):
            receipt = await h.upload(captured, latitude=10.0 + i / 100)
            assert receipt.location_write_accepted is (i == 0)
            assert h.member["latitude"] == 10.0
            assert h.member["coordinate_captured_at"] == fresh
            assert h.member["captured_at"] == fresh
            assert h.member["location_pipeline"]["native_gps_at"] == server._to_utc_iso(fresh)
        assert len(h.records) == len(points)
        assert [row["captured_at"] for row in h.records] == points
        assert [row["latitude"] for row in h.records] == [
            10.0 + i / 100 for i in range(len(points))
        ]
        assert all(row["historical_only"] for row in h.records[1:])
        assert all(row["accepted_at"] > row["captured_at"] for row in h.records)
        assert all(row["subject_user_id"] == "user" for row in h.records)
        assert all(row["location_consent_generation"] == 0 for row in h.records)
    run(scenario())


def test_oldest_first_legacy_replay_still_retains_history(h):
    async def scenario():
        now = datetime.now(timezone.utc)
        for captured in [now - timedelta(minutes=20), now - timedelta(minutes=10), now]:
            await h.upload(captured)
        assert len(h.records) == 3
        assert h.member["coordinate_captured_at"] == now
        assert [r["coord_suppressed"] for r in h.records] == [True, True, False]
    run(scenario())


def test_concurrent_old_upload_cannot_regress_new_fix_or_lose_its_history(h):
    async def scenario():
        now = datetime.now(timezone.utc)
        old = now - timedelta(minutes=2)
        h.pause()
        pending = asyncio.create_task(h.upload(old, latitude=20))
        await h.admitted(pending)
        assert (await h.upload(now, latitude=30)).location_write_accepted
        h.release.set()
        assert (await pending).location_write_accepted is False
        assert h.member["latitude"] == 30
        assert h.member["coordinate_captured_at"] == now
        assert {r["captured_at"] for r in h.records} == {old, now}
    run(scenario())


def test_equal_capture_time_keeps_current_coordinates_and_original_history(h):
    async def scenario():
        captured = datetime.now(timezone.utc) - timedelta(seconds=1)
        await h.upload(captured, latitude=20)
        assert not (await h.upload(captured, latitude=30)).location_write_accepted
        assert h.member["latitude"] == 20
        assert len(h.records) == 2
        assert all(r["captured_at"] == captured for r in h.records)
        assert h.records[1]["latitude"] == 30
    run(scenario())


@pytest.mark.parametrize("timestamp", [None, "future"])
def test_unknown_or_invalid_clock_does_not_gain_historical_retention(h, timestamp):
    async def scenario():
        await h.upload()
        captured = (datetime.now(timezone.utc) + timedelta(hours=1)
                    if timestamp == "future" else None)
        result = await h.upload(captured)
        assert result.location_write_accepted is False
        assert len(h.records) == 1
    run(scenario())


@pytest.mark.parametrize("revocation", ["off", "cycled", "relinked", "moved"])
def test_backlog_does_not_bypass_consent_or_ownership(h, revocation):
    async def scenario():
        now = datetime.now(timezone.utc)
        await h.upload(now)
        old_generation = h.member["location_consent_generation"]
        if revocation == "off":
            await h.sharing(False)
        elif revocation == "cycled":
            await h.sharing(False)
            await h.sharing(True)
        elif revocation == "relinked":
            h.member["user_id"] = "replacement"
        else:
            h.member["family_group_id"] = "different-family"
        payload = server.LocationUpdate(
            latitude=20, longitude=21, timestamp=(now - timedelta(minutes=10)).isoformat(),
            consent_generation=old_generation,
        )
        try:
            result = await server.update_member_location("member", payload, h.current)
            assert result.location_write_accepted is False
        except server.HTTPException as error:
            assert error.status_code in (403, 404)
        assert len(h.records) == 1
    run(scenario())


def test_history_failure_returns_retryable_response_and_retry_retains_fix(h):
    async def scenario():
        captured = datetime.now(timezone.utc) - timedelta(seconds=1)
        insert = h.db.location_history.insert_one
        insert.side_effect = RuntimeError("offline test failure")
        with pytest.raises(server.HTTPException) as failure:
            await h.upload(captured)
        assert failure.value.status_code == 503
        # Current tuple committed before the history failure; a retry is now
        # out of order/equal but must still preserve that original history.
        before = copy.deepcopy(h.member)
        insert.side_effect = h.insert_history
        result = await h.upload(captured)
        assert result.location_write_accepted is False
        assert len(h.records) == 1
        assert h.records[0]["captured_at"] == captured
        assert h.member["coordinate_captured_at"] == before["coordinate_captured_at"]
    run(scenario())


def test_old_battery_cannot_overwrite_current_battery_during_history_replay(h):
    async def scenario():
        now = datetime.now(timezone.utc)
        await h.upload(now)
        h.member.update(battery_level=0.8, battery_updated_at=now, is_charging=True)
        h.db.members.find_one_and_update = AsyncMock(return_value=None)
        payload = server.LocationUpdate(
            latitude=20, longitude=21,
            timestamp=(now - timedelta(minutes=20)).isoformat(),
            consent_generation=0, battery_level=0.1, is_charging=False,
        )
        await server.update_member_location("member", payload, h.current)
        assert h.member["battery_level"] == 0.8
        assert h.member["is_charging"] is True
        assert len(h.records) == 2
    run(scenario())
