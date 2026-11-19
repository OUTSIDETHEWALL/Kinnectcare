"""Real rotation/admission transactions, synthetic loopback storage and no sends.

KINNSHIP_RUN_LOCAL_MONGO_TESTS=1 PYTHONPATH=backend python -m pytest \
    backend/tests/test_family_code_rotation.py -q
"""
import ast
import asyncio
import copy
import socket
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import jwt
import pytest
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from test_email_links_mongo_integration import (
    fg, links, local_replica, scenario, snapshot, join, pytestmark,
)
from test_family_write_fence_mongo import otp_app, otp_request

OLD_CODE = "KINN-OLDCODE"
ROTATE = "/api/family-group/regenerate-code"


@pytest.fixture(autouse=True)
def loopback_only(monkeypatch):
    original = socket.socket.connect
    original_ex = socket.socket.connect_ex

    def check(address):
        if isinstance(address, tuple) and address[0] not in ("127.0.0.1", "::1", "localhost"):
            raise AssertionError("Rotation tests may not connect outside loopback")

    def connect(sock, address):
        check(address)
        return original(sock, address)

    def connect_ex(sock, address):
        check(address)
        return original_ex(sock, address)

    monkeypatch.setattr(socket.socket, "connect", connect)
    monkeypatch.setattr(socket.socket, "connect_ex", connect_ex)


async def prepare(s):
    await s.db.family_groups.update_one({"id": "target"}, {"$set": {"invite_code": OLD_CODE}})


@asynccontextmanager
async def retained_session(db, actor, *, real_auth=False, bearer=None):
    async def current():
        return copy.deepcopy(actor)

    # Execute the real server's router creation/registration statements,
    # avoiding import-time services, startup work and production environment.
    tree = ast.parse((Path(__file__).resolve().parents[1] / "server.py").read_text())
    setup = next(n for n in tree.body if isinstance(n, ast.Assign)
                 and any(isinstance(t, ast.Name) and t.id == "api_router" for t in n.targets))
    registration = [
        n for n in tree.body if isinstance(n, ast.Expr) and isinstance(n.value, ast.Call)
        and isinstance(n.value.func, ast.Attribute) and n.value.func.attr == "include_router"
        and (
            isinstance(n.value.func.value, ast.Name) and n.value.func.value.id == "api_router"
            and n.value.args and isinstance(n.value.args[0], ast.Call)
            and isinstance(n.value.args[0].func, ast.Attribute)
            and isinstance(n.value.args[0].func.value, ast.Name)
            and n.value.args[0].func.value.id == "fg"
            or isinstance(n.value.func.value, ast.Name) and n.value.func.value.id == "app"
            and n.value.args and isinstance(n.value.args[0], ast.Name)
            and n.value.args[0].id == "api_router"
        )
    ]
    assert len(registration) == 2
    app = FastAPI()
    scope = {"app": app, "APIRouter": APIRouter, "fg": fg, "db": db,
             "get_current_user": current, "push_to_user": None,
             "send_email_via_resend_async": None, "get_authenticated_user": current}
    headers = {}
    if real_auth:
        # Compile the actual authentication dependencies. Sign with a synthetic
        # test key; never import the server or read production configuration.
        scope.update({
            "Request": Request, "HTTPAuthorizationCredentials": HTTPAuthorizationCredentials,
            "Depends": Depends, "security": HTTPBearer(), "HTTPException": HTTPException,
            "jwt": jwt, "SECRET_KEY": "synthetic-rotation-signing-key-not-a-production-secret",
            "ALGORITHM": "HS256",
        })
        dependencies = [n for n in tree.body if isinstance(n, ast.AsyncFunctionDef)
                        and n.name in ("get_authenticated_user", "get_current_user")]
        assert len(dependencies) == 2
        exec(compile(ast.Module(body=dependencies, type_ignores=[]), "server-auth", "exec"), scope)
        if bearer is None:
            bearer = jwt.encode({"sub": actor["id"]}, scope["SECRET_KEY"], algorithm="HS256")
        if bearer:
            headers["Authorization"] = "Bearer " + bearer
    exec(compile(ast.Module(body=[setup, *registration], type_ignores=[]), "server-router", "exec"), scope)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="https://test.invalid", headers=headers,
    ) as http:
        yield http


@pytest.mark.asyncio
async def test_real_server_registers_existing_client_rotation_url(scenario):
    s = scenario
    await prepare(s)
    actor = await s.db.users.find_one({"id": "owner"})
    async with retained_session(s.db, actor) as http:
        response = await http.post(ROTATE)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["ok"] is True
    assert result["invite_code"] == result["group"]["invite_code"] != OLD_CODE
    assert (await s.db.family_groups.find_one({"id": "target"}))["invite_code"] == result["invite_code"]
    client = (Path(__file__).resolve().parents[2] / "frontend/src/api.ts").read_text()
    assert "api.post('/family-group/regenerate-code')" in client


@pytest.mark.asyncio
async def test_rotation_changes_only_wall_code_and_fence_preserving_invites(scenario):
    s = scenario
    await prepare(s)
    before = await snapshot(s.db)
    response = await s.http.post(ROTATE)
    assert response.status_code == 200, response.text
    after = await snapshot(s.db)
    for name in before:
        if name != "family_groups":
            assert before[name] == after[name], name
    expected = next(row for row in before["family_groups"] if row["id"] == "target")
    actual = next(row for row in after["family_groups"] if row["id"] == "target")
    assert {k: v for k, v in actual.items() if k not in ("invite_code", "family_write_epoch")} == {
        k: v for k, v in expected.items() if k not in ("invite_code", "family_write_epoch")
    }
    assert actual["family_write_epoch"] == expected.get("family_write_epoch", 0) + 1
    assert s.sent == []


@pytest.mark.asyncio
async def test_old_preview_and_join_fail_new_code_joins(scenario):
    s = scenario
    await prepare(s)
    assert (await s.http.get("/api/family-group/verify-invite/" + OLD_CODE)).json()["valid"] is True
    response = await s.http.post(ROTATE)
    assert response.status_code == 200, response.text
    code = response.json()["invite_code"]
    assert (await s.http.get("/api/family-group/verify-invite/" + OLD_CODE)).json()["valid"] is False
    before = await snapshot(s.db)
    rejected = await s.http.post("/api/family-group/join", headers={"x-test-actor": "invitee"},
                                 json={"invite_code": OLD_CODE})
    assert rejected.status_code == 404, rejected.text
    assert await snapshot(s.db) == before
    accepted = await s.http.post("/api/family-group/join", headers={"x-test-actor": "invitee"},
                                 json={"invite_code": code})
    assert accepted.status_code == 200, accepted.text
    assert (await s.db.users.find_one({"id": "invitee"}))["family_group_id"] == "target"
    assert (await s.db.family_invites.find_one({"id": "invitation"}))["status"] == "pending"


@pytest.mark.asyncio
@pytest.mark.parametrize("cached_role", ["owner", "member"])
async def test_authoritative_owner_not_cached_role_controls_rotation(scenario, cached_role):
    s = scenario
    await prepare(s)
    actor = await s.db.users.find_one({"id": "owner"})
    actor["family_group_role"] = cached_role
    # Owner still works when convenience role says member.
    async with retained_session(s.db, actor) as http:
        assert (await http.post(ROTATE)).status_code == 200
        # Cached owner status cannot override authoritative loss of ownership.
        await s.db.family_groups.update_one({"id": "target"}, {"$set": {"owner_user_id": "someone-else"}})
        before = await snapshot(s.db)
        rejected = await http.post(ROTATE)
        assert rejected.status_code == 403, rejected.text
        assert await snapshot(s.db) == before


@pytest.mark.asyncio
@pytest.mark.parametrize("change,expected_status", [("moved", 409), ("owner", 403), ("deleted", 401)])
async def test_rotation_waiter_rechecks_membership_and_authority(scenario, monkeypatch, change, expected_status):
    s = scenario
    await prepare(s)
    original = fg.fw.run
    entered, release = asyncio.Event(), asyncio.Event()

    async def wait_before_fence(*args, **kwargs):
        entered.set()
        await asyncio.wait_for(release.wait(), 5)
        return await original(*args, **kwargs)

    monkeypatch.setattr(fg.fw, "run", wait_before_fence)
    pending = asyncio.create_task(s.http.post(ROTATE))
    try:
        await asyncio.wait_for(entered.wait(), 5)
        if change == "moved":
            await s.db.users.update_one({"id": "owner"}, {"$set": {"family_group_id": "unrelated"}})
        elif change == "deleted":
            await s.db.users.delete_one({"id": "owner"})
        else:
            await s.db.family_groups.update_one({"id": "target"}, {"$set": {"owner_user_id": "someone-else"}})
        before = await snapshot(s.db)
    finally:
        release.set()
    response = await asyncio.wait_for(pending, 10)
    assert response.status_code == expected_status, response.text
    assert await snapshot(s.db) == before


@pytest.mark.asyncio
async def test_nonowner_and_missing_setup_never_create_or_mutate_membership(scenario):
    s = scenario
    await prepare(s)
    await s.db.users.update_one({"id": "invitee"}, {"$set": {
        "family_group_id": "target", "family_group_role": "owner",
    }})
    before = await snapshot(s.db)
    response = await s.http.post(ROTATE, headers={"x-test-actor": "invitee"})
    assert response.status_code == 403, response.text
    assert await snapshot(s.db) == before
    await s.db.users.update_one({"id": "invitee"}, {"$unset": {"family_group_id": ""}})
    before = await snapshot(s.db)
    response = await s.http.post(ROTATE, headers={"x-test-actor": "invitee"})
    assert response.status_code == 409, response.text
    assert await snapshot(s.db) == before
    assert (await s.http.post(ROTATE, headers={"x-test-actor": "missing"})).status_code == 401


@pytest.mark.asyncio
async def test_retained_invitation_still_accepts_after_rotation(scenario):
    s = scenario
    await prepare(s)
    before = await s.db.family_invites.find_one({"id": "invitation"})
    assert (await s.http.post(ROTATE)).status_code == 200
    assert await s.db.family_invites.find_one({"id": "invitation"}) == before
    accepted = await join(s)
    assert accepted.status_code == 200, accepted.text
    assert (await s.db.family_invites.find_one({"id": "invitation"}))["status"] == "accepted"
    assert (await s.db.users.find_one({"id": "invitee"}))["family_group_id"] == "target"
    assert s.sent == []


@pytest.mark.asyncio
async def test_concurrent_rotations_are_serialized_and_never_return_old_code(scenario):
    s = scenario
    await prepare(s)
    original = await snapshot(s.db)
    responses = await asyncio.gather(*[s.http.post(ROTATE) for _ in range(4)])
    assert all(r.status_code == 200 for r in responses), [r.text for r in responses]
    codes = [r.json()["invite_code"] for r in responses]
    assert len(set(codes)) == len(codes) and OLD_CODE not in codes
    final = (await s.db.family_groups.find_one({"id": "target"}))["invite_code"]
    assert final in codes
    for code in [OLD_CODE, *codes]:
        result = await s.http.get("/api/family-group/verify-invite/" + code)
        assert result.json()["valid"] is (code == final)
    after = await snapshot(s.db)
    assert after["users"] == original["users"]
    assert after["members"] == original["members"]
    assert after["family_invites"] == original["family_invites"]


@pytest.mark.asyncio
@pytest.mark.parametrize("retained_otp,new_account", [(False, False), (True, False), (True, True)])
async def test_rotation_commits_before_waiting_old_code_admission(scenario, monkeypatch, retained_otp, new_account):
    s = scenario
    await prepare(s)
    if retained_otp:
        email = await otp_request(s, new_account)
        # The retained OTP is valid but carries the old wall code.
        await s.db.family_groups.update_one({"id": "target"}, {"$set": {"invite_code": OLD_CODE}})
        await s.db.otp_codes.update_many({}, {"$set": {"invite_code": OLD_CODE}})
    entered, release = asyncio.Event(), asyncio.Event()
    original = fg.fw.acquire
    first = True

    async def before_admission_fence(tx, families):
        nonlocal first
        # Pause the admission's first destination fence, after its old-code
        # read. Let the later rotation acquire that same family and commit.
        if first and not tx.families and "target" in families:
            first = False
            entered.set()
            await asyncio.wait_for(release.wait(), 5)
        return await original(tx, families)

    monkeypatch.setattr(fg.fw, "acquire", before_admission_fence)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(
        app=otp_app(s.db), raise_app_exceptions=False), base_url="https://test.invalid",
    ) as otp:
        pending = asyncio.create_task(
            otp.post("/api/auth/verify-otp", json={"email": email, "code": "123456"})
            if retained_otp else s.http.post("/api/family-group/join",
                                            headers={"x-test-actor": "invitee"}, json={"invite_code": OLD_CODE})
        )
        try:
            await asyncio.wait_for(entered.wait(), 5)
            response = await s.http.post(ROTATE)
            assert response.status_code == 200, response.text
        finally:
            release.set()
        response = await asyncio.wait_for(pending, 10)
    assert response.status_code in (404, 410), response.text
    if new_account:
        assert await s.db.users.find_one({"email": email}) is None
    else:
        assert (await s.db.users.find_one({"id": "invitee"}))["family_group_id"] == "solo"
    assert (await s.db.family_invites.find_one({"id": "invitation"}))["status"] == "pending"


@pytest.mark.asyncio
async def test_admission_commits_first_rotation_preserves_legitimate_membership(scenario, monkeypatch):
    s = scenario
    await prepare(s)
    entered, release = asyncio.Event(), asyncio.Event()
    original = links.join_verified

    async def after_admission_fence(*args, **kwargs):
        entered.set()
        await asyncio.wait_for(release.wait(), 5)
        return await original(*args, **kwargs)

    monkeypatch.setattr(links, "join_verified", after_admission_fence)
    pending = asyncio.create_task(s.http.post("/api/family-group/join",
                                            headers={"x-test-actor": "invitee"}, json={"invite_code": OLD_CODE}))
    rotation = None
    try:
        await asyncio.wait_for(entered.wait(), 5)
        rotation = asyncio.create_task(s.http.post(ROTATE))
        await asyncio.sleep(.03)
        release.set()
        accepted, rotated = await asyncio.wait_for(asyncio.gather(pending, rotation), 10)
    finally:
        release.set()
        await asyncio.gather(pending, *([rotation] if rotation else []), return_exceptions=True)
    assert accepted.status_code == rotated.status_code == 200, (accepted.text, rotated.text)
    assert (await s.db.users.find_one({"id": "invitee"}))["family_group_id"] == "target"
    assert (await s.db.family_groups.find_one({"id": "target"}))["invite_code"] != OLD_CODE


@pytest.mark.asyncio
async def test_rotation_failure_rolls_back_fence_and_code(scenario, monkeypatch):
    s = scenario
    await prepare(s)
    before = await snapshot(s.db)

    async def fail(tx):
        await tx.family_groups.update_one({"id": "target"}, {"$set": {"invite_code": "KINN-UNCOMMITTED"}})
        raise RuntimeError("Synthetic generation failure")

    monkeypatch.setattr(fg, "_generate_unique_invite_code", fail)
    response = await s.http.post(ROTATE)
    assert response.status_code == 500
    assert await snapshot(s.db) == before


@pytest.mark.asyncio
async def test_same_or_other_active_code_is_rejected_by_generator(scenario, monkeypatch):
    s = scenario
    await prepare(s)
    await s.db.family_groups.update_one({"id": "unrelated"}, {"$set": {"invite_code": "KINN-OTHER"}})
    codes = iter([OLD_CODE, "KINN-OTHER", "KINN-FRESH"])
    monkeypatch.setattr(fg, "generate_invite_code", lambda: next(codes))
    response = await s.http.post(ROTATE)
    assert response.status_code == 200, response.text
    assert response.json()["invite_code"] == "KINN-FRESH"


@pytest.mark.asyncio
async def test_stale_session_family_cannot_redirect_rotation(scenario):
    s = scenario
    await prepare(s)
    actor = await s.db.users.find_one({"id": "owner"})
    actor["family_group_id"] = "unrelated"
    before = await s.db.family_groups.find_one({"id": "unrelated"})
    async with retained_session(s.db, actor) as http:
        response = await http.post(ROTATE)
    assert response.status_code == 200, response.text
    assert response.json()["group"]["id"] == "target"
    assert await s.db.family_groups.find_one({"id": "unrelated"}) == before


@pytest.mark.asyncio
async def test_recipient_invitation_acceptance_and_rotation_can_overlap(scenario):
    s = scenario
    await prepare(s)
    accepted, rotated = await asyncio.gather(join(s), s.http.post(ROTATE))
    assert accepted.status_code == rotated.status_code == 200, (accepted.text, rotated.text)
    assert (await s.db.users.find_one({"id": "invitee"}))["family_group_id"] == "target"
    assert (await s.db.family_invites.find_one({"id": "invitation"}))["status"] == "accepted"


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["revoked", "expired", "accepted"])
async def test_rotation_never_revives_invalid_recipient_invitation(scenario, status):
    s = scenario
    await prepare(s)
    await s.db.family_invites.update_one({"id": "invitation"}, {"$set": {
        "status": status, "accepted_by_user_id": "someone-else",
    }})
    before = await s.db.family_invites.find_one({"id": "invitation"})
    assert (await s.http.post(ROTATE)).status_code == 200
    rejected = await join(s)
    assert rejected.status_code == 410, rejected.text
    assert await s.db.family_invites.find_one({"id": "invitation"}) == before
    assert (await s.db.users.find_one({"id": "invitee"}))["family_group_id"] == "solo"


@pytest.mark.asyncio
@pytest.mark.parametrize("family_scope", [None, "dangling-family"])
async def test_real_auth_rotation_never_provisions_or_backfills_family(scenario, family_scope):
    s = scenario
    actor = await s.db.users.find_one({"id": "owner"})
    await s.db.users.update_one({"id": actor["id"]}, {"$set": {"family_group_id": family_scope}})
    for collection in fg.DATA_COLLECTIONS:
        await s.db[collection].insert_one({"id": "unscoped-" + collection, "owner_id": actor["id"]})
    before = await snapshot(s.db)
    async with retained_session(s.db, actor, real_auth=True) as http:
        response = await http.post(ROTATE)
        assert response.status_code == 409, response.text
        assert await snapshot(s.db) == before
        # Ordinary legacy setup still works on its existing authenticated path.
        setup = await http.get("/api/family-group")
        assert setup.status_code == 200, setup.text
    fresh = await s.db.users.find_one({"id": actor["id"]})
    assert fresh["family_group_id"] not in (None, "dangling-family", "target")
    assert await s.db.family_groups.find_one({"id": fresh["family_group_id"], "owner_user_id": actor["id"]})


@pytest.mark.asyncio
async def test_real_signed_owner_can_rotate_without_authentication_side_effects(scenario):
    s = scenario
    await prepare(s)
    actor = await s.db.users.find_one({"id": "owner"})
    before = await snapshot(s.db)
    async with retained_session(s.db, actor, real_auth=True) as http:
        response = await http.post(ROTATE)
    assert response.status_code == 200, response.text
    after = await snapshot(s.db)
    assert after["users"] == before["users"]
    assert after["members"] == before["members"]
    assert after["family_invites"] == before["family_invites"]


@pytest.mark.asyncio
@pytest.mark.parametrize("token_case,expected_status", [
    ("missing", 403), ("invalid", 401), ("expired", 401), ("deleted", 401),
])
async def test_real_auth_rejects_missing_invalid_expired_or_deleted_identity(scenario, token_case, expected_status):
    s = scenario
    actor = await s.db.users.find_one({"id": "owner"})
    key = "synthetic-rotation-signing-key-not-a-production-secret"
    bearer = ""
    if token_case == "invalid":
        bearer = jwt.encode({"sub": actor["id"]}, key + "-wrong", algorithm="HS256")
    elif token_case == "expired":
        bearer = jwt.encode({"sub": actor["id"], "exp": 1}, key, algorithm="HS256")
    elif token_case == "deleted":
        bearer = jwt.encode({"sub": "nonexistent-account"}, key, algorithm="HS256")
    before = await snapshot(s.db)
    async with retained_session(s.db, actor, real_auth=True, bearer=bearer) as http:
        response = await http.post(ROTATE)
    assert response.status_code == expected_status, response.text
    assert await snapshot(s.db) == before
