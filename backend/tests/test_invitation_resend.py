"""Offline resend endpoint checks. No live email, account, or database access."""
import copy
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI

from test_email_links import setup
import family_group as fg


def scenario(caller="owner", delivered=True):
    db, _, inv, _, _ = setup()
    inv.update(invitee_name="Invited", created_at=datetime.now(timezone.utc),
               role="senior", relationship="Parent")
    user = copy.deepcopy(db.users.rows[0])
    if caller != "owner":
        user.update(id=caller, family_group_role="member")
        db.users.rows.append(user)
    async def current():
        return user
    send = AsyncMock(return_value=delivered)
    app = FastAPI()
    app.include_router(fg.build_router(db, current, send_email=send), prefix="/api")
    http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://test.invalid")
    return db, inv, send, http


@pytest.mark.asyncio
async def test_resend_keeps_same_email_link_expiry_and_assigned_role():
    db, inv, send, http = scenario()
    before = copy.deepcopy(inv)
    async with http:
        response = await http.post("/api/family-group/invites/invitation/resend")
    assert response.status_code == 200, response.text
    assert response.json()["delivered"] is True
    assert len(db.family_invites.rows) == 1
    for key, value in before.items():
        assert db.family_invites.rows[0][key] == value
    assert inv["token"] in send.call_args.args[2]
    assert "Download Kinnship" in send.call_args.kwargs["html"]
    assert "Join Owner&#x27;s Family" in send.call_args.kwargs["html"]


@pytest.mark.asyncio
async def test_concurrent_resends_claim_only_one_email_attempt():
    import asyncio
    _, _, send, http = scenario()
    async with http:
        responses = await asyncio.gather(*[
            http.post("/api/family-group/invites/invitation/resend") for _ in range(3)
        ])
    assert sorted(r.status_code for r in responses) == [200, 429, 429]
    assert send.await_count == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("state", ["accepted", "revoked", "expired", "missing", "other_family"])
async def test_resend_cannot_revive_or_disclose_unavailable_invitation(state):
    db, inv, send, http = scenario()
    if state == "expired":
        inv["expires_at"] = datetime.now(timezone.utc) - timedelta(seconds=1)
    elif state == "missing":
        db.family_invites.rows.clear()
    elif state == "other_family":
        inv["family_group_id"] = "another-family"
    else:
        inv["status"] = state
    async with http:
        response = await http.post("/api/family-group/invites/invitation/resend")
    assert response.status_code == 410
    assert "token" not in response.json()
    send.assert_not_called()


@pytest.mark.asyncio
async def test_non_owner_cannot_resend():
    _, _, send, http = scenario(caller="outsider")
    async with http:
        response = await http.post("/api/family-group/invites/invitation/resend")
    assert response.status_code == 403
    send.assert_not_called()


@pytest.mark.asyncio
async def test_email_delivery_failure_is_explicit_and_retry_keeps_original_token():
    db, inv, send, http = scenario(delivered=False)
    token = inv["token"]
    async with http:
        first = await http.post("/api/family-group/invites/invitation/resend")
        assert first.json()["delivered"] is False
        db.family_invites.rows[0]["last_email_attempt_at"] -= timedelta(seconds=61)
        send.return_value = True
        retry = await http.post("/api/family-group/invites/invitation/resend")
    assert retry.json()["delivered"] is True
    assert db.family_invites.rows[0]["token"] == token
    assert db.family_invites.rows[0]["status"] == "pending"
