"""Real Mongo TTL and reopen races: owned loopback database, never live data."""
import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from test_email_links_mongo_integration import local_replica, scenario, pytestmark
from test_family_code_rotation import loopback_only
from account_deletion_support import account_client, delete, pause_first_commit
import family_write_fence as fw

TTL_SECONDS = 30 * 86400


async def ttl_index(s):
    # Only the mongod created by local_replica can be addressed here.
    assert s.mongo.address[0] == "127.0.0.1"
    await s.mongo.admin.command({"setParameter": 1, "ttlMonitorSleepSecs": 1})
    await s.db.alerts.create_index(
        [("resolved_at", 1)], name="ttl_resolved_at", expireAfterSeconds=TTL_SECONDS,
        partialFilterExpression={"resolved_at": {"$exists": True}},
    )


async def wait_for(predicate, seconds=8):
    async with asyncio.timeout(seconds):
        while not await predicate():
            await asyncio.sleep(0.05)


@pytest.mark.asyncio
async def test_real_ttl_expires_old_resolved_not_young_or_active_or_undated_legacy(scenario):
    s = scenario
    await ttl_index(s)
    now = datetime.now(timezone.utc)
    rows = [
        {"id": "expired", "type": "sos", "resolved": True, "resolved_at": now - timedelta(days=30, seconds=2)},
        {"id": "not-yet", "type": "sos", "resolved": True, "resolved_at": now - timedelta(days=29, hours=23, minutes=58)},
        {"id": "active", "type": "sos", "resolved": False},
        {"id": "unresolved-missing", "type": "sos"},
        {"id": "legacy-undated", "type": "sos", "resolved": True},
        {"id": "legacy-invalid-date", "type": "sos", "resolved": True, "resolved_at": "not-a-date"},
    ]
    await s.db.alerts.insert_many(rows)
    async def expired():
        return not await s.db.alerts.find_one({"id": "expired"})
    await wait_for(expired)
    for row in rows[1:]:
        assert await s.db.alerts.find_one({"id": row["id"]})
    # Undated/malformed historical resolutions need reviewed dating, not an
    # invented original timestamp or a false claim that this TTL can expire them.
    assert await s.db.alerts.count_documents({"id": {"$in": ["legacy-undated", "legacy-invalid-date"]}}) == 2


@pytest.mark.asyncio
async def test_exact_threshold_selector_and_acknowledgment_do_not_reset_clock(scenario):
    s = scenario
    now = datetime.now(timezone.utc).replace(microsecond=0)
    boundary = now - timedelta(days=30)
    for name, stamp in (("before", boundary - timedelta(milliseconds=1)),
                        ("equal", boundary), ("after", boundary + timedelta(milliseconds=1))):
        await s.db.alerts.insert_one({
            "id": name, "type": "sos", "resolved": True, "resolved_at": stamp,
            "owner_id": "invitee", "member_id": "self", "family_group_id": "solo",
        })
    assert set(r["id"] for r in await s.db.alerts.find({
        "resolved_at": {"$type": "date", "$lte": boundary},
    }).to_list(10)) == {"before", "equal"}
    before = await s.db.alerts.find_one({"id": "after"})
    from sos_history import acknowledge_in_family
    await acknowledge_in_family(s.db, "invitee", "solo", "after")
    after = await s.db.alerts.find_one({"id": "after"})
    assert after["acknowledged"] is True
    assert after["resolved_at"] == before["resolved_at"]


@pytest.mark.parametrize("first", ["reopen", "cleanup"])
@pytest.mark.asyncio
async def test_reopen_and_expiration_cleanup_cannot_delete_a_committed_active_incident(scenario, monkeypatch, first):
    s = scenario
    old = datetime.now(timezone.utc) - timedelta(days=31)
    await s.db.alerts.insert_one({
        "id": "race", "type": "sos", "resolved": True, "resolved_at": old,
        "owner_id": "invitee", "member_id": "self", "family_group_id": "solo",
    })
    held, release = pause_first_commit(monkeypatch)
    async def reopen():
        try:
            return await fw.change_sos_resolution(s.db, "solo", "race", "invitee", {"resolved": False})
        except HTTPException as error:
            assert error.status_code == 404  # Already-expired history is not resurrected.
            return None
    async def cleanup():
        async def action(tx):
            return await tx.alerts.delete_one({
                "id": "race", "resolved_at": {"$lte": datetime.now(timezone.utc) - timedelta(days=30)},
            })
        return await fw.run(s.db, [], action)
    tasks = {"reopen": reopen, "cleanup": cleanup}
    a = asyncio.create_task(tasks[first]())
    await asyncio.wait_for(held.wait(), 3)
    b = asyncio.create_task(tasks["cleanup" if first == "reopen" else "reopen"]())
    try:
        await asyncio.sleep(0.03)
    finally:
        release.set()
    await asyncio.gather(a, b)
    stored = await s.db.alerts.find_one({"id": "race"})
    if first == "reopen":
        assert stored["resolved"] is False
        assert "resolved_at" not in stored
    else:
        assert stored is None


@pytest.mark.asyncio
async def test_real_ttl_keeps_reopened_incident_while_expiring_comparison_record(scenario):
    s = scenario
    old = datetime.now(timezone.utc) - timedelta(days=31)
    await s.db.alerts.insert_one({
        "id": "reopened", "type": "sos", "resolved": True, "resolved_at": old,
        "owner_id": "invitee", "member_id": "self", "family_group_id": "solo",
    })
    await fw.change_sos_resolution(s.db, "solo", "reopened", "invitee", {"resolved": False})
    await ttl_index(s)
    await s.db.alerts.insert_one({"id": "control", "type": "sos", "resolved": True, "resolved_at": old})
    async def swept():
        return not await s.db.alerts.find_one({"id": "control"})
    await wait_for(swept)
    active = await s.db.alerts.find_one({"id": "reopened"})
    assert active["resolved"] is False and "resolved_at" not in active


@pytest.mark.asyncio
async def test_successful_account_deletion_preserves_sos_expiry_without_rehoming_history(scenario):
    s = scenario
    old = datetime.now(timezone.utc) - timedelta(days=31)
    await s.db.alerts.insert_one({
        "id": "retained", "type": "sos", "resolved": True, "resolved_at": old,
        "owner_id": "invitee", "member_id": "self", "family_group_id": "solo",
    })
    original = await s.db.alerts.find_one({"id": "retained"})
    async with account_client(s) as client:
        response = await delete(client.http)
        assert response.status_code == 200, response.text
    assert await s.db.alerts.find_one({"id": "retained"}) == original
    await ttl_index(s)
    async def expired():
        return not await s.db.alerts.find_one({"id": "retained"})
    await wait_for(expired)
    assert not await s.db.alerts.find_one({"id": "retained", "family_group_id": "target"})
