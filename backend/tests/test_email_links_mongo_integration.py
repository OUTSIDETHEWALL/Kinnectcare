"""Opt-in real transactions, with an owned loopback mongod and synthetic data only.

KINNSHIP_RUN_LOCAL_MONGO_TESTS=1 PYTHONPATH=backend python -m pytest \
    backend/tests/test_email_links_mongo_integration.py -q

Requires the local `mongodb` Nix package. No connection URI or credentials are
read from the environment. Never substitutes a mock when MongoDB is unavailable.
"""
import asyncio
import copy
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI, HTTPException, Request
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo import MongoClient
from pymongo.errors import PyMongoError

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import email_links as links
import family_group as fg

pytestmark = pytest.mark.skipif(
    os.environ.get("KINNSHIP_RUN_LOCAL_MONGO_TESTS") != "1",
    reason="Opt in explicitly to the disposable loopback MongoDB integration run",
)
APP_NAME = "kinnship-invite-integration"
COLLECTIONS = ("users", "family_groups", "family_invites", *fg.DATA_COLLECTIONS)
VERIFIER = "1" * 64


@pytest.fixture(scope="module")
def local_replica():
    assert pathlib.Path(fg.__file__).resolve().parent == pathlib.Path(__file__).resolve().parents[1]
    binary = shutil.which("mongod")
    if not binary:
        pytest.fail("Real mongod is required; install the mongodb Nix package")
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    root = pathlib.Path(__file__).resolve().parents[2] / "generated-artifacts"
    root.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="invite-mongo-", dir=root) as directory:
        path = pathlib.Path(directory)
        uri = f"mongodb://127.0.0.1:{port}/?replicaSet=invitation_tests&directConnection=true"
        with (path / "mongod.log").open("w") as log:
            process = subprocess.Popen([
                binary, "--bind_ip", "127.0.0.1", "--port", str(port),
                "--dbpath", directory, "--replSet", "invitation_tests",
                "--setParameter", "enableTestCommands=1", "--quiet",
                "--wiredTigerCacheSizeGB", "0.25",
            ], stdout=log, stderr=subprocess.STDOUT)
            admin = MongoClient(
                f"mongodb://127.0.0.1:{port}/?directConnection=true",
                serverSelectionTimeoutMS=500,
            )
            try:
                deadline = time.monotonic() + 40
                while True:
                    if process.poll() is not None:
                        pytest.fail("Disposable mongod exited; see temporary server log")
                    try:
                        admin.admin.command("ping")
                        break
                    except PyMongoError:
                        if time.monotonic() > deadline:
                            pytest.fail("Disposable mongod did not become reachable")
                        time.sleep(0.1)
                admin.admin.command("replSetInitiate", {
                    "_id": "invitation_tests",
                    "members": [{"_id": 0, "host": f"127.0.0.1:{port}"}],
                    "settings": {"electionTimeoutMillis": 1000},
                })
                while not admin.admin.command("hello").get("isWritablePrimary"):
                    if time.monotonic() > deadline:
                        pytest.fail("Disposable replica set did not elect its primary")
                    time.sleep(0.1)
                assert admin.admin.command("hello")["setName"] == "invitation_tests"
                yield uri
            finally:
                admin.close()
                process.terminate()
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)


@pytest_asyncio.fixture
async def scenario(local_replica):
    # The URI is constructed above; it cannot select a production endpoint.
    assert local_replica.startswith("mongodb://127.0.0.1:")
    client = AsyncIOMotorClient(
        local_replica, appname=APP_NAME, serverSelectionTimeoutMS=5000,
    )
    name = "disposable_invitation_" + uuid.uuid4().hex
    db = client[name]
    try:
        assert (await client.admin.command("hello"))["setName"] == "invitation_tests"
        owner = {"id": "owner", "email": "owner@example.com", "family_group_id": "target",
                 "family_group_role": "owner", "full_name": "Test Owner"}
        user = {"id": "invitee", "email": "invitee@example.com", "family_group_id": "solo",
                "family_group_role": "owner", "full_name": "Test Invitee"}
        invite = {"id": "invitation", "token": "INV-" + "A" * 64,
                  "invitee_email": user["email"], "invitee_name": "Test Invitee",
                  "invited_by_user_id": owner["id"], "family_group_id": "target",
                  "role": "senior", "relationship": "Parent", "status": "pending",
                  "expires_at": datetime.now(timezone.utc) + timedelta(days=7)}
        await db.users.insert_many([copy.deepcopy(owner), copy.deepcopy(user)])
        await db.family_groups.insert_many([
            {"id": "target", "name": "Target Family", "owner_user_id": owner["id"]},
            {"id": "solo", "name": "Solo Family", "owner_user_id": user["id"]},
            {"id": "unrelated", "name": "Unrelated Family", "owner_user_id": "someone-else"},
        ])
        await db.family_invites.insert_one(copy.deepcopy(invite))
        await db.members.insert_one({
            "id": "self", "user_id": user["id"], "owner_id": user["id"],
            "family_group_id": "solo", "role": "family",
        })
        for collection in fg.DATA_COLLECTIONS:
            if collection != "members":
                await db[collection].insert_one({
                    "id": collection, "owner_id": user["id"], "member_id": "self",
                    "family_group_id": "solo", "preserve": "synthetic history",
                })
            await db[collection].insert_one({
                "id": "unrelated-" + collection, "family_group_id": "unrelated",
                "user_id": "someone-else", "owner_id": "someone-else",
            })
            await db[collection].insert_one({
                "id": "target-" + collection, "family_group_id": "target",
                "user_id": owner["id"], "owner_id": owner["id"],
            })
        sent = []

        async def send_email(*args, **kwargs):
            sent.append(args[2])
            return True

        async def current_user():
            return {"id": user["id"]}

        app = FastAPI()
        app.include_router(links.build_router(
            db, current_user, send_email, lambda uid: "test-session:" + uid,
            lambda u: {k: v for k, v in u.items() if k != "_id"},
        ), prefix="/api")
        async def family_actor(request: Request):
            actor = await db.users.find_one({"id": request.headers.get("x-test-actor", "owner")})
            if not actor:
                raise HTTPException(401, "Synthetic session unavailable")
            return actor

        app.include_router(fg.build_router(db, family_actor), prefix="/api")
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
            base_url="https://test.invalid",
        ) as http:
            yield SimpleNamespace(
                db=db, mongo=client, http=http, invite=invite, sent=sent,
                payload={"invite_token": invite["token"], "expected_family_id": "target",
                         "previous_family_id": "solo", "confirmed": True},
            )
    finally:
        assert name.startswith("disposable_invitation_")
        await client.drop_database(name)
        client.close()


async def snapshot(db):
    return {name: await db[name].find({}, {"_id": 0}).sort("id", 1).to_list(100)
            for name in set(COLLECTIONS)}


async def join(scenario):
    return await scenario.http.post("/api/auth/email-link/join", json=scenario.payload)


@pytest.mark.asyncio
async def test_real_concurrent_current_member_confirmation_preserves_later_role_edits(scenario):
    s = scenario
    await s.db.users.update_one({"id": "invitee"}, {"$set": {"family_group_id": "target", "family_group_role": "member"}})
    await s.db.members.update_one({"id": "self"}, {"$set": {
        "family_group_id": "target", "role": "family", "relationship": "Sibling",
    }})
    before = await s.db.members.find_one({"id": "self"})
    responses = await asyncio.gather(*[join(s) for _ in range(5)])
    assert all(r.status_code == 200 for r in responses), [r.text for r in responses]
    assert await s.db.members.find_one({"id": "self"}) == before
    invite = await s.db.family_invites.find_one({"id": "invitation"})
    assert invite["status"] == "accepted" and invite["accepted_by_user_id"] == "invitee"
    assert s.sent == []


@pytest.mark.asyncio
async def test_success_preserves_records_and_other_families(scenario, monkeypatch):
    s = scenario
    before = await snapshot(s.db)
    original = fg.ensure_self_member_row

    async def observe_pending(tx, user, group, *args, **kwargs):
        result = await original(tx, user, group, *args, **kwargs)
        assert (await tx.family_invites.find_one({"id": "invitation"}))["status"] == "pending"
        # Independent reads cannot see partially committed membership.
        assert (await s.db.users.find_one({"id": "invitee"}))["family_group_id"] == "solo"
        return result

    monkeypatch.setattr(fg, "ensure_self_member_row", observe_pending)
    result = await join(s)
    assert result.status_code == 200, result.text
    after = await snapshot(s.db)
    assert (await s.db.users.find_one({"id": "invitee"}))["family_group_id"] == "target"
    member = await s.db.members.find_one({"id": "self"})
    assert member["role"] == "senior" and member["relationship"] == "Parent"
    assert member["family_group_id"] == "target"
    assert await s.db.members.count_documents({"user_id": "invitee"}) == 1
    for collection in fg.DATA_COLLECTIONS:
        assert len(after[collection]) == len(before[collection])
        assert [r for r in after[collection] if r["id"] != ("self" if collection == "members" else collection)] == [
            r for r in before[collection] if r["id"] != ("self" if collection == "members" else collection)
        ]
        if collection != "members":
            row = await s.db[collection].find_one({"id": collection})
            assert row["preserve"] == "synthetic history" and row["family_group_id"] == "target"
    assert [u for u in after["users"] if u["id"] != "invitee"] == [
        u for u in before["users"] if u["id"] != "invitee"
    ]
    assert after["family_groups"] == [g for g in before["family_groups"] if g["id"] != "solo"]
    assert await s.db.family_groups.find_one({"id": "solo"}) is None
    assert (await s.db.family_invites.find_one({"id": "invitation"}))["status"] == "accepted"


@pytest.mark.asyncio
@pytest.mark.parametrize("stage", ["after_member", "after_accepted"])
async def test_real_transaction_rolls_back_and_allows_retry(scenario, monkeypatch, stage):
    s = scenario
    before = await snapshot(s.db)
    target = fg if stage == "after_member" else links
    name = "ensure_self_member_row" if stage == "after_member" else "join_verified"
    original = getattr(target, name)

    async def failing(*args, **kwargs):
        await original(*args, **kwargs)
        if stage == "after_accepted":
            assert (await args[0].family_invites.find_one({"id": "invitation"}))["status"] == "accepted"
        raise RuntimeError("Injected synthetic transaction failure")

    monkeypatch.setattr(target, name, failing)
    assert (await join(s)).status_code == 500
    assert await snapshot(s.db) == before
    monkeypatch.setattr(target, name, original)
    assert (await join(s)).status_code == 200
    assert (await s.db.family_invites.find_one({"id": "invitation"}))["status"] == "accepted"


@pytest.mark.asyncio
async def test_repeated_acceptance_keeps_later_edits_and_one_member(scenario):
    s = scenario
    assert (await join(s)).status_code == 200
    accepted = await s.db.family_invites.find_one({"id": "invitation"})
    await s.db.members.update_one({"id": "self"}, {"$set": {
        "role": "family", "relationship": "Edited later", "location_sharing_enabled": True,
    }})
    before = await snapshot(s.db)
    results = await asyncio.gather(*(join(s) for _ in range(3)))
    assert [r.status_code for r in results] == [200, 200, 200]
    assert await snapshot(s.db) == before
    assert (await s.db.family_invites.find_one({"id": "invitation"}))["accepted_at"] == accepted["accepted_at"]
    assert await s.db.members.count_documents({"user_id": "invitee"}) == 1


@pytest.mark.asyncio
async def test_concurrent_first_acceptance_is_idempotent(scenario):
    results = await asyncio.gather(*(join(scenario) for _ in range(3)))
    assert [r.status_code for r in results] == [200, 200, 200]
    assert await scenario.db.members.count_documents({"user_id": "invitee"}) == 1
    assert (await scenario.db.family_invites.find_one({"id": "invitation"}))["accepted_by_user_id"] == "invitee"


@pytest.mark.asyncio
async def test_server_write_conflict_retries_transaction(scenario):
    s = scenario
    initial = await s.mongo.admin.command({
        "configureFailPoint": "failCommand", "mode": {"times": 1},
        "data": {"failCommands": ["update"], "errorCode": 112,
                 "errorLabels": ["TransientTransactionError"], "appName": APP_NAME},
    })
    try:
        result = await join(s)
        assert result.status_code == 200, result.text
    finally:
        final = await s.mongo.admin.command({"configureFailPoint": "failCommand", "mode": "off"})
    assert final["count"] > initial["count"]
    assert await s.db.members.count_documents({"user_id": "invitee"}) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("obstacle", ["another_user", "dependent", "other_care_record", "wrong_email"])
async def test_existing_memberships_and_identity_fail_closed(scenario, obstacle):
    s = scenario
    if obstacle == "another_user":
        await s.db.users.insert_one({"id": "dependent", "family_group_id": "solo"})
    elif obstacle == "dependent":
        await s.db.members.insert_one({"id": "dependent", "family_group_id": "solo", "owner_id": "invitee"})
    elif obstacle == "other_care_record":
        await s.db.reminders.insert_one({"id": "other-care", "family_group_id": "solo", "member_id": "other", "owner_id": "invitee"})
    else:
        await s.db.users.update_one({"id": "invitee"}, {"$set": {"email": "different@example.com"}})
    before = await snapshot(s.db)
    assert (await join(s)).status_code == (403 if obstacle == "wrong_email" else 409)
    assert await snapshot(s.db) == before


@pytest.mark.asyncio
async def test_old_accepted_invitation_cannot_change_a_later_family(scenario):
    s = scenario
    assert (await join(s)).status_code == 200
    await s.db.users.update_one({"id": "invitee"}, {"$set": {"family_group_id": "unrelated"}})
    s.payload["previous_family_id"] = "unrelated"
    before = await snapshot(s.db)
    assert (await join(s)).status_code == 409
    assert await snapshot(s.db) == before


@pytest.mark.asyncio
@pytest.mark.parametrize("role", ["senior", "family"])
@pytest.mark.parametrize("inject_failure", [False, True])
async def test_new_profile_joins_inviting_family_without_creating_one(scenario, monkeypatch, role, inject_failure):
    s = scenario
    await s.db.users.delete_one({"id": "invitee"})
    await s.db.members.delete_one({"id": "self"})
    await s.db.family_invites.update_one({"id": "invitation"}, {"$set": {
        "invitee_name": "", "role": role,
    }})
    groups = await s.db.family_groups.count_documents({})
    request = await s.http.post("/api/auth/email-link/request", json={
        "challenge": links.digest(VERIFIER), "invite_token": s.invite["token"],
    })
    assert request.status_code == 200, request.text
    fragment = parse_qs(urlsplit(s.sent[-1].splitlines()[-1]).fragment)
    payload = {"token": fragment["token"][0], "verifier": VERIFIER}
    first = await s.http.post("/api/auth/email-link/verify", json=payload)
    assert first.json() == {"needs_profile": True, "invited": True}
    completed = {**payload, "full_name": "Synthetic New Member", "create_family": False}
    if inject_failure:
        before = await snapshot(s.db)
        original = fg.ensure_self_member_row

        async def fail_after_creation(*args, **kwargs):
            await original(*args, **kwargs)
            raise RuntimeError("Injected synthetic new-profile failure")

        monkeypatch.setattr(fg, "ensure_self_member_row", fail_after_creation)
        assert (await s.http.post("/api/auth/email-link/verify", json=completed)).status_code == 500
        assert await snapshot(s.db) == before
        assert (await s.db.email_links.find_one({"_id": links.digest(payload["token"])}))["used"] is False
        monkeypatch.setattr(fg, "ensure_self_member_row", original)
    result = await s.http.post("/api/auth/email-link/verify", json=completed)
    assert result.status_code == 200, result.text
    body = result.json()
    assert body["user"]["family_group_id"] == "target"
    assert body["invite_pending"] is False
    member = await s.db.members.find_one({"user_id": body["user"]["id"]})
    assert member["role"] == role
    assert await s.db.family_groups.count_documents({}) == groups
