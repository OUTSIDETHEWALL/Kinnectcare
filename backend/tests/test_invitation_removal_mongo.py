"""Removal/acceptance regressions against an owned loopback replica, never Atlas.

The OTP adapter executes the actual retained endpoint's AST without importing
the production server (which would initialize live clients and schedulers).
Only identity-proof/token-response seams are replaced with synthetic test seams.
"""
import ast
import asyncio
import logging
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import pytest
from fastapi import HTTPException

from test_email_links_mongo_integration import (
    fg, links, local_replica, scenario, snapshot, pytestmark,
)


def retained_otp(db):
    path = Path(__file__).resolve().parents[1] / "server.py"
    source = ast.parse(path.read_text())
    endpoint = next(n for n in source.body if isinstance(n, ast.AsyncFunctionDef) and n.name == "verify_otp")
    endpoint.decorator_list = []
    namespace = {
        "db": db, "fg": fg, "el": links, "OtpVerify": SimpleNamespace,
        "datetime": datetime, "timedelta": timedelta, "timezone": timezone,
        "uuid": uuid, "ZoneInfo": ZoneInfo, "ZoneInfoNotFoundError": ZoneInfoNotFoundError,
        "HTTPException": HTTPException, "logger": logging.getLogger(__name__),
        "OTP_LENGTH": 6, "OTP_MAX_ATTEMPTS": 5,
        "verify_password": lambda code, stored: code == stored,
        "TokenResponse": lambda **values: values,
        "create_access_token": lambda uid: "synthetic-session:" + uid,
        "_user_response": lambda user: {k: v for k, v in user.items() if k != "_id"},
    }
    async def push(*args):
        pass
    namespace["push_to_user"] = push
    exec(compile(ast.Module(body=[endpoint], type_ignores=[]), str(path), "exec"), namespace)
    return namespace["verify_otp"]


async def accept(s, mode):
    if mode == "email":
        user = await s.db.users.find_one({"id": "invitee"})
        return await s.http.post("/api/auth/email-link/join", json={
            **s.payload, "previous_family_id": user.get("family_group_id"),
        })
    if mode == "legacy":
        return await s.http.post("/api/family-group/join", headers={"x-test-actor": "invitee"},
                                 json={"invite_code": s.invite["token"]})
    await s.db.otp_codes.insert_one({
        "email": "invitee@example.com", "code_hash": "123456", "purpose": "signup",
        "invite_code": s.invite["token"], "expires_at": datetime.now(timezone.utc) + timedelta(minutes=5),
    })
    try:
        body = await retained_otp(s.db)(SimpleNamespace(email="invitee@example.com", code="123456"))
        return SimpleNamespace(status_code=200, json=lambda: body)
    except HTTPException as error:
        return SimpleNamespace(status_code=error.status_code)


async def remove(s):
    return await s.http.post("/api/family-group/remove-member", json={"user_id": "invitee"})


@pytest.mark.asyncio
async def test_owner_removal_moves_only_verified_self_records(scenario):
    s = scenario
    assert (await accept(s, "email")).status_code == 200
    await s.db.checkins.insert_many([
        {"id": "self-checkin", "member_id": "self", "owner_id": "invitee", "family_group_id": "target"},
        {"id": "unrelated-checkin", "member_id": "self", "owner_id": "invitee", "family_group_id": "unrelated"},
    ])
    original = await s.db.checkins.find_one({"id": "unrelated-checkin"})
    result = await remove(s)
    assert result.status_code == 200, result.text
    new_group = (await s.db.users.find_one({"id": "invitee"}))["family_group_id"]
    assert (await s.db.checkins.find_one({"id": "self-checkin"}))["family_group_id"] == new_group
    assert await s.db.checkins.find_one({"id": "unrelated-checkin"}) == original


@pytest.mark.asyncio
async def test_owner_removal_requires_dependent_care_handoff(scenario):
    s = scenario
    assert (await accept(s, "email")).status_code == 200
    await s.db.members.insert_one({
        "id": "dependent", "owner_id": "invitee", "family_group_id": "target",
    })
    before = await snapshot(s.db)
    assert (await remove(s)).status_code == 409
    assert await snapshot(s.db) == before
    # A completed explicit handoff leaves the dependent in the source.
    await s.db.members.update_one({"id": "dependent"}, {"$set": {"owner_id": "owner"}})
    assert (await remove(s)).status_code == 200
    assert (await s.db.members.find_one({"id": "dependent"}))["family_group_id"] == "target"


@pytest.mark.asyncio
async def test_owner_removal_preserves_active_sos_without_partial_changes(scenario):
    s = scenario
    assert (await accept(s, "email")).status_code == 200
    await s.db.alerts.insert_one({
        "id": "active-incident", "family_group_id": "target", "owner_id": "owner",
        "member_id": "self", "type": "sos", "resolved": False,
    })
    before = await snapshot(s.db)
    assert (await remove(s)).status_code == 409
    assert await snapshot(s.db) == before


async def alternate_join(s):
    # Legitimate family-wide entry leaves the separate emailed invitation pending.
    await s.db.family_groups.update_one({"id": "target"}, {"$set": {"invite_code": "KINN-TARGET"}})
    result = await s.http.post("/api/family-group/join", headers={"x-test-actor": "invitee"},
                               json={"invite_code": "KINN-TARGET"})
    assert result.status_code == 200, result.text
    assert (await s.db.family_invites.find_one({"id": "invitation"}))["status"] == "pending"


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["email", "legacy", "otp"])
async def test_alternate_join_removal_invalidates_all_recipient_invites(scenario, mode):
    s = scenario
    await alternate_join(s)
    other = {**s.invite, "id": "second", "token": "INV-" + "B" * 64,
             "invitee_email": "INVITEE@EXAMPLE.COM"}
    untouched = {**s.invite, "id": "other-recipient", "token": "INV-" + "C" * 64,
                 "invitee_email": "other@example.com"}
    outside = {**s.invite, "id": "other-family", "token": "INV-" + "D" * 64,
               "family_group_id": "unrelated"}
    await s.db.family_invites.insert_many([other, untouched, outside])
    before = await snapshot(s.db)
    status = await s.http.post("/api/auth/email-link/invitation/status", json={"invite_token": s.invite["token"]})
    assert status.json()["already_member"] is True
    assert await snapshot(s.db) == before  # Recovery stays read-only.
    assert (await remove(s)).status_code == 200
    removed = await snapshot(s.db)
    solo_id = (await s.db.users.find_one({"id": "invitee"}))["family_group_id"]
    for collection in fg.DATA_COLLECTIONS:
        assert len(removed[collection]) == len(before[collection])
        for row in removed[collection]:
            if row.get("owner_id") == "invitee":
                assert row["family_group_id"] == solo_id
    assert (await accept(s, mode)).status_code == 410
    assert await snapshot(s.db) == removed
    for iid in ("invitation", "second"):
        assert (await s.db.family_invites.find_one({"id": iid}))["status"] == "revoked"
    for iid in ("other-recipient", "other-family"):
        assert (await s.db.family_invites.find_one({"id": iid}))["status"] == "pending"
    assert (await s.db.users.find_one({"id": "owner"}))["family_group_role"] == "owner"


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["email", "legacy", "otp"])
async def test_acceptance_read_before_removal_cannot_commit_after_it(scenario, monkeypatch, mode):
    s = scenario
    await alternate_join(s)
    entered, release = asyncio.Event(), asyncio.Event()
    original = links.join_verified
    first = True

    async def paused(*args):
        nonlocal first
        if first:
            first = False
            entered.set()
            await asyncio.wait_for(release.wait(), 10)
        return await original(*args)

    monkeypatch.setattr(links, "join_verified", paused)
    accepting = asyncio.create_task(accept(s, mode))
    try:
        await asyncio.wait_for(entered.wait(), 10)
        assert (await remove(s)).status_code == 200
    finally:
        release.set()
    assert (await asyncio.wait_for(accepting, 15)).status_code == 410
    assert (await s.db.users.find_one({"id": "invitee"}))["family_group_id"] != "target"
    assert (await s.db.family_invites.find_one({"id": "invitation"}))["status"] == "revoked"


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["email", "legacy", "otp"])
async def test_acceptance_committed_before_removal_cannot_be_replayed(scenario, mode):
    s = scenario
    assert (await accept(s, mode)).status_code == 200
    member = await s.db.members.find_one({"id": "self"})
    assert member["role"] == "senior" and member["relationship"] == "Parent"
    assert (await remove(s)).status_code == 200
    before = await snapshot(s.db)
    assert (await accept(s, mode)).status_code in (409, 410)
    assert await snapshot(s.db) == before
    assert await s.db.members.count_documents({"user_id": "invitee"}) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["email", "legacy", "otp"])
async def test_removal_overlapping_uncommitted_acceptance_leaves_member_removed(scenario, monkeypatch, mode):
    s = scenario
    await alternate_join(s)
    accepted_writes, removal_started, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
    original_join, original_owner = links.join_verified, fg.require_group_owner
    first = True

    async def pause_after_writes(*args):
        nonlocal first
        user = await original_join(*args)
        if first:
            first = False
            accepted_writes.set()
            await asyncio.wait_for(release.wait(), 10)
        return user

    async def observe_removal(*args):
        group = await original_owner(*args)
        removal_started.set()
        return group

    monkeypatch.setattr(links, "join_verified", pause_after_writes)
    monkeypatch.setattr(fg, "require_group_owner", observe_removal)
    accepting = asyncio.create_task(accept(s, mode))
    removing = None
    try:
        await asyncio.wait_for(accepted_writes.wait(), 10)
        removing = asyncio.create_task(remove(s))
        await asyncio.wait_for(removal_started.wait(), 10)
    finally:
        release.set()
    accepted, removed = await asyncio.wait_for(asyncio.gather(accepting, removing), 20)
    assert accepted.status_code == 200
    assert removed.status_code == 200
    assert (await s.db.users.find_one({"id": "invitee"}))["family_group_id"] != "target"
    assert await s.db.members.count_documents({"user_id": "invitee", "family_group_id": "target"}) == 0
    assert (await accept(s, mode)).status_code in (409, 410)


@pytest.mark.asyncio
async def test_removal_failure_rolls_back_revocation_membership_and_data(scenario, monkeypatch):
    s = scenario
    await alternate_join(s)
    before = await snapshot(s.db)
    original = fg.create_group_for_user

    async def fail(tx, user):
        await original(tx, user)
        raise RuntimeError("Injected removal failure after membership and revocation writes")

    monkeypatch.setattr(fg, "create_group_for_user", fail)
    assert (await remove(s)).status_code == 500
    assert await snapshot(s.db) == before
    monkeypatch.setattr(fg, "create_group_for_user", original)
    assert (await remove(s)).status_code == 200


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["legacy", "otp"])
async def test_retained_invitation_acceptance_preserves_owner_and_dependent_safeguards(scenario, mode):
    s = scenario
    await s.db.members.insert_one({
        "id": "dependent", "owner_id": "invitee", "family_group_id": "solo", "name": "Dependent",
    })
    before = await snapshot(s.db)
    assert (await accept(s, mode)).status_code == 409
    assert await snapshot(s.db) == before


@pytest.mark.asyncio
async def test_retained_otp_new_account_consumes_invitation_atomically(scenario, monkeypatch):
    s = scenario
    await s.db.users.delete_one({"id": "invitee"})
    await s.db.members.delete_one({"id": "self"})
    before = await snapshot(s.db)
    original = links.join_verified

    async def failing(*args):
        await original(*args)
        raise RuntimeError("Injected new OTP invitation failure")

    monkeypatch.setattr(links, "join_verified", failing)
    with pytest.raises(RuntimeError, match="Injected"):
        await accept(s, "otp")
    assert await snapshot(s.db) == before
    monkeypatch.setattr(links, "join_verified", original)
    result = await accept(s, "otp")
    assert result.status_code == 200
    user = result.json()["user"]
    assert user["family_group_id"] == "target"
    member = await s.db.members.find_one({"user_id": user["id"]})
    assert member["role"] == "senior" and member["relationship"] == "Parent"
    assert (await s.db.family_invites.find_one({"id": "invitation"}))["status"] == "accepted"


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["legacy", "otp"])
async def test_retained_acceptance_is_idempotent_and_preserves_later_role_edits(scenario, mode):
    s = scenario
    assert (await accept(s, mode)).status_code == 200
    await s.db.members.update_one({"id": "self"}, {"$set": {"role": "family", "relationship": "Edited"}})
    before = await snapshot(s.db)
    assert (await accept(s, mode)).status_code == 200
    assert await snapshot(s.db) == before


@pytest.mark.asyncio
@pytest.mark.parametrize("actor", ["invitee", "missing", "other-owner"])
async def test_removal_requires_current_family_owner(scenario, actor):
    s = scenario
    await alternate_join(s)
    if actor == "other-owner":
        await s.db.users.insert_one({"id": actor, "family_group_id": "unrelated", "email": "other@example.com"})
        await s.db.family_groups.update_one({"id": "unrelated"}, {"$set": {"owner_user_id": actor}})
    before = await snapshot(s.db)
    result = await s.http.post("/api/family-group/remove-member",
                               headers={"x-test-actor": actor}, json={"user_id": "invitee"})
    assert result.status_code in (400, 401, 403, 404)
    assert await snapshot(s.db) == before


@pytest.mark.asyncio
async def test_preissued_email_signin_cannot_redeem_removed_invitation(scenario):
    from urllib.parse import parse_qs, urlsplit
    s = scenario
    await alternate_join(s)
    verifier = "1" * 64
    response = await s.http.post("/api/auth/email-link/request", json={
        "invite_token": s.invite["token"], "challenge": links.digest(verifier),
    })
    assert response.status_code == 200
    token = parse_qs(urlsplit(s.sent[-1].splitlines()[-1]).fragment)["token"][0]
    assert (await remove(s)).status_code == 200
    before = await snapshot(s.db)
    result = await s.http.post("/api/auth/email-link/verify", json={"token": token, "verifier": verifier})
    assert result.status_code == 410
    assert await snapshot(s.db) == before
    assert (await s.db.email_links.find_one({"_id": links.digest(token)}))["used"] is False
