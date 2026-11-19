"""Real deletion/writer transaction orderings; no production services."""
import ast
import asyncio
import copy
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi import BackgroundTasks, HTTPException
from pydantic import EmailStr

from test_email_links_mongo_integration import local_replica, scenario, pytestmark
import checkin_scheduler
import med_scheduler
from test_family_code_rotation import loopback_only
from account_deletion_support import (
    TREE, account_client, cleanup, delete, execute, fw, pause_first_commit,
    records, seed_care, sh,
)

assert med_scheduler.__file__.endswith("/backend/med_scheduler.py")


@pytest.mark.asyncio
async def test_complete_transaction_rolls_back_before_billing_and_can_retry(scenario, monkeypatch):
    await seed_care(scenario)
    before = await records(scenario.db)
    original = fw._known_commit

    async def fail(session, callback, **options):
        async def abort_after_cleanup(active):
            await callback(active)
            raise RuntimeError("Synthetic failure after deleting the user, before commit")
        return await original(session, abort_after_cleanup, **options)

    async with account_client(scenario) as client:
        with monkeypatch.context() as patch:
            patch.setattr(fw, "_known_commit", fail)
            response = await delete(client.http)
            assert response.status_code == 500
        assert client.billing == []
        assert await records(scenario.db) == before
        retried = await delete(client.http)
        assert retried.status_code == 200, retried.text
        assert len(client.billing) == 2


@pytest.mark.parametrize("collection", ["location_history", "location_ingest_log", "recovery_push_evidence"])
@pytest.mark.parametrize("first", ["delete", "evidence"])
@pytest.mark.asyncio
async def test_evidence_cannot_outlive_deleted_parent_in_either_order(scenario, monkeypatch, collection, first):
    s = scenario
    await seed_care(s)
    held, release = pause_first_commit(monkeypatch)
    payload = {"member_id": "self", "family_group_id": "solo", "subject_user_id": "invitee",
               "target_user_id": "invitee", "request_id": "late-request", "latitude": 1.2}

    async def evidence():
        return await cleanup.persist_subject_evidence(
            s.db, collection, payload, member_id="self", family_id="solo", subject_user_id="invitee",
            upsert_selector={"request_id": "late-request"} if collection == "recovery_push_evidence" else None,
        )

    async with account_client(s) as client:
        actions = {"delete": lambda: delete(client.http), "evidence": evidence}
        a = asyncio.create_task(actions[first]())
        try:
            await asyncio.wait_for(held.wait(), 3)
            b = asyncio.create_task(actions["evidence" if first == "delete" else "delete"]())
            try:
                await asyncio.sleep(0.03)
            finally:
                release.set()
            results = await asyncio.gather(a, b)
        finally:
            release.set()
            if not a.done():
                a.cancel()
        deletion, stored = results if first == "delete" else results[::-1]
        assert deletion.status_code == 200, deletion.text
        assert stored is (first == "evidence")
    assert not await s.db.members.find_one({"id": "self"})
    assert not await s.db[collection].find_one({"member_id": "self"})
    assert "_id" not in payload


@pytest.mark.asyncio
async def test_private_evidence_uses_no_family_structural_fence_and_leaves_location_tuple_unchanged(scenario, monkeypatch):
    before = await scenario.db.members.find_one({"id": "self"})

    async def forbidden(*args, **kwargs):
        raise AssertionError("Ordinary diagnostic evidence must not acquire the family structural fence")
    monkeypatch.setattr(fw, "acquire", forbidden)
    assert await cleanup.persist_subject_evidence(
        scenario.db, "location_history", {"member_id": "self", "latitude": 1.0},
        member_id="self", family_id="solo", subject_user_id="invitee",
    )
    after = await scenario.db.members.find_one({"id": "self"})
    assert after.pop("private_evidence_epoch") == 1
    assert after == before


@pytest.mark.asyncio
async def test_post_deletion_queued_medication_checkin_and_welfare_work_cannot_send_or_recreate(scenario):
    s = scenario
    welfare = await seed_care(s)
    queued = await s.db.checkin_deliveries.find_one({})
    calls = []

    async def send(*args, **kwargs):
        calls.append((args, kwargs))
        raise AssertionError("Deleted subjects must not start a queued send")

    async with account_client(s) as client:
        assert (await delete(client.http)).status_code == 200
        now = datetime.now(timezone.utc)
        # The actual scheduler may reject a removed family rather than return
        # False; neither case permits a stage or an occurrence to be inserted.
        for method, extra in (
            (med_scheduler._try_record_stage, {"stage": "due"}),
            (med_scheduler._claim_occurrence_for_family, {"occurrence_id": "late-med"}),
        ):
            try:
                result = await method(
                    s.db, reminder_id="reminders", family_group_id="solo", member_id="self",
                    slot_time="09:00", local_date="2026-11-19", now_utc=now, **extra,
                )
                assert not result
            except HTTPException as error:
                assert error.status_code in (401, 403, 409)
        await checkin_scheduler.deliver_one(s.db, queued, now=now, send=send, quiet=lambda _: False)
        client.scope["push_to_user"] = send
        execute(client.scope, "deliver_welfare_response_notification")
        await client.scope["deliver_welfare_response_notification"](welfare, "old-checkin")
    assert calls == []
    for name in ("med_notifications", "medication_occurrences", "checkin_requests", "checkin_deliveries"):
        assert await s.db[name].count_documents({}) == 0


@pytest.mark.parametrize("winner", ["delete", "structural"])
@pytest.mark.asyncio
async def test_structural_care_creation_and_deletion_share_the_existing_fence(scenario, monkeypatch, winner):
    await seed_care(scenario)
    held, release = pause_first_commit(monkeypatch)
    doc = {"id": "racing-alert", "owner_id": "invitee", "member_id": "self",
           "family_group_id": "solo", "type": "activity"}

    async def structural():
        try:
            await fw.insert_record(scenario.db, "alerts", doc, actor_id="invitee")
            return True
        except HTTPException as error:
            assert error.status_code in (401, 403, 409)
            return False

    async with account_client(scenario) as client:
        actions = {"delete": lambda: delete(client.http), "structural": structural}
        first = asyncio.create_task(actions[winner]())
        await asyncio.wait_for(held.wait(), 3)
        second = asyncio.create_task(actions["structural" if winner == "delete" else "delete"]())
        await asyncio.sleep(0.03)
        release.set()
        result = await asyncio.gather(first, second)
        response, inserted = result if winner == "delete" else result[::-1]
        assert response.status_code == 200, response.text
        assert inserted is (winner == "structural")
    assert not await scenario.db.alerts.find_one({"id": "racing-alert"})


@pytest.mark.parametrize("credential", ["link", "otp"])
@pytest.mark.asyncio
async def test_old_credential_request_paused_before_issue_cannot_recreate_data_after_delete(scenario, monkeypatch, credential):
    s = scenario
    held, release = asyncio.Event(), asyncio.Event()
    original = fw.transaction
    await s.db.otp_codes.delete_many({})

    async def paused(db, callback, **options):
        if callback.__name__ in ("issue", "issue_otp"):
            held.set()
            await release.wait()
        return await original(db, callback, **options)

    monkeypatch.setattr(fw, "transaction", paused)
    async with account_client(s) as client:
        if credential == "link":
            async def request():
                return await s.http.post("/api/auth/email-link/request", json={
                    "email": "invitee@example.com", "challenge": "1" * 64,
                })
        else:
            scope = client.scope
            scope.update({
                "EmailStr": EmailStr, "BackgroundTasks": BackgroundTasks,
                "OTP_RESEND_COOLDOWN_S": 60, "OTP_TTL_MINUTES": 5,
                "_generate_otp": lambda: "123456", "hash_password": lambda _: "synthetic-hash",
                "_deliver_otp_and_record": lambda *args: None,
            })
            execute(scope, "OtpRequest", "request_otp")

            async def request():
                try:
                    await scope["request_otp"](
                        scope["OtpRequest"](email="invitee@example.com", purpose="login"),
                        BackgroundTasks(), SimpleNamespace(client=SimpleNamespace(host="127.0.0.1")),
                    )
                except HTTPException as error:
                    return SimpleNamespace(status_code=error.status_code)
                return SimpleNamespace(status_code=200)
        pending = asyncio.create_task(request())
        await asyncio.wait_for(held.wait(), 3)
        try:
            response = await delete(client.http)
            assert response.status_code == 200, response.text
        finally:
            release.set()
        assert (await pending).status_code == 410
    assert not await s.db.email_links.find_one({"email": "invitee@example.com"})
    assert not await s.db.otp_codes.find_one({"email": "invitee@example.com"})
    assert s.sent == []


@pytest.mark.asyncio
async def test_credential_issue_committed_first_is_removed_by_waiting_deletion(scenario, monkeypatch):
    held, release = pause_first_commit(monkeypatch)
    pending = asyncio.create_task(scenario.http.post("/api/auth/email-link/request", json={
        "email": "invitee@example.com", "challenge": "1" * 64,
    }))
    await asyncio.wait_for(held.wait(), 3)
    async with account_client(scenario) as client:
        deletion = asyncio.create_task(delete(client.http))
        await asyncio.sleep(0.03)
        release.set()
        issued, removed = await asyncio.gather(pending, deletion)
        assert issued.status_code == 200, issued.text
        assert removed.status_code == 200, removed.text
    assert not await scenario.db.email_links.find_one({"email": "invitee@example.com"})
    assert not await scenario.db.users.find_one({"id": "invitee"})


@pytest.mark.asyncio
async def test_concurrent_delete_retries_do_not_repeat_billing_or_delete_other_people(scenario):
    await seed_care(scenario)
    async with account_client(scenario) as client:
        responses = await asyncio.gather(*(delete(client.http) for _ in range(3)))
        codes = [r.status_code for r in responses]
        assert codes.count(200) == 1, [r.text for r in responses]
        assert all(code in (200, 401, 409) for code in codes)
        assert len(client.billing) == 2
    assert await scenario.db.users.find_one({"id": "owner"})


def test_actual_diagnostic_writers_use_parent_guard_and_no_direct_late_insert():
    location = next(n for n in TREE.body if isinstance(n, ast.AsyncFunctionDef)
                    and n.name == "update_member_location")
    refresh = next(n for n in TREE.body if isinstance(n, ast.AsyncFunctionDef)
                   and n.name == "request_location_refresh")
    guarded = []
    for node in (location, refresh):
        for call in (n for n in ast.walk(node) if isinstance(n, ast.Call)):
            if isinstance(call.func, ast.Attribute) and call.func.attr == "persist_subject_evidence":
                guarded.append(call.args[1].value)
            if isinstance(call.func, ast.Attribute) and call.func.attr in ("insert_one", "update_one"):
                receiver = ast.unparse(call.func.value)
                assert receiver not in ("db.location_history", "db.location_ingest_log", "db.recovery_push_evidence")
    assert sorted(guarded) == ["location_history", "location_ingest_log", "recovery_push_evidence"]
