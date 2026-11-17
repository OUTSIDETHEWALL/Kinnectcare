"""Application-boundary tests; raw bypass probes remain in the history suite."""
import ast
import asyncio
import copy
import json
import logging
import statistics
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from fastapi import FastAPI
from pydantic import BaseModel
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
import httpx

from test_email_links_mongo_integration import (
    APP_NAME, fg, links, local_replica, scenario, snapshot, join, pytestmark,
)
from test_sos_history_transfer import history, alert_endpoints
import family_write_fence as fw


async def dependent(s):
    return await fw.create_dependent(s.db, {
        "id": "new-dependent", "owner_id": "invitee", "family_group_id": "solo",
        "name": "Synthetic dependent",
    }, "invitee")


@pytest.mark.asyncio
async def test_failed_medication_acknowledgment_rolls_back_callback_writes(scenario):
    s = scenario
    await s.db.alerts.insert_one({
        "id": "dose", "family_group_id": "solo", "type": "medication",
        "self_due": True, "acknowledged": False,
    })

    async def complete(tx, alert):
        await tx.medication_occurrences.insert_one({"occurrence_id": "sample-dose"})
        raise HTTPException(409, "The reminder is no longer available.")

    with pytest.raises(HTTPException) as error:
        await links.sh.acknowledge_in_family(
            s.db, "invitee", "solo", "dose", complete_medication=complete,
        )
    assert error.value.status_code == 409
    assert not await s.db.medication_occurrences.find_one({"occurrence_id": "sample-dose"})
    assert (await s.db.alerts.find_one({"id": "dose"}))["acknowledged"] is False


@pytest.mark.asyncio
@pytest.mark.parametrize("obligation", ["dependent", "reopened_sos", "new_sos", "care_log"])
async def test_application_writer_commits_after_transfer_snapshot_and_forces_recheck(
    scenario, monkeypatch, obligation,
):
    s = scenario
    await history(s)
    entered, release = asyncio.Event(), asyncio.Event()
    real = links.join_verified
    first = True

    async def pause_before_fence(*args, **kwargs):
        nonlocal first
        if first:
            first = False
            entered.set()
            await asyncio.wait_for(release.wait(), 5)
        return await real(*args, **kwargs)
    monkeypatch.setattr(links, "join_verified", pause_before_fence)
    transfer = asyncio.create_task(join(s))
    try:
        await asyncio.wait_for(entered.wait(), 5)
        if obligation == "dependent":
            await dependent(s)
        elif obligation == "reopened_sos":
            await fw.change_sos_resolution(s.db, "solo", "historical-sos", "invitee",
                                           {"resolved": False})
        elif obligation == "new_sos":
            await fw.persist_sos(s.db, {"id": "new-sos", "type": "sos", "resolved": False}, "invitee")
        else:
            # A system-generated log without personal-move authority blocks
            # the source owner from silently abandoning it.
            await fw.insert_record(s.db, "medication_logs", {
                "id": "system-care", "family_group_id": "solo", "member_id": "self",
            })
    finally:
        release.set()
    result = await asyncio.wait_for(transfer, 10)
    assert result.status_code == 409, result.text
    assert (await s.db.users.find_one({"id": "invitee"}))["family_group_id"] == "solo"
    assert (await s.db.family_invites.find_one({"id": "invitation"}))["status"] == "pending"


@pytest.mark.asyncio
@pytest.mark.parametrize("writer", ["dependent", "reopened_sos", "stale_log", "self_sos"])
async def test_transfer_first_reauthorizes_later_writer(scenario, monkeypatch, writer):
    s = scenario
    original = await history(s)
    entered, release = asyncio.Event(), asyncio.Event()
    real = links.sh.verified_subjects
    first = True

    async def pause_after_fence(*args, **kwargs):
        nonlocal first
        result = await real(*args, **kwargs)
        if first:
            first = False
            entered.set()
            await asyncio.wait_for(release.wait(), 5)
        return result
    monkeypatch.setattr(links.sh, "verified_subjects", pause_after_fence)
    transfer = asyncio.create_task(join(s))
    await asyncio.wait_for(entered.wait(), 5)
    started = time.perf_counter()
    if writer == "dependent":
        pending = asyncio.create_task(dependent(s))
    elif writer == "reopened_sos":
        pending = asyncio.create_task(fw.change_sos_resolution(
            s.db, "solo", original["id"], "invitee", {"resolved": False},
        ))
    elif writer == "stale_log":
        pending = asyncio.create_task(fw.insert_record(s.db, "checkins", {
            "id": "stale", "owner_id": "invitee", "member_id": "self", "family_group_id": "solo",
        }, actor_id="invitee"))
    else:
        pending = asyncio.create_task(fw.persist_sos(
            s.db, {"id": "priority-sos", "type": "sos", "resolved": False}, "invitee",
        ))
    await asyncio.sleep(0.03)
    release.set()
    assert (await asyncio.wait_for(transfer, 10)).status_code == 200
    if writer == "self_sos":
        committed, actor = await asyncio.wait_for(pending, 10)
        assert committed["family_group_id"] == actor["family_group_id"] == "target"
        assert await s.db.alerts.count_documents({"id": "priority-sos"}) == 1
        elapsed = (time.perf_counter() - started) * 1000
        print("SOS_TRANSFER_CONTENTION_MS", elapsed)
        assert elapsed < 2500
    else:
        with pytest.raises(HTTPException) as error:
            await asyncio.wait_for(pending, 10)
        assert error.value.status_code == 409
    assert await s.db.alerts.find_one({"id": original["id"]}) == original


@pytest.mark.asyncio
async def test_fence_rolls_back_counter_and_domain_write_together(scenario):
    s = scenario
    before = await snapshot(s.db)
    async def fail(tx):
        await tx.members.insert_one({"id": "never-committed", "family_group_id": "solo"})
        raise RuntimeError("Synthetic failure")
    with pytest.raises(RuntimeError):
        await fw.run(s.db, ["solo"], fail)
    assert await snapshot(s.db) == before


@pytest.mark.asyncio
async def test_deadline_aborts_counter_and_domain_write_together(scenario):
    s = scenario
    before = await snapshot(s.db)
    async def stall(tx):
        await tx.members.insert_one({"id": "never-committed", "family_group_id": "solo"})
        await asyncio.Event().wait()
    with pytest.raises(HTTPException) as error:
        await fw.run(s.db, ["solo"], stall, timeout=.1)
    assert error.value.status_code == 503
    assert await snapshot(s.db) == before


@pytest.mark.asyncio
async def test_competing_real_family_transfers_only_one_destination_wins(scenario):
    s = scenario
    original = await history(s)
    await s.db.family_groups.insert_one({"id": "target-b", "owner_user_id": "owner-b"})
    await s.db.users.insert_one({"id": "owner-b", "family_group_id": "target-b"})
    invitation = await s.db.family_invites.find_one({"id": "invitation"})
    invitation.update(id="invitation-b", token="INV-OTHER", family_group_id="target-b",
                      invited_by_user_id="owner-b")
    invitation.pop("_id", None)
    await s.db.family_invites.insert_one(invitation)
    other = {**s.payload, "invite_token": "INV-OTHER", "expected_family_id": "target-b"}
    results = await asyncio.gather(join(s), s.http.post("/api/auth/email-link/join", json=other))
    assert sorted(r.status_code for r in results) == [200, 409], [r.text for r in results]
    assert (await s.db.users.find_one({"id": "invitee"}))["family_group_id"] in ("target", "target-b")
    assert await s.db.alerts.find_one({"id": original["id"]}) == original


@pytest.mark.asyncio
async def test_sorted_two_family_fences_do_not_deadlock(scenario):
    s = scenario
    async def action(tx):
        return True
    results = await asyncio.wait_for(asyncio.gather(*[
        fw.run(s.db, ids, action) for ids in (["solo", "target"], ["target", "solo"]) * 4
    ]), 10)
    assert all(results)
    for gid in ("solo", "target"):
        assert (await s.db.family_groups.find_one({"id": gid}))["family_write_epoch"] == 8


@pytest.mark.asyncio
async def test_authority_and_subject_checks_are_fresh(scenario):
    s = scenario
    await s.db.family_groups.update_one({"id": "solo"}, {"$set": {"owner_user_id": "someone-else"}})
    with pytest.raises(HTTPException) as error:
        await dependent(s)
    assert error.value.status_code == 403
    with pytest.raises(HTTPException) as error:
        await fw.persist_sos(s.db, {"id": "bad-subject"}, "invitee", explicit_member_id="unrelated-members")
    assert error.value.status_code == 403
    assert not await s.db.alerts.find_one({"id": "bad-subject"})


class Incident:
    def __init__(self, **values):
        self.__dict__.update({"id": str(uuid.uuid4()), "created_at": datetime.now(timezone.utc), **values})
    def model_dump(self):
        return copy.deepcopy(vars(self))


def sos_endpoint(db):
    """Compile the actual endpoint, stub only model/delivery (no live imports)."""
    path = Path(__file__).resolve().parents[1] / "server.py"
    node = next(n for n in ast.parse(path.read_text()).body
                if isinstance(n, ast.AsyncFunctionDef) and n.name == "trigger_sos")
    node.decorator_list = []
    pushes, messages = AsyncMock(return_value=0), AsyncMock(return_value=[])
    jobs = set()
    scope = {"db": db, "fw": fw, "Alert": Incident, "SOSRequest": SimpleNamespace,
             "Depends": lambda dep: None, "get_current_user": lambda: None,
             "user_tz": lambda user: timezone.utc, "datetime": datetime, "timezone": timezone,
             "push_to_family_group": pushes, "sms": SimpleNamespace(
                 send_sms_to_many=messages, mode=lambda: "mock", normalize_e164=lambda x: x),
             "asyncio": asyncio, "_BG_TASKS": jobs, "logger": logging.getLogger(__name__)}
    exec(compile(ast.Module(body=[node], type_ignores=[]), str(path), "exec"), scope)
    return scope["trigger_sos"], pushes, messages, jobs


@pytest.mark.asyncio
@pytest.mark.parametrize("command,code,label", [
    ("insert", 112, "TransientTransactionError"),
    ("commitTransaction", 64, "UnknownTransactionCommitResult"),
])
async def test_sos_transaction_retry_delivers_once_after_commit(scenario, command, code, label):
    s = scenario
    endpoint, pushes, messages, jobs = sos_endpoint(s.db)
    await s.mongo.admin.command({
        "configureFailPoint": "failCommand", "mode": {"times": 1},
        "data": {"failCommands": [command], "errorCode": code,
                 "errorLabels": [label], "appName": APP_NAME},
    })
    try:
        actor = await s.db.users.find_one({"id": "invitee"})
        result = await endpoint(SimpleNamespace(member_id=None, latitude=None, longitude=None), actor)
        await asyncio.gather(*list(jobs))
    finally:
        await s.mongo.admin.command({"configureFailPoint": "failCommand", "mode": "off"})
    assert result["ok"] is True
    assert await s.db.alerts.count_documents({"type": "sos"}) == 1
    # One visible emergency and the existing one data-only companion.
    assert pushes.await_count == 2
    assert sum(bool(call.args[1]) for call in pushes.await_args_list) == 1


@pytest.mark.asyncio
async def test_local_sos_persistence_latency(scenario):
    s = scenario
    raw, fenced = [], []
    for i in range(30):
        row = {"id": "baseline-" + str(i), "family_group_id": "solo", "owner_id": "invitee",
               "member_id": "invitee", "type": "sos", "resolved": False}
        start = time.perf_counter()
        await s.db.alerts.insert_one(copy.deepcopy(row))
        raw.append((time.perf_counter() - start) * 1000)
        row["id"] = "fenced-" + str(i)
        start = time.perf_counter()
        await fw.persist_sos(s.db, row, "invitee")
        fenced.append((time.perf_counter() - start) * 1000)
    def summary(values):
        return {"p50_ms": statistics.median(values),
                "p95_ms": sorted(values)[int(len(values) * .95) - 1], "max_ms": max(values)}
    output = {"environment": "owned loopback MongoDB replica, warm sequential synthetic writes",
              "samples_each": 30, "raw_insert": summary(raw), "fenced_persistence": summary(fenced)}
    path = Path(__file__).resolve().parents[2] / "generated-artifacts/family-fence-sos-latency.json"
    path.write_text(json.dumps(output, indent=2))
    print("SOS_LATENCY", json.dumps(output))
    assert max(fenced) < 2000  # Deadline check, not a production latency SLA.


class SyntheticOtp(BaseModel):
    email: str
    code: str


def otp_app(db):
    """Execute the real retained endpoint against synthetic local storage.

    Only OTP cryptography and session-token issuance are stubbed; family
    transitions, linkage, transaction retries and HTTP errors are real.
    """
    path = Path(__file__).resolve().parents[1] / "server.py"
    node = next(n for n in ast.parse(path.read_text()).body
                if isinstance(n, ast.AsyncFunctionDef) and n.name == "verify_otp")
    node.decorator_list = []
    scope = {"db": db, "fg": fg, "el": links, "OtpVerify": SyntheticOtp,
             "OTP_LENGTH": 6, "OTP_MAX_ATTEMPTS": 5, "HTTPException": HTTPException,
             "verify_password": lambda value, proof: value == "123456" and proof == "synthetic-proof",
             "datetime": datetime, "timezone": timezone, "uuid": uuid,
             "ZoneInfo": ZoneInfo, "ZoneInfoNotFoundError": ZoneInfoNotFoundError,
             "logger": logging.getLogger(__name__), "push_to_user": AsyncMock(),
             "TokenResponse": lambda **kwargs: kwargs,
             "create_access_token": lambda uid: "synthetic-session",
             "_user_response": lambda user: {key: user[key] for key in ("id", "family_group_id")}}
    exec(compile(ast.Module(body=[node], type_ignores=[]), str(path), "exec"), scope)
    app = FastAPI()
    app.post("/api/auth/verify-otp")(scope["verify_otp"])
    return app


async def otp_request(s, new_account):
    await s.db.family_groups.update_one({"id": "target"}, {"$set": {"invite_code": "KINN-SAFE"}})
    email = "new-synthetic@example.com" if new_account else "invitee@example.com"
    await s.db.otp_codes.insert_one({
        "email": email, "code_hash": "synthetic-proof", "purpose": "signup",
        "invite_code": "KINN-SAFE", "full_name": "New Synthetic", "timezone": "UTC",
        "expires_at": datetime.now(timezone.utc) + timedelta(minutes=10),
    })
    return email


@pytest.mark.asyncio
@pytest.mark.parametrize("new_account", [False, True])
async def test_real_retained_otp_joins_with_transactional_history_or_linkage(scenario, new_account):
    s = scenario
    original = await history(s)
    email = await otp_request(s, new_account)
    if new_account:
        await s.db.members.insert_one({
            "id": "placeholder", "family_group_id": "target", "owner_id": "owner",
            "user_id": None, "name": "New Synthetic", "role": "senior",
        })
    async with httpx.AsyncClient(transport=httpx.ASGITransport(
        app=otp_app(s.db), raise_app_exceptions=False), base_url="https://test.invalid",
    ) as http:
        response = await http.post("/api/auth/verify-otp", json={"email": email, "code": "123456"})
    assert response.status_code == 200, response.text
    actor = await s.db.users.find_one({"email": email})
    assert actor["family_group_id"] == "target"
    if new_account:
        assert (await s.db.members.find_one({"id": "placeholder"}))["user_id"] == actor["id"]
        assert await s.db.members.count_documents({"user_id": actor["id"]}) == 1
    assert await s.db.alerts.find_one({"id": original["id"]}) == original


@pytest.mark.asyncio
@pytest.mark.parametrize("new_account", [False, True])
async def test_real_retained_otp_rejects_code_rotated_while_request_waits(scenario, monkeypatch, new_account):
    s = scenario
    email = await otp_request(s, new_account)
    entered, release = asyncio.Event(), asyncio.Event()
    real = links.join_family_code
    async def pause(*args, **kwargs):
        entered.set()
        await asyncio.wait_for(release.wait(), 5)
        return await real(*args, **kwargs)
    monkeypatch.setattr(links, "join_family_code", pause)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(
        app=otp_app(s.db), raise_app_exceptions=False), base_url="https://test.invalid",
    ) as http:
        pending = asyncio.create_task(http.post("/api/auth/verify-otp", json={"email": email, "code": "123456"}))
        await asyncio.wait_for(entered.wait(), 5)
        await s.db.family_groups.update_one({"id": "target"}, {"$set": {"invite_code": "KINN-ROTATED"}})
        release.set()
        response = await asyncio.wait_for(pending, 10)
    assert response.status_code in (404, 410), response.text
    actor = await s.db.users.find_one({"email": email})
    assert actor is None if new_account else actor["family_group_id"] == "solo"


@pytest.mark.asyncio
async def test_real_retained_otp_rolls_back_new_account_and_linkage_on_failure(scenario, monkeypatch):
    s = scenario
    email = await otp_request(s, True)
    await s.db.members.insert_one({
        "id": "placeholder", "family_group_id": "target", "owner_id": "owner",
        "user_id": None, "name": "New Synthetic",
    })
    before = await snapshot(s.db)
    async def fail(*args, **kwargs):
        raise RuntimeError("Synthetic self-row failure")
    monkeypatch.setattr(fg, "ensure_self_member_row", fail)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(
        app=otp_app(s.db), raise_app_exceptions=False), base_url="https://test.invalid",
    ) as http:
        response = await http.post("/api/auth/verify-otp", json={"email": email, "code": "123456"})
    assert response.status_code == 500
    assert await snapshot(s.db) == before


@pytest.mark.asyncio
async def test_leave_collection_failure_rolls_back_all_moves_and_membership(scenario, monkeypatch):
    s = scenario
    await history(s)
    before = await snapshot(s.db)
    real = fw.SessionCollection.__getattr__
    def inject(self, name):
        if self.collection.name == "reminders" and name == "update_many":
            async def fail(*args, **kwargs):
                raise RuntimeError("Synthetic collection move failure")
            return fail
        return real(self, name)
    monkeypatch.setattr(fw.SessionCollection, "__getattr__", inject)
    response = await s.http.post("/api/family-group/leave", headers={"x-test-actor": "invitee"})
    assert response.status_code == 500
    assert await snapshot(s.db) == before


async def shared_source(s):
    await s.db.users.insert_one({"id": "remaining", "family_group_id": "solo"})
    await s.db.family_groups.update_one({"id": "solo"}, {"$set": {"owner_user_id": "remaining"}})


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["list_alerts", "acknowledge_alert"])
async def test_archive_operation_overlapping_transfer(scenario, monkeypatch, operation):
    s = scenario
    await shared_source(s)
    original = await history(s, acknowledged=False)
    entered, resume = asyncio.Event(), asyncio.Event()
    original_query = links.sh.family_alert_query

    async def pause(db, gid):
        scope = await original_query(db, gid)
        # The list probes after roster capture; ack probes just before
        # acquiring its write fence, since a held fence excludes the transfer.
        if operation == "list_alerts":
            entered.set()
            await asyncio.wait_for(resume.wait(), 5)
        return scope

    if operation == "list_alerts":
        monkeypatch.setattr(links.sh, "family_alert_query", pause)
    else:
        original_ack = links.sh.acknowledge_in_family

        async def pause_ack(*args, **kwargs):
            entered.set()
            await asyncio.wait_for(resume.wait(), 5)
            return await original_ack(*args, **kwargs)
        monkeypatch.setattr(links.sh, "acknowledge_in_family", pause_ack)

    actor = {"id": "remaining", "family_group_id": "solo"}
    endpoints = alert_endpoints(s.db)
    call = endpoints.list_alerts(actor) if operation == "list_alerts" else endpoints.acknowledge_alert(original["id"], actor)
    task = asyncio.create_task(call)
    try:
        await asyncio.wait_for(entered.wait(), 5)
        assert (await join(s)).status_code == 200
    finally:
        resume.set()
    if operation == "list_alerts":
        assert original["id"] not in str(await task)
    else:
        with pytest.raises(HTTPException) as error:
            await task
        assert error.value.status_code == 404
    assert await s.db.alerts.find_one({"id": original["id"]}) == original


@pytest.mark.asyncio
async def test_leave_blocks_active_sos_about_another_member(scenario):
    s = scenario
    await shared_source(s)
    await s.db.members.insert_one({"id": "other-subject", "user_id": "remaining",
                                   "owner_id": "remaining", "family_group_id": "solo"})
    await fw.persist_sos(s.db, {"id": "active-other", "type": "sos", "resolved": False},
                         "invitee", explicit_member_id="other-subject")
    before = await snapshot(s.db)
    response = await s.http.post("/api/family-group/leave", headers={"x-test-actor": "invitee"})
    assert response.status_code == 409
    assert await snapshot(s.db) == before


@pytest.mark.asyncio
async def test_startup_family_repair_loses_race_without_attributing_history(scenario, monkeypatch):
    s = scenario
    await s.db.users.update_one({"id": "invitee"}, {"$unset": {"family_group_id": ""}})
    await s.db.reminders.insert_one({"id": "unscoped-care", "owner_id": "invitee"})
    incident = await history(s, id="unscoped-sos")
    await s.db.alerts.update_one({"id": incident["id"]}, {"$unset": {"family_group_id": ""}})
    before = await s.db.alerts.find_one({"id": incident["id"]})
    entered, resume = asyncio.Event(), asyncio.Event()
    real_create = fg.create_group_for_user

    async def pause(tx, actor):
        entered.set()
        await asyncio.wait_for(resume.wait(), 5)
        return await real_create(tx, actor)

    monkeypatch.setattr(fg, "create_group_for_user", pause)
    stale = {"id": "invitee"}
    task = asyncio.create_task(fg.ensure_family_group(s.db, stale))
    try:
        await asyncio.wait_for(entered.wait(), 5)
        payload = {**s.payload, "previous_family_id": None}
        assert (await s.http.post("/api/auth/email-link/join", json=payload)).status_code == 200
    finally:
        resume.set()
    with pytest.raises(HTTPException) as error:
        await task
    assert error.value.status_code == 409
    assert "family_group_id" not in await s.db.reminders.find_one({"id": "unscoped-care"})
    assert await s.db.alerts.find_one({"id": incident["id"]}) == before


def test_legacy_sos_startup_mutator_is_not_registered():
    tree = ast.parse((Path(__file__).resolve().parents[1] / "server.py").read_text())
    assert not any(isinstance(node, ast.AsyncFunctionDef) and node.name == "_migrate_alerts_backfill_v50"
                   for node in tree.body)


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["account", "dependent"])
async def test_deletion_rolls_back_and_retains_history(scenario, monkeypatch, operation):
    s = scenario
    original = await history(s)
    if operation == "account":
        async def delete():
            return await links.sh.delete_account_records(s.db, "invitee", "solo")
    else:
        await dependent(s)

        async def delete():
            return await links.sh.delete_dependent_records(s.db, "invitee", "solo", "new-dependent")

    before = await snapshot(s.db)
    real = fw.SessionCollection.__getattr__
    with monkeypatch.context() as m:
        def fail_late(self, name):
            if self.collection.name == "medication_logs" and name == "delete_many":
                async def fail(*args, **kwargs):
                    raise RuntimeError("Synthetic deletion failure")
                return fail
            return real(self, name)
        m.setattr(fw.SessionCollection, "__getattr__", fail_late)
        with pytest.raises(RuntimeError, match="Synthetic deletion failure"):
            await delete()
    assert await snapshot(s.db) == before
    await delete()
    assert await s.db.alerts.find_one({"id": original["id"]}) == original


@pytest.mark.asyncio
async def test_account_deletion_with_stale_family_rejects_after_transfer(scenario):
    s = scenario
    original = await history(s)
    assert (await join(s)).status_code == 200
    with pytest.raises(HTTPException) as error:
        await links.sh.delete_account_records(s.db, "invitee", "solo")
    assert error.value.status_code == 409
    assert await s.db.alerts.find_one({"id": original["id"]}) == original


@pytest.mark.asyncio
async def test_dependent_deletion_serializes_with_fenced_care_insert(scenario, monkeypatch):
    s = scenario
    await dependent(s)
    original = await history(s)
    entered, resume = asyncio.Event(), asyncio.Event()
    real = fw.SessionCollection.__getattr__

    def pause_delete(self, name):
        method = real(self, name)
        if self.collection.name == "members" and name == "delete_one":
            async def pause(*args, **kwargs):
                entered.set()
                await asyncio.wait_for(resume.wait(), 5)
                return await method(*args, **kwargs)
            return pause
        return method

    monkeypatch.setattr(fw.SessionCollection, "__getattr__", pause_delete)
    deletion = asyncio.create_task(links.sh.delete_dependent_records(s.db, "invitee", "solo", "new-dependent"))
    await asyncio.wait_for(entered.wait(), 5)
    insertion = asyncio.create_task(fw.insert_record(s.db, "checkins", {
        "id": "raced-checkin", "family_group_id": "solo", "member_id": "new-dependent",
    }, actor_id="invitee"))
    await asyncio.sleep(.025)
    resume.set()
    await deletion
    with pytest.raises(HTTPException) as error:
        await insertion
    assert error.value.status_code == 409
    assert await s.db.checkins.find_one({"id": "raced-checkin"}) is None
    assert await s.db.alerts.find_one({"id": original["id"]}) == original
