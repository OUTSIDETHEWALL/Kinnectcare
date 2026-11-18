"""Real three-second transfer/SOS contention; owned loopback replica only."""
import asyncio
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from test_email_links_mongo_integration import (
    APP_NAME, fg, links, local_replica, scenario, snapshot, pytestmark,
)
from test_sos_history_transfer import history
from test_family_write_fence_mongo import sos_endpoint
import family_write_fence as fw
import family_sos_priority as priority


async def request_transfer(s, entry):
    if entry == "email_link":
        return await s.http.post("/api/auth/email-link/join", json=s.payload)
    if entry == "leave":
        return await s.http.post("/api/family-group/leave", headers={"x-test-actor": "invitee"})
    return await s.http.post("/api/family-group/join", headers={"x-test-actor": "invitee"},
                             json={"invite_code": s.invite["token"] if entry == "legacy_invite" else "KINN-TARGET"})


@pytest.mark.asyncio
@pytest.mark.parametrize("entry", ["legacy_invite", "email_link", "family_code", "leave"])
async def test_sos_preempts_transfer_already_holding_fences_for_three_seconds(
    scenario, monkeypatch, entry,
):
    s = scenario
    retained = await history(s)
    await s.db.family_groups.update_one({"id": "target"}, {"$set": {"invite_code": "KINN-TARGET"}})
    entered, never_release = asyncio.Event(), asyncio.Event()
    real = fw.acquire
    held = False

    async def prolonged(tx, families):
        nonlocal held
        await real(tx, families)
        if tx.sos_priority is not None and not held and "solo" in tx.families:
            held = True
            entered.set()
            await never_release.wait()

    monkeypatch.setattr(fw, "acquire", prolonged)
    join_push = AsyncMock()
    monkeypatch.setattr(fg, "notify_family_join", join_push)
    transfer = asyncio.create_task(request_transfer(s, entry))
    trigger, pushes, _, jobs = sos_endpoint(s.db)
    try:
        await asyncio.wait_for(entered.wait(), 3)
        await asyncio.sleep(3.05)
        assert not transfer.done()  # Actual prolonged ownership, not a 30ms pause.
        started = time.monotonic()
        result = await trigger(
            SimpleNamespace(latitude=12.34, longitude=56.78, member_id=None),
            {"id": "invitee", "family_group_id": "solo", "timezone": "UTC", "full_name": "Synthetic"},
        )
        assert result["ok"] is True
        assert time.monotonic() - started < 2
        response = await asyncio.wait_for(transfer, 3)
        assert response.status_code == 409, response.text
        await asyncio.gather(*list(jobs))
        join_push.assert_not_awaited()
        rows = await s.db.alerts.find({"type": "sos", "resolved": False}).to_list(10)
        assert len(rows) == 1
        assert rows[0]["owner_id"] == rows[0]["member_id"] == "invitee"
        assert rows[0]["family_group_id"] == "solo"
        assert "resolved_at" not in rows[0]
        assert (await s.db.users.find_one({"id": "invitee"}))["family_group_id"] == "solo"
        assert (await s.db.family_invites.find_one({"id": "invitation"}))["status"] == "pending"
        assert await s.db.alerts.find_one({"id": retained["id"]}) == retained
        assert pushes.await_count == 2  # One visible SOS and its data-only companion.
        assert sum(bool(call.args[1]) for call in pushes.await_args_list) == 1
        # A transfer retry cannot abandon the newly persisted active incident.
        monkeypatch.setattr(fw, "acquire", real)
        await s.db.family_sos_priority.update_one({"_id": "solo"}, {"$set": {"until": None}})
        retry = await request_transfer(s, entry)
        assert retry.status_code == 409, retry.text
        assert await s.db.alerts.count_documents({"type": "sos", "resolved": False}) == 1
    finally:
        if not transfer.done():
            transfer.cancel()
        await asyncio.gather(transfer, *list(jobs), return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("explicit_subject", [False, True])
async def test_membership_change_between_announcement_and_fence_is_reauthorized(
    scenario, monkeypatch, explicit_subject,
):
    s = scenario
    announced, resume = asyncio.Event(), asyncio.Event()
    real = priority.announce
    calls = []

    async def pause(db, gid):
        await real(db, gid)
        calls.append(gid)
        if len(calls) == 1:
            announced.set()
            await resume.wait()

    monkeypatch.setattr(priority, "announce", pause)
    task = asyncio.create_task(fw.persist_sos(
        s.db, {"id": "emergency", "type": "sos", "resolved": False},
        "invitee", explicit_member_id="self" if explicit_subject else None,
    ))
    try:
        await asyncio.wait_for(announced.wait(), 3)
        # A separate legitimate transfer commits while SOS has not acquired a
        # family fence. Expire the test lease so that transfer can win this order.
        await s.db.family_sos_priority.update_one({"_id": "solo"}, {"$set": {"until": None}})
        joined = await request_transfer(s, "email_link")
        assert joined.status_code == 200, joined.text
        if explicit_subject:
            # Its selected old profile is no longer the subject in this scope.
            await s.db.members.update_one({"id": "self"}, {"$set": {"family_group_id": "unrelated"}})
        resume.set()
        if explicit_subject:
            with pytest.raises(HTTPException) as error:
                await asyncio.wait_for(task, 3)
            assert error.value.status_code == 403
            assert await s.db.alerts.count_documents({"id": "emergency"}) == 0
        else:
            row, actor = await asyncio.wait_for(task, 3)
            assert row["family_group_id"] == actor["family_group_id"] == "target"
            assert calls == ["solo", "target"]
            assert await s.db.alerts.count_documents({"id": "emergency"}) == 1
    finally:
        resume.set()
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["abort", "unknown_commit"])
async def test_sos_internal_retries_persist_one_emergency(scenario, failure):
    s = scenario
    await s.mongo.admin.command({
        "configureFailPoint": "failCommand", "mode": {"times": 1},
        "data": {"failCommands": ["insert" if failure == "abort" else "commitTransaction"],
                 "errorCode": 112 if failure == "abort" else 64,
                 "errorLabels": ["TransientTransactionError" if failure == "abort"
                                 else "UnknownTransactionCommitResult"], "appName": APP_NAME},
    })
    try:
        row, actor = await fw.persist_sos(
            s.db, {"id": "emergency", "type": "sos", "resolved": False}, "invitee",
        )
        assert row["family_group_id"] == actor["family_group_id"] == "solo"
        assert await s.db.alerts.count_documents({"id": "emergency"}) == 1
    finally:
        await s.mongo.admin.command({"configureFailPoint": "failCommand", "mode": "off"})


@pytest.mark.asyncio
async def test_no_emergency_bypass_for_deleted_identity_or_foreign_subject(scenario):
    s = scenario
    for actor, subject, status in [("missing", None, 401), ("invitee", "target-members", 403)]:
        with pytest.raises(HTTPException) as error:
            await fw.persist_sos(s.db, {"id": "denied", "type": "sos"}, actor,
                                 explicit_member_id=subject)
        assert error.value.status_code == status
    assert await s.db.alerts.count_documents({"id": "denied"}) == 0
    assert await s.db.family_sos_priority.count_documents({}) == 0


@pytest.mark.asyncio
async def test_expired_priority_does_not_block_transfer_and_history_stays_unchanged(scenario):
    s = scenario
    retained = await history(s)
    await s.db.family_sos_priority.insert_one({"_id": "solo", "until": None})
    assert (await request_transfer(s, "email_link")).status_code == 200
    assert await s.db.alerts.find_one({"id": retained["id"]}) == retained
    assert (await request_transfer(s, "email_link")).status_code == 200
    assert await s.db.members.count_documents({"user_id": "invitee", "family_group_id": "target"}) == 1


@pytest.mark.asyncio
async def test_destination_priority_response_does_not_disclose_emergency_activity(scenario):
    s = scenario
    await priority.announce(s.db, "target")
    before = await snapshot(s.db)
    response = await request_transfer(s, "legacy_invite")
    assert response.status_code == 409
    assert "sos" not in response.text.lower()
    assert "emergency" not in response.text.lower()
    assert await snapshot(s.db) == before


@pytest.mark.asyncio
async def test_overlapping_emergencies_each_commit_once_without_withdrawing_priority(scenario):
    s = scenario
    results = await asyncio.gather(*[
        fw.persist_sos(s.db, {"id": incident, "type": "sos", "resolved": False}, "invitee")
        for incident in ("emergency-one", "emergency-two")
    ])
    assert all(row["family_group_id"] == actor["family_group_id"] == "solo"
               for row, actor in results)
    for incident in ("emergency-one", "emergency-two"):
        assert await s.db.alerts.count_documents({"id": incident}) == 1
    assert await s.db.family_sos_priority.find_one({
        "_id": "solo", "$expr": {"$gt": ["$until", "$$NOW"]},
    })
    assert (await request_transfer(s, "email_link")).status_code == 409


@pytest.mark.asyncio
async def test_request_cancellation_cleans_up_monitor_and_rolls_back_transfer(scenario, monkeypatch):
    s = scenario
    before = await snapshot(s.db)
    entered = asyncio.Event()
    real = fw.acquire

    async def pause(tx, families):
        await real(tx, families)
        if tx.sos_priority is not None and tx.families:
            entered.set()
            await asyncio.Event().wait()

    monkeypatch.setattr(fw, "acquire", pause)
    task = asyncio.create_task(request_transfer(s, "email_link"))
    try:
        await asyncio.wait_for(entered.wait(), 3)
    finally:
        task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert await snapshot(s.db) == before
    assert not any(
        "TransferPriority.watch" in t.get_coro().__qualname__
        for t in asyncio.all_tasks() if not t.done()
    )
