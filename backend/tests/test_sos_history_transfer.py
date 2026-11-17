"""Synthetic loopback-only SOS retention/authorization/transaction regressions."""
import asyncio
import ast
import copy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI, HTTPException, Request

from test_email_links_mongo_integration import (
    fg, links, local_replica, scenario, snapshot, join, pytestmark,
)
import sos_history as sh


async def history(s, **changes):
    row = {
        "id": "historical-sos", "owner_id": "invitee", "member_id": "invitee",
        "family_group_id": "solo", "type": "sos", "resolved": True,
        "acknowledged": True,
        "created_at": datetime.now(timezone.utc) - timedelta(days=2),
        "resolved_at": datetime.now(timezone.utc) - timedelta(days=1),
        "resolved_by_user_id": "prior-caregiver",
        "latitude": 12.34, "longitude": 56.78,
        "message": "Private historical coordinates and caregiver context",
        "unknown_audit_field": {"must": ["survive", "unchanged"]},
    }
    row.update(changes)
    await s.db.alerts.insert_one(copy.deepcopy(row))
    return await s.db.alerts.find_one({"id": row["id"]})


@pytest.mark.asyncio
@pytest.mark.parametrize("subject", ["invitee", "self"])
@pytest.mark.parametrize("role", ["senior", "family"])
async def test_join_retains_exact_bson_history_and_role_retry(scenario, subject, role):
    s = scenario
    await s.db.family_invites.update_one({"id": "invitation"}, {"$set": {"role": role}})
    original = await history(s, member_id=subject)
    assert (await join(s)).status_code == 200
    assert await s.db.alerts.find_one({"id": original["id"]}) == original
    assert await s.db.family_groups.find_one({"id": "solo"})
    member = await s.db.members.find_one({"id": "self"})
    assert member["family_group_id"] == "target" and member["role"] == role
    assert member["location_sharing_enabled"] is False
    accepted = await s.db.family_invites.find_one({"id": "invitation"})
    before = await snapshot(s.db)
    assert (await join(s)).status_code == 200
    assert await snapshot(s.db) == before
    assert (await s.db.family_invites.find_one({"id": "invitation"}))["accepted_at"] == accepted["accepted_at"]


@pytest.mark.asyncio
@pytest.mark.parametrize("change", [
    {"resolved": False}, {"resolved": None}, {"resolved": "true"}, {"resolved": 1},
    {"type": "medication"}, {"owner_id": "other"},
    {"member_id": "dependent"}, {"member_id": "missing-historical-member"},
])
async def test_nonqualifying_history_blocks_without_mutation(scenario, change):
    s = scenario
    await history(s, **change)
    before = await snapshot(s.db)
    assert (await join(s)).status_code == 409
    assert await snapshot(s.db) == before


@pytest.mark.asyncio
@pytest.mark.parametrize("subject", ["invitee", "self"])
@pytest.mark.parametrize("ambiguity", ["other_member", "duplicate_self", "other_account"])
async def test_ambiguous_references_never_authorize_history(scenario, subject, ambiguity):
    s = scenario
    await history(s, member_id=subject)
    if ambiguity == "other_member":
        await s.db.members.insert_one({"id": subject, "user_id": "other", "family_group_id": "unrelated"})
    elif ambiguity == "duplicate_self":
        await s.db.members.insert_one({"id": subject, "user_id": "invitee", "family_group_id": "unrelated"})
        if subject == "invitee":
            await s.db.members.insert_one({"id": subject, "user_id": "invitee", "family_group_id": "unrelated"})
    elif subject == "self":
        await s.db.users.insert_one({"id": "self", "family_group_id": "unrelated"})
    else:
        # User IDs are intrinsic account identity, so test a member collision.
        await s.db.members.insert_one({"id": subject, "family_group_id": "unrelated"})
    before = await snapshot(s.db)
    assert (await join(s)).status_code == 409
    assert await snapshot(s.db) == before


@pytest.mark.asyncio
@pytest.mark.parametrize("obligation", ["linked_account", "dependent", "dependent_no_login",
                                      "reminders", "checkins", "medication_logs", "other_sos"])
async def test_mixed_history_does_not_mask_real_obligations(scenario, obligation):
    s = scenario
    await history(s)
    if obligation == "linked_account":
        await s.db.users.insert_one({"id": "dependent", "family_group_id": "solo"})
    elif obligation.startswith("dependent"):
        row = {"id": "dependent", "owner_id": "invitee", "family_group_id": "solo"}
        if obligation == "dependent":
            row["user_id"] = "dependent-account-without-user-document"
        await s.db.members.insert_one(row)
    elif obligation == "other_sos":
        await history(s, id="other-sos", member_id="other", resolved=False)
    else:
        await s.db[obligation].insert_one({"id": "care", "owner_id": "invitee",
                                         "member_id": "dependent", "family_group_id": "solo"})
    before = await snapshot(s.db)
    assert (await join(s)).status_code == 409
    assert await snapshot(s.db) == before


@pytest.mark.asyncio
async def test_foreign_family_history_is_not_used_or_moved(scenario):
    s = scenario
    original = await history(s, family_group_id="unrelated")
    assert (await join(s)).status_code == 200
    assert await s.db.alerts.find_one({"id": original["id"]}) == original


@pytest.mark.asyncio
@pytest.mark.parametrize("subject", ["invitee", "self"])
@pytest.mark.parametrize("operation", ["remove", "leave"])
async def test_removal_and_leave_preserve_resolved_self_sos(scenario, subject, operation):
    s = scenario
    original = await history(s, member_id=subject, family_group_id="target")
    await s.db.users.update_one({"id": "invitee"}, {"$set": {
        "family_group_id": "target", "family_group_role": "member",
    }})
    await s.db.members.update_one({"id": "self"}, {"$set": {"family_group_id": "target"}})
    active = await history(s, id="active-sos", family_group_id="target", resolved=False)
    if operation == "remove":
        result = await s.http.post("/api/family-group/remove-member", json={"user_id": "invitee"})
    else:
        result = await s.http.post("/api/family-group/leave", headers={"x-test-actor": "invitee"})
    assert result.status_code == 200, result.text
    assert await s.db.alerts.find_one({"id": original["id"]}) == original
    solo = (await s.db.users.find_one({"id": "invitee"}))["family_group_id"]
    assert solo != "target"
    # Preserve preexisting handling of active SOS in removal, not SOS sending.
    assert (await s.db.alerts.find_one({"id": active["id"]}))["family_group_id"] == solo
    assert (await s.db.members.find_one({"id": "self"}))["family_group_id"] == solo
    assert await s.db.family_groups.find_one({"id": "target"})


async def history_client(s):
    async def actor(request: Request):
        uid = request.headers.get("x-test-actor")
        if not uid:
            raise HTTPException(401)
        return {"id": uid}
    app = FastAPI()
    app.include_router(links.build_router(s.db, actor, None, None, None), prefix="/api")
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://test.invalid")


@pytest.mark.asyncio
@pytest.mark.parametrize("subject", ["invitee", "self"])
async def test_history_read_is_self_only_and_safe_after_transfer(scenario, subject):
    s = scenario
    original = await history(s, member_id=subject)
    await history(s, id="others-history", owner_id="owner", member_id="other", family_group_id="target")
    await history(s, id="unresolved", resolved=False, family_group_id="unrelated")
    assert (await join(s)).status_code == 200
    before = await snapshot(s.db)
    async with await history_client(s) as http:
        mine = await http.get("/api/auth/self/sos-history", headers={"x-test-actor": "invitee"})
        assert mine.status_code == 200
        items = mine.json()["items"]
        assert [r["id"] for r in items] == [original["id"]]
        assert set(items[0]) == {"id", "type", "resolved", "created_at", "resolved_at"}
        for uid in ("owner", "stranger", "prior-caregiver"):
            response = await http.get("/api/auth/self/sos-history",
                                      headers={"x-test-actor": uid},
                                      params={"user_id": "invitee", "family_id": "solo"})
            assert response.status_code in (200, 401)
            assert original["id"] not in str(response.json())
        assert (await http.get("/api/auth/self/sos-history")).status_code == 401
    assert await snapshot(s.db) == before


@pytest.mark.asyncio
async def test_history_read_rejects_deleted_identity_and_ambiguous_subject(scenario):
    s = scenario
    await history(s)
    await s.db.members.insert_one({"id": "invitee", "user_id": "someone-else", "family_group_id": "unrelated"})
    assert (await sh.own_history(s.db, "invitee"))["items"] == []
    await s.db.users.delete_one({"id": "invitee"})
    with pytest.raises(HTTPException) as error:
        await sh.own_history(s.db, "invitee")
    assert error.value.status_code == 401


@pytest.mark.asyncio
async def test_family_code_cannot_bypass_verified_history_transfer(scenario):
    s = scenario
    await history(s)
    await s.db.family_groups.update_one({"id": "target"}, {"$set": {"invite_code": "KINN-TARGET"}})
    before = await snapshot(s.db)
    result = await s.http.post("/api/family-group/join", headers={"x-test-actor": "invitee"},
                               json={"invite_code": "KINN-TARGET"})
    assert result.status_code == 409
    assert await snapshot(s.db) == before


@pytest.mark.asyncio
async def test_solo_leave_keeps_history_family_container(scenario):
    s = scenario
    original = await history(s)
    result = await s.http.post("/api/family-group/leave", headers={"x-test-actor": "invitee"})
    assert result.status_code == 200
    assert await s.db.alerts.find_one({"id": original["id"]}) == original
    assert await s.db.family_groups.find_one({"id": "solo"})


def alert_endpoints(db):
    """Run actual alert endpoints without importing production clients/jobs."""
    path = Path(__file__).resolve().parents[1] / "server.py"
    tree = ast.parse(path.read_text())
    names = {"list_alerts", "acknowledge_alert", "resolve_alert", "clear_all_alerts"}
    selected = [n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name in names]
    assert len(selected) == len(names)
    for node in selected:
        node.decorator_list = []
    async def missed(*args):
        pass
    scope = {"db": db, "sh": sh, "HTTPException": HTTPException,
             "get_current_user": lambda: None, "Depends": lambda dep: None,
             "detect_missed_checkins": missed, "Alert": lambda **row: row}
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(path), "exec"), scope)
    return SimpleNamespace(**{name: scope[name] for name in names})


@pytest.mark.asyncio
async def test_former_and_destination_families_cannot_read_mutate_or_clear_archive(scenario):
    s = scenario
    original = await history(s, family_group_id="target")
    # Owner departed; other members remain in target. This is precisely the
    # case where the old family-scoped list/resolve/clear could expose history.
    endpoints = alert_endpoints(s.db)
    for family in ("target", "unrelated"):
        current = {"id": "owner", "family_group_id": family}
        assert original["id"] not in str(await endpoints.list_alerts(current))
        for method in (endpoints.acknowledge_alert, endpoints.resolve_alert):
            with pytest.raises(HTTPException) as error:
                await method(original["id"], current)
            assert error.value.status_code == 404
        await endpoints.clear_all_alerts(current)
        assert await s.db.alerts.find_one({"id": original["id"]}) == original


@pytest.mark.asyncio
async def test_current_family_alert_scope_preserves_ordinary_and_active_sos(scenario):
    s = scenario
    await history(s, family_group_id="target")
    active = await history(s, id="active", family_group_id="target", resolved=False)
    ordinary = await history(s, id="ordinary", family_group_id="target", type="routine")
    visible_sos = await history(s, id="current-owner", owner_id="owner",
                                member_id="owner", family_group_id="target")
    endpoints = alert_endpoints(s.db)
    rows = await endpoints.list_alerts({"id": "owner", "family_group_id": "target"})
    ids = {r["id"] for r in rows}
    assert "historical-sos" not in ids
    assert {active["id"], ordinary["id"], visible_sos["id"]} <= ids


@pytest.mark.asyncio
async def test_resolution_change_during_transfer_retries_and_blocks(scenario, monkeypatch):
    s = scenario
    original = await history(s)
    entered, release = asyncio.Event(), asyncio.Event()
    real = sh.verified_subjects
    first = True

    async def paused(*args, **kwargs):
        nonlocal first
        result = await real(*args, **kwargs)
        if first:
            first = False
            entered.set()
            await asyncio.wait_for(release.wait(), 10)
        return result
    monkeypatch.setattr(sh, "verified_subjects", paused)
    joining = asyncio.create_task(join(s))
    try:
        await asyncio.wait_for(entered.wait(), 10)
        await s.db.alerts.update_one({"id": original["id"]}, {"$set": {"resolved": False}})
    finally:
        release.set()
    result = await asyncio.wait_for(joining, 20)
    assert result.status_code == 409, result.text
    assert (await s.db.users.find_one({"id": "invitee"}))["family_group_id"] == "solo"
    assert (await s.db.family_invites.find_one({"id": "invitation"}))["status"] == "pending"
    assert (await s.db.alerts.find_one({"id": original["id"]}))["resolved"] is False


@pytest.mark.asyncio
async def test_concurrent_dependent_insert_after_snapshot_must_block(scenario, monkeypatch):
    s = scenario
    await history(s)
    real = links.join_verified
    entered, release = asyncio.Event(), asyncio.Event()

    async def paused(*args, **kwargs):
        entered.set()
        await asyncio.wait_for(release.wait(), 10)
        return await real(*args, **kwargs)
    # The outer transaction has read the user/invitation already: this checks
    # Mongo snapshot behavior, not an in-memory fake's serialization.
    monkeypatch.setattr(links, "join_verified", paused)
    joining = asyncio.create_task(join(s))
    try:
        await asyncio.wait_for(entered.wait(), 10)
        await s.db.members.insert_one({"id": "new-dependent", "family_group_id": "solo",
                                      "owner_id": "invitee"})
    finally:
        release.set()
    result = await asyncio.wait_for(joining, 20)
    assert result.status_code == 409, result.text
