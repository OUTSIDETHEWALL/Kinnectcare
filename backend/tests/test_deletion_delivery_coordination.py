"""Exact application windows and durable deletion barriers on loopback Mongo."""
import asyncio
import copy
import multiprocessing
import threading
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pytest
from fastapi import HTTPException
from pydantic import BaseModel, EmailStr, Field, ConfigDict, field_serializer

import deletion_delivery as dd
import medication_delivery
from test_email_links_mongo_integration import local_replica, scenario, pytestmark
from account_deletion_support import account_client, delete, execute, fw, pause_first_commit, bearer
from test_family_code_rotation import loopback_only


def interrupted_process(uri, database, pipe):
    """A real separate process, stopped while its synthetic provider is active."""
    from motor.motor_asyncio import AsyncIOMotorClient
    async def worker():
        client = AsyncIOMotorClient(uri)
        try:
            async def provider():
                pipe.send("provider-active")
                await asyncio.Event().wait()
            await dd.run(client[database], provider, user_ids=["invitee"], operation_key="interrupted-event")
        finally:
            client.close()
    asyncio.run(worker())


async def otp(s, *, uid="invitee", code="123456", **extra):
    await s.db.otp_codes.delete_many({})
    identity = await s.db.email_link_identities.find_one({"_id": dd.email_key("invitee@example.com")}) or {}
    rec = {
        "email": "invitee@example.com", "credential_id": "unique-credential",
        "issued_user_id": uid, "deletion_generation": identity.get("deletion_generation", 0),
        "code_hash": code, "purpose": "login", "attempts": 0,
        "expires_at": datetime.now(timezone.utc) + timedelta(minutes=5), **extra,
    }
    await s.db.otp_codes.insert_one(copy.deepcopy(rec))
    return rec


def otp_handler(client):
    scope = client.scope
    scope.update({
        "OTP_LENGTH": 6, "OTP_MAX_ATTEMPTS": 5, "BaseModel": BaseModel, "EmailStr": EmailStr,
        "verify_password": lambda code, encoded: code == encoded,
        "create_access_token": bearer, "_user_response": lambda user: SimpleNamespace(id=user["id"]),
        "TokenResponse": lambda **kw: SimpleNamespace(**kw),
        "ZoneInfo": ZoneInfo, "ZoneInfoNotFoundError": ZoneInfoNotFoundError,
    })
    execute(scope, "OtpVerify", "_verify_otp_transaction", "verify_otp")
    return lambda code="123456": scope["verify_otp"](
        scope["OtpVerify"](email="invitee@example.com", code=code),
    )


@pytest.mark.parametrize("kind", ["solo", "invitation", "family-code"])
@pytest.mark.asyncio
async def test_fresh_signup_after_deletion_uses_new_identity_and_preserves_invitation_behavior(scenario, kind):
    async with account_client(scenario) as client:
        assert (await delete(client.http)).status_code == 200
        extras = {"purpose": "signup", "full_name": "Replacement", "timezone": "UTC"}
        if kind == "invitation":
            inv = copy.deepcopy(scenario.invite)
            await scenario.db.family_invites.insert_one(inv)
            extras["invite_code"] = inv["token"]
        elif kind == "family-code":
            await scenario.db.family_groups.update_one({"id": "target"}, {"$set": {"invite_code": "KINN-VALID"}})
            extras["invite_code"] = "KINN-VALID"
        await otp(scenario, uid=None, **extras)
        verify = otp_handler(client)
        notified = []
        async def notify(uid, title, body, data):
            # The invitation notification is strictly after commit.
            assert await scenario.db.users.find_one({"id": data["user_id"]})
            notified.append(uid)
        async def no_demo(*args):
            return None
        client.scope.update({"push_to_user": notify, "seed_demo_data": no_demo})
        result = await verify()
        user = await scenario.db.users.find_one({"email": "invitee@example.com"})
        assert result.user.id == user["id"] != "invitee"
        assert user.get("family_group_id")
        if kind != "solo":
            assert user["family_group_id"] == "target"
        if kind == "invitation":
            assert notified == ["owner"]
            assert (await scenario.db.family_invites.find_one({"id": scenario.invite["id"]}))["accepted_by_user_id"] == user["id"]


@pytest.mark.asyncio
async def test_cancelled_auth_email_keeps_barrier_until_real_thread_returns(scenario):
    started, finish = threading.Event(), threading.Event()
    def mail():
        started.set()
        assert finish.wait(10)
        return True
    task = asyncio.create_task(dd.run(
        scenario.db, lambda: asyncio.to_thread(mail), email="invitee@example.com", operation_key="threaded-mail",
    ))
    try:
        assert await asyncio.to_thread(started.wait, 3)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        async with account_client(scenario) as client:
            assert (await delete(client.http)).status_code == 409
            finish.set()
            await asyncio.gather(*list(dd._tasks))
            assert (await delete(client.http)).status_code == 200
    finally:
        finish.set()


@pytest.mark.asyncio
async def test_actual_recovery_with_captured_tokens_cannot_start_after_delete(scenario, monkeypatch):
    held, release = asyncio.Event(), asyncio.Event()
    original = dd.reserve
    async def paused(*args, **kwargs):
        held.set()
        await release.wait()
        return await original(*args, **kwargs)
    monkeypatch.setattr(dd, "reserve", paused)
    calls = []
    async def authority(*args):
        return "invitee", ["captured-private-device-token"], None
    async def provider(**kwargs):
        calls.append(kwargs)
        return {"tickets": []}
    async with account_client(scenario) as client:
        scope = client.scope
        trace = {}
        scope.update({
            "asyncio": asyncio, "_authenticate_location_refresh": lambda: None,
            "_REFRESH_PUSH_THROTTLE": {}, "_refresh_authority": authority,
            "_trace_record_request": lambda *args: trace, "send_expo_push_with_tickets": provider,
        })
        execute(scope, "request_location_refresh")
        task = asyncio.create_task(scope["request_location_refresh"]("self", {"id": "invitee", "family_group_id": "solo"}))
        await asyncio.wait_for(held.wait(), 3)
        try:
            assert (await delete(client.http)).status_code == 200
        finally:
            release.set()
        result = await task
        assert result["sent_to"] == 0
        assert result["skipped"] == "account_changed_or_delivery_active"
    assert calls == []
    assert not await scenario.db.recovery_push_evidence.find_one({})


@pytest.mark.asyncio
async def test_otp_consumes_once_and_throttles_wrong_attempts_durably(scenario):
    await otp(scenario)
    async with account_client(scenario) as client:
        verify = otp_handler(client)
        for _ in range(2):
            with pytest.raises(HTTPException) as error:
                await verify("000000")
            assert error.value.status_code == 400
        assert (await scenario.db.otp_codes.find_one({}))["attempts"] == 2
        results = await asyncio.gather(verify(), verify(), return_exceptions=True)
        assert sum(not isinstance(r, BaseException) for r in results) == 1
        assert sum(isinstance(r, HTTPException) and r.status_code == 400 for r in results) == 1
        assert not await scenario.db.otp_codes.find_one({})


@pytest.mark.parametrize("first", ["delete", "redeem"])
@pytest.mark.asyncio
async def test_actual_otp_redemption_serializes_with_deletion_and_email_replacement(scenario, monkeypatch, first):
    await otp(scenario)
    held, release = pause_first_commit(monkeypatch)
    async with account_client(scenario) as client:
        verify = otp_handler(client)
        async def redeem():
            try:
                return await verify()
            except HTTPException as error:
                return error
        actions = {"delete": lambda: delete(client.http), "redeem": redeem}
        a = asyncio.create_task(actions[first]())
        await asyncio.wait_for(held.wait(), 3)
        b = asyncio.create_task(actions["redeem" if first == "delete" else "delete"]())
        await asyncio.sleep(0.03)
        release.set()
        results = await asyncio.gather(a, b)
        removed, verified = results if first == "delete" else results[::-1]
        assert removed.status_code == 200, removed.text
        if first == "delete":
            assert isinstance(verified, HTTPException)
        else:
            assert verified.user.id == "invitee"
        await scenario.db.users.insert_one({"id": "replacement", "email": "invitee@example.com"})
        with pytest.raises(HTTPException):
            await verify()
        assert not await scenario.db.users.find_one({"id": "invitee"})


@pytest.mark.parametrize("consumed_first", [False, True])
@pytest.mark.asyncio
async def test_restoring_old_otp_row_cannot_authenticate_replacement_email(scenario, consumed_first):
    retained = await otp(scenario)
    async with account_client(scenario) as client:
        verify = otp_handler(client)
        if consumed_first:
            assert (await verify()).user.id == "invitee"
        assert (await delete(client.http)).status_code == 200
        await scenario.db.users.insert_one({"id": "replacement", "email": retained["email"]})
        await scenario.db.otp_codes.insert_one(retained)
        with pytest.raises(HTTPException) as error:
            await verify()
        assert error.value.status_code == 400


@pytest.mark.parametrize("scope", ["recipient", "subject", "email"])
@pytest.mark.asyncio
async def test_active_provider_blocks_delete_then_known_completion_allows_retry(scenario, scope):
    started, release = asyncio.Event(), asyncio.Event()
    calls = []
    async def provider():
        calls.append("sent")
        started.set()
        await release.wait()
        return True
    options = {
        "recipient": {"user_ids": ["invitee"]},
        "subject": {"user_ids": ["owner"], "data": {"member_id": "self"}},
        "email": {"email": "invitee@example.com"},
    }[scope]
    pending = asyncio.create_task(dd.run(scenario.db, provider, **options))
    try:
        await asyncio.wait_for(started.wait(), 3)
        async with account_client(scenario) as client:
            response = await delete(client.http)
            assert response.status_code == 409, response.text
            assert await scenario.db.users.find_one({"id": "invitee"})
            release.set()
            assert await pending is True
            assert (await delete(client.http)).status_code == 200
        assert calls == ["sent"]
    finally:
        release.set()
        await pending


@pytest.mark.asyncio
async def test_caller_cancellation_does_not_release_send_or_duplicate_on_retry(scenario):
    started, finish = asyncio.Event(), asyncio.Event()
    async def provider():
        started.set()
        await finish.wait()
        return True
    caller = asyncio.create_task(dd.run(scenario.db, provider, user_ids=["invitee"]))
    await asyncio.wait_for(started.wait(), 3)
    caller.cancel()
    with pytest.raises(asyncio.CancelledError):
        await caller
    attempt = await scenario.db.deletion_deliveries.find_one({"state": "active"})
    async with account_client(scenario) as client:
        assert (await delete(client.http)).status_code == 409
        finish.set()
        owned_tasks = list(dd._tasks)
        await asyncio.gather(*owned_tasks)
        assert (await scenario.db.deletion_deliveries.find_one({"_id": attempt["_id"]}))["state"] == "completed"
        assert (await delete(client.http)).status_code == 200


@pytest.mark.asyncio
async def test_failed_settlement_and_aged_interrupted_attempt_never_auto_unlock(scenario, monkeypatch):
    real_complete = dd.complete
    async def unavailable(*_):
        raise RuntimeError("Synthetic completion persistence outage")
    monkeypatch.setattr(dd, "complete", unavailable)
    async def provider():
        return True
    with pytest.raises(RuntimeError):
        await dd.run(scenario.db, provider, user_ids=["invitee"])
    attempt = await scenario.db.deletion_deliveries.find_one({"state": "active"})
    await scenario.db.deletion_deliveries.update_one({"_id": attempt["_id"]}, {
        "$set": {"started_at": datetime.now(timezone.utc) - timedelta(days=365)},
    })
    async with account_client(scenario) as client:
        for _ in range(2):
            assert (await delete(client.http)).status_code == 409
        # Only a known completed call can retry its exact settlement. No send
        # is replayed, no lease expires, and another attempt is not cleared.
        monkeypatch.setattr(dd, "complete", real_complete)
        await real_complete(scenario.db, attempt["_id"])
        assert (await delete(client.http)).status_code == 200


@pytest.mark.parametrize("sender", ["push", "escalation", "otp", "link"])
@pytest.mark.asyncio
async def test_actual_sender_paused_before_reservation_cannot_send_after_delete(scenario, monkeypatch, sender):
    held, release = asyncio.Event(), asyncio.Event()
    original = dd.reserve
    async def pause(*args, **kwargs):
        held.set()
        await release.wait()
        return await original(*args, **kwargs)
    monkeypatch.setattr(dd, "reserve", pause)
    calls = []
    async def transport(*args, **kwargs):
        calls.append("send")
        return {"tickets": [], "transport_status": "no_valid_tokens"}
    await scenario.db.users.update_one({"id": "invitee"}, {"$set": {"push_tokens": ["synthetic-token"]}})
    async with account_client(scenario) as client:
        scope = client.scope
        scope.update({"send_expo_push": transport, "_is_in_quiet_hours": lambda _: False, "List": list})
        if sender == "push":
            execute(scope, "push_to_user")
            operation = scope["push_to_user"]("invitee", "Title", "Body", {})
        elif sender == "escalation":
            operation = medication_delivery.send_verified_escalation(
                scenario.db, ["invitee"], "Title", "Body", {"member_id": "self"},
                send_with_tickets=transport, in_quiet_hours=lambda _: False,
            )
        elif sender == "otp":
            await otp(scenario)
            scope["_deliver_otp_email_sync"] = lambda *_: calls.append("mail") or (True, "stub")
            execute(scope, "_deliver_otp_and_record")
            operation = scope["_deliver_otp_and_record"]("invitee@example.com", "123456", "login", "unique-credential")
        else:
            operation = scenario.http.post("/api/auth/email-link/request", json={
                "email": "invitee@example.com", "challenge": "1" * 64,
            })
        task = asyncio.create_task(operation)
        await asyncio.wait_for(held.wait(), 3)
        try:
            assert (await delete(client.http)).status_code == 200
        finally:
            release.set()
        await task
    assert calls == []
    assert scenario.sent == []
    assert not await scenario.db.deletion_deliveries.find_one({"state": "active"})


@pytest.mark.parametrize("identity", ["owner", "recipient"])
@pytest.mark.asyncio
async def test_actual_invitation_creation_paused_before_fence_cannot_resurrect_after_deletion(scenario, monkeypatch, identity):
    await scenario.db.family_invites.delete_many({})
    held, release = asyncio.Event(), asyncio.Event()
    original = fw.run
    async def pause(db, gids, action, **options):
        if action.__name__ == "persist":
            held.set()
            await release.wait()
        return await original(db, gids, action, **options)
    monkeypatch.setattr(fw, "run", pause)
    # Invite from the solo owner to a different recipient for the owner race;
    # from the target owner to the solo account for the recipient race.
    sender_id = "invitee" if identity == "owner" else "owner"
    async with account_client(scenario, token=bearer(sender_id)) as sender:
        request = asyncio.create_task(sender.http.post("/api/family-group/invite", json={
            "name": "Person", "email": "new@example.com" if identity == "owner" else "invitee@example.com",
        }))
        await asyncio.wait_for(held.wait(), 3)
        async with account_client(scenario) as client:
            try:
                removed = await delete(client.http)
                assert removed.status_code == 200, removed.text
            finally:
                release.set()
        response = await request
        assert response.status_code in (401, 409, 410), response.text
    assert not await scenario.db.family_invites.find_one({})


@pytest.mark.asyncio
async def test_real_process_death_leaves_durable_barrier_and_suppresses_event_retry(scenario, local_replica):
    context = multiprocessing.get_context("spawn")
    receiver, sender = context.Pipe(duplex=False)
    child = context.Process(target=interrupted_process, args=(local_replica, scenario.db.name, sender))
    child.start()
    try:
        assert await asyncio.to_thread(receiver.poll, 15), "Child did not reach provider"
        assert receiver.recv() == "provider-active"
        child.kill()
        await asyncio.to_thread(child.join, 5)
        assert not child.is_alive()
        assert await scenario.db.deletion_deliveries.count_documents({"state": "active"}) == 1
        calls = []
        async def forbidden():
            calls.append("unexpected replay")
        # A new worker cannot infer settlement from age or process exit.
        assert await dd.run(scenario.db, forbidden, user_ids=["invitee"], operation_key="interrupted-event") is None
        async with account_client(scenario) as client:
            assert (await delete(client.http)).status_code == 409
        assert calls == []
    finally:
        if child.is_alive():
            child.kill()
        child.join(5)
        sender.close()
        receiver.close()


@pytest.mark.asyncio
async def test_real_invitation_send_blocks_recipient_deletion_and_keeps_legitimate_retry(scenario):
    await scenario.db.family_invites.delete_many({})
    started, finish = asyncio.Event(), asyncio.Event()
    async def mail(*args, **kwargs):
        started.set()
        await finish.wait()
        return True
    async with account_client(scenario, token=bearer("owner"), send_email=mail) as owner:
        task = asyncio.create_task(owner.http.post("/api/family-group/invite", json={
            "name": "Person", "email": "invitee@example.com",
        }))
        try:
            await asyncio.wait_for(started.wait(), 3)
            async with account_client(scenario) as client:
                assert (await delete(client.http)).status_code == 409
                finish.set()
                sent = await task
                assert sent.status_code == 200, sent.text
                assert sent.json()["delivered"] is True
                assert (await delete(client.http)).status_code == 200
        finally:
            finish.set()
            await task
    assert not await scenario.db.family_invites.find_one({})


@pytest.mark.parametrize("explicit", [False, True])
@pytest.mark.asyncio
async def test_actual_sos_and_resolution_invoke_visible_provider_for_both_subject_forms(scenario, explicit):
    # User and member IDs deliberately differ. The recipient shares the SOS
    # family; no test bypasses the new delivery barrier.
    await scenario.db.users.update_one({"id": "owner"}, {"$set": {
        "family_group_id": "solo", "push_tokens": ["synthetic-caregiver-token"],
    }})
    await scenario.db.members.update_one({"id": "self"}, {"$set": {"name": "Patient"}})
    calls, bg = [], set()
    async def provider(tokens, title, body, data):
        calls.append(copy.deepcopy(data))
        return []
    async def sms(*args, **kwargs):
        return []
    async with account_client(scenario) as client:
        scope = client.scope
        scope.update({
            "Field": Field, "ConfigDict": ConfigDict, "field_serializer": field_serializer, "asyncio": asyncio,
            "Dict": dict, "Any": object, "List": list,
            "user_tz": lambda _: ZoneInfo("UTC"), "send_expo_push": provider,
            "_is_in_quiet_hours": lambda _: False, "_BG_TASKS": bg,
            "med_scheduler": SimpleNamespace(STAGE_FAMILY="family"),
            "sms": SimpleNamespace(send_sms_to_many=sms, normalize_e164=lambda _: None, mode=lambda: "stub"),
            "_to_utc_iso": lambda dt: dt.isoformat(),
        })
        execute(scope, "Alert", "SOSRequest", "push_to_user", "push_to_family_group", "trigger_sos", "resolve_alert")
        current = await scenario.db.users.find_one({"id": "invitee"})
        result = await scope["trigger_sos"](
            scope["SOSRequest"](**({"member_id": "self"} if explicit else {})), current,
        )
        await asyncio.gather(*list(bg))
        visible = [c for c in calls if c.get("type") == "sos"]
        assert len(visible) == 1
        assert visible[0]["member_id"] == ("self" if explicit else "invitee")
        resolved = await scope["resolve_alert"](visible[0]["alert_id"], current)
        assert resolved["ok"] is True
        assert len([c for c in calls if c.get("type") == "alert_resolved"]) == 1
        # Once a resolved subject is deleted, a paused resolution fanout cannot
        # send to another surviving caregiver on the captured subject's behalf.
        await scenario.db.users.update_one({"id": "owner"}, {"$set": {"family_group_id": "target"}})
        # Preserve the real SOS priority policy: transfers/deletion yield for
        # the existing three-second emergency window rather than bypass it.
        await asyncio.sleep(3.1)
        deletion = await delete(client.http)
        assert deletion.status_code == 200, deletion.text
        before = len(calls)
        assert await scope["push_to_user"]("owner", "Resolved", "Body", {
            **visible[0], "type": "alert_resolved",
        }) == 0
        assert len(calls) == before
