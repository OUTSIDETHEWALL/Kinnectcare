"""Real transfer routes with controlled wire latency on an owned local replica.

Never reads a production URI. The listener delays actual transaction commands
in Motor's worker, not the ASGI loop, and records command names only.
"""
import asyncio
import time
from collections import Counter
from contextlib import asynccontextmanager

import httpx
import pytest
from fastapi import FastAPI, HTTPException, Request
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo.monitoring import CommandListener

from test_email_links_mongo_integration import (
    APP_NAME, fg, links, local_replica, scenario, snapshot, pytestmark,
)
from test_sos_history_transfer import history
import family_write_fence as fw


class TransferLatency(CommandListener):
    """Model many modest round trips, not a single stuck query."""
    def __init__(self):
        self.commands = []

    def started(self, event):
        if event.command.get("autocommit") is False:
            self.commands.append(event.command_name)
            time.sleep(.035)

    def succeeded(self, event):
        pass

    def failed(self, event):
        pass


@asynccontextmanager
async def delayed_routes(s, local_replica, monkeypatch):
    assert local_replica.startswith("mongodb://127.0.0.1:")
    latency = TransferLatency()
    client = AsyncIOMotorClient(
        local_replica, appname=APP_NAME, event_listeners=[latency],
        serverSelectionTimeoutMS=5000,
    )
    db = client[s.db.name]
    deliveries = []

    async def actor(request: Request):
        return await db.users.find_one({"id": "invitee"})

    async def no_email(*args, **kwargs):
        raise AssertionError("A signed-in transfer must not send an authentication email")

    async def after_commit(*args, **kwargs):
        # External delivery must never execute in a transaction or on timeout.
        user = await s.db.users.find_one({"id": "invitee"})
        invite = await s.db.family_invites.find_one({"id": "invitation"})
        assert user["family_group_id"] == "target"
        assert invite["status"] == "accepted"
        deliveries.append("committed")

    monkeypatch.setattr(fg, "notify_family_join", after_commit)
    app = FastAPI()
    app.include_router(links.build_router(
        db, actor, no_email, lambda uid: "synthetic-session",
        lambda user: {k: v for k, v in user.items() if k != "_id"},
    ), prefix="/api")
    app.include_router(fg.build_router(db, actor), prefix="/api")
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
            base_url="https://test.invalid",
        ) as http:
            yield http, db, latency, deliveries
    finally:
        client.close()


async def request_transfer(http, s, entry):
    if entry == "email_link":
        return await http.post("/api/auth/email-link/join", json=s.payload)
    if entry == "leave":
        return await http.post("/api/family-group/leave")
    return await http.post("/api/family-group/join", json={
        "invite_code": s.invite["token"] if entry == "legacy_invite" else "KINN-TARGET",
    })


@pytest.mark.asyncio
@pytest.mark.parametrize("entry", ["legacy_invite", "email_link", "family_code", "leave"])
async def test_real_transfer_survives_accumulated_round_trips(
    scenario, local_replica, monkeypatch, entry,
):
    s = scenario
    retained = await history(s)
    await s.db.family_groups.update_one(
        {"id": "target"}, {"$set": {"invite_code": "KINN-TARGET"}},
    )
    async with delayed_routes(s, local_replica, monkeypatch) as (http, db, latency, deliveries):
        started = time.monotonic()
        response = await request_transfer(http, s, entry)
        elapsed = time.monotonic() - started
        print("LOCAL_TRANSFER_TIMING", entry, round(elapsed, 3), dict(Counter(latency.commands)))
        assert response.status_code == 200, response.text
        assert elapsed > 1.0  # Regression: the former whole-transaction limit.
        assert latency.commands.count("commitTransaction") == 1
        user = await db.users.find_one({"id": "invitee"})
        destination = user["family_group_id"]
        assert destination not in ("solo", "unrelated")
        assert (destination == "target") is (entry != "leave")
        assert await db.members.count_documents({
            "id": "self", "user_id": "invitee", "family_group_id": destination,
        }) == 1
        for collection in ("reminders", "alerts", "checkins", "medication_logs"):
            assert (await db[collection].find_one({"id": collection}))["family_group_id"] == destination
        invite = await db.family_invites.find_one({"id": "invitation"})
        assert invite["status"] == ("accepted" if entry in ("legacy_invite", "email_link") else "pending")
        # The old solo group remains as the immutable scope of resolved SOS.
        assert await db.alerts.find_one({"id": retained["id"]}) == retained
        assert (await db.users.find_one({"id": "owner"}))["family_group_id"] == "target"
        assert len(deliveries) == (1 if entry == "legacy_invite" else 0)
        if entry != "leave":
            retry = await request_transfer(http, s, entry)
            assert retry.status_code == 200, retry.text
            assert await db.members.count_documents({"user_id": "invitee", "family_group_id": destination}) == 1
            assert len(deliveries) == (1 if entry == "legacy_invite" else 0)
            assert await db.alerts.find_one({"id": retained["id"]}) == retained


@pytest.mark.asyncio
@pytest.mark.parametrize("entry", ["legacy_invite", "email_link"])
@pytest.mark.parametrize("blocker,status", [
    ("active_sos", 409), ("dependent", 409), ("wrong_email", 403), ("revoked_invite", 410),
])
async def test_slow_transfer_still_rejects_unsafe_departure(
    scenario, local_replica, monkeypatch, entry, blocker, status,
):
    s = scenario
    await history(s, resolved=blocker != "active_sos")
    if blocker == "dependent":
        await s.db.members.insert_one({
            "id": "dependent", "owner_id": "invitee", "family_group_id": "solo",
        })
    elif blocker == "wrong_email":
        await s.db.users.update_one({"id": "invitee"}, {"$set": {"email": "different@example.com"}})
    elif blocker == "revoked_invite":
        await s.db.family_invites.update_one({"id": "invitation"}, {"$set": {"status": "revoked"}})
    before = await snapshot(s.db)
    async with delayed_routes(s, local_replica, monkeypatch) as (http, _, _, deliveries):
        response = await request_transfer(http, s, entry)
        assert response.status_code == status, response.text
        assert deliveries == []
    assert await snapshot(s.db) == before


@pytest.mark.asyncio
@pytest.mark.parametrize("entry", ["legacy_invite", "email_link"])
@pytest.mark.parametrize("commit_case", ["slow_command", "unknown_result"])
async def test_commit_can_finish_after_former_one_second_deadline(
    scenario, local_replica, monkeypatch, entry, commit_case,
):
    s = scenario
    retained = await history(s)
    callbacks = []
    real_join = links.join_verified

    async def counted_join(*args, **kwargs):
        callbacks.append("domain")
        return await real_join(*args, **kwargs)

    monkeypatch.setattr(links, "join_verified", counted_join)
    failure = ({"blockConnection": True, "blockTimeMS": 1200} if commit_case == "slow_command"
               else {"errorCode": 64, "errorLabels": ["UnknownTransactionCommitResult"]})
    # This failpoint is confined to the owned loopback replica and test app.
    await s.mongo.admin.command({
        "configureFailPoint": "failCommand", "mode": {"times": 1},
        "data": {"failCommands": ["commitTransaction"], "appName": APP_NAME, **failure},
    })
    try:
        async with delayed_routes(s, local_replica, monkeypatch) as (http, db, latency, deliveries):
            response = await request_transfer(http, s, entry)
            assert response.status_code == 200, response.text
            assert latency.commands.count("commitTransaction") == (1 if commit_case == "slow_command" else 2)
            assert callbacks == ["domain"]  # Commit uncertainty must not replay domain work.
            assert (await db.users.find_one({"id": "invitee"}))["family_group_id"] == "target"
            assert (await db.family_invites.find_one({"id": "invitation"}))["status"] == "accepted"
            assert await db.alerts.find_one({"id": retained["id"]}) == retained
            assert len(deliveries) == (1 if entry == "legacy_invite" else 0)
    finally:
        await s.mongo.admin.command({"configureFailPoint": "failCommand", "mode": "off"})


@pytest.mark.asyncio
async def test_transfer_deadline_remains_bounded_and_rolls_back_partial_work(scenario):
    s = scenario
    before = await snapshot(s.db)

    async def stalled(session):
        tx = fw.SessionDatabase(s.db, session)
        await fw.acquire(tx, ["solo", "target"])
        await tx.users.update_one({"id": "invitee"}, {"$set": {"family_group_id": "target"}})
        await tx.family_invites.update_one({"id": "invitation"}, {"$set": {"status": "accepted"}})
        await asyncio.Event().wait()  # No commit command is dispatched.

    started = time.monotonic()
    with pytest.raises(HTTPException) as error:
        await fw.transaction(s.db, stalled, timeout=.2)
    assert error.value.status_code == 503
    assert "Transfer timed out" in error.value.detail
    assert time.monotonic() - started < 2
    assert await snapshot(s.db) == before


@pytest.mark.asyncio
async def test_external_cancellation_rolls_back_without_committing(scenario):
    s = scenario
    before = await snapshot(s.db)
    entered = asyncio.Event()

    async def cancelled(session):
        tx = fw.SessionDatabase(s.db, session)
        await fw.acquire(tx, ["solo", "target"])
        await tx.users.update_one({"id": "invitee"}, {"$set": {"family_group_id": "target"}})
        entered.set()
        await asyncio.Event().wait()

    task = asyncio.create_task(fw.transaction(s.db, cancelled))
    try:
        await asyncio.wait_for(entered.wait(), 3)
    finally:
        task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert await snapshot(s.db) == before


def test_transfer_budget_does_not_extend_sos_persistence_deadline():
    assert fw.FAMILY_TRANSFER_TIMEOUT_SECONDS == 10.0
    assert fw.transaction.__kwdefaults__["timeout"] == 1.0
    assert fw.run.__kwdefaults__["timeout"] == 2.0


@pytest.mark.asyncio
async def test_sos_alert_read_keeps_its_original_short_deadline(scenario):
    s = scenario
    await s.mongo.admin.command({
        "configureFailPoint": "failCommand", "mode": {"times": 1},
        "data": {"failCommands": ["find"], "blockConnection": True,
                 "blockTimeMS": 1200, "appName": APP_NAME},
    })
    try:
        # Actual read path: the transfer override must not leak into SOS polls.
        with pytest.raises(HTTPException) as error:
            await links.sh.read_family_alerts(s.db, "invitee", "solo")
        assert error.value.status_code == 503
    finally:
        await s.mongo.admin.command({"configureFailPoint": "failCommand", "mode": "off"})
        # Let the already-dispatched read finish before fixture teardown.
        await asyncio.sleep(.3)
