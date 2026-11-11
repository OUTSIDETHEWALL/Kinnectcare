"""Offline endpoint tests. Transaction fake tests rollback/ordering contracts;
it is NOT proof of Atlas transaction conflicts or a Google Play installation.
"""
import asyncio
import copy
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastapi import FastAPI
from pymongo.errors import DuplicateKeyError

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import email_links as links
import family_group as fg


def matches(doc, query):
    for key, expected in query.items():
        if key == "$nor":
            if any(matches(doc, clause) for clause in expected):
                return False
            continue
        actual = doc.get(key)
        if isinstance(expected, dict):
            for operator, value in expected.items():
                if operator == "$ne" and actual == value:
                    return False
                if operator == "$gt" and (actual is None or actual <= value):
                    return False
                if operator == "$in" and actual not in value:
                    return False
        elif actual != expected:
            return False
    return True


class Collection:
    def __init__(self):
        self.rows = []
        self.fail = False

    async def find_one(self, query, projection=None, **kwargs):
        return copy.deepcopy(next((r for r in self.rows if matches(r, query)), None))

    async def count_documents(self, query, **kwargs):
        return sum(matches(r, query) for r in self.rows)

    def find(self, query, projection=None, **kwargs):
        async def rows(limit):
            return copy.deepcopy([r for r in self.rows if matches(r, query)][:limit])
        return SimpleNamespace(to_list=rows)

    async def insert_one(self, row, **kwargs):
        if "_id" in row and any(r.get("_id") == row["_id"] for r in self.rows):
            raise DuplicateKeyError("duplicate intrinsic key")
        self.rows.append(copy.deepcopy(row))

    async def update_one(self, query, update, upsert=False, **kwargs):
        if self.fail:
            raise RuntimeError("injected storage failure")
        row = next((r for r in self.rows if matches(r, query)), None)
        inserted = row is None and upsert
        if inserted:
            row = {k: v for k, v in query.items() if not isinstance(v, dict)}
            row.update(update.get("$setOnInsert", {}))
            self.rows.append(row)
        if row is None:
            return SimpleNamespace(matched_count=0, modified_count=0)
        before = copy.deepcopy(row)
        row.update(update.get("$set", {}))
        for key, value in update.get("$inc", {}).items():
            row[key] = row.get(key, 0) + value
        return SimpleNamespace(matched_count=0 if inserted else 1, modified_count=int(row != before))

    async def find_one_and_update(self, query, update, **kwargs):
        await self.update_one(query, update, **kwargs)
        return await self.find_one(query)

    async def update_many(self, query, update, **kwargs):
        for row in list(self.rows):
            if matches(row, query):
                await self.update_one({"id": row.get("id")}, update)

    async def delete_one(self, query, **kwargs):
        self.rows = [r for r in self.rows if not matches(r, query)]


class Transaction:
    def __init__(self, db):
        self.db = db

    async def __aenter__(self):
        await self.db.lock.acquire()
        return self

    async def __aexit__(self, *args):
        self.db.lock.release()

    async def with_transaction(self, callback):
        snapshot = {k: copy.deepcopy(v.rows) for k, v in self.db.collections.items()}
        try:
            return await callback(self)
        except Exception:
            for key, collection in self.db.collections.items():
                collection.rows = snapshot.get(key, [])
            raise


class Database:
    def __init__(self):
        self.collections = {}
        self.lock = asyncio.Lock()
        self.client = SimpleNamespace(start_session=AsyncMock(side_effect=lambda: Transaction(self)))

    def __getitem__(self, name):
        return self.collections.setdefault(name, Collection())

    def __getattr__(self, name):
        return self[name]


def setup():
    db = Database()
    owner = {"id": "owner", "email": "owner@example.com", "full_name": "Owner",
             "family_group_id": "family", "family_group_role": "owner"}
    db.users.rows.append(owner)
    db.family_groups.rows.append({"id": "family", "name": "Intended family", "owner_user_id": "owner", "invite_code": "KINN-ABCDEF"})
    inv = {"id": "invitation", "token": "INV-" + "A" * 64, "status": "pending",
           "invited_by_user_id": "owner", "inviter_name": "Owner", "family_group_id": "family",
           "invitee_email": "invited@example.com", "invitee_name": "Invited",
           "expires_at": datetime.now(timezone.utc) + timedelta(days=7)}
    db.family_invites.rows.append(inv)
    send = AsyncMock(return_value=True)
    signed_in = {"id": "existing", "email": "invited@example.com", "full_name": "Existing",
                 "family_group_id": "solo", "family_group_role": "owner"}
    async def current():
        return signed_in
    app = FastAPI()
    app.include_router(links.build_router(db, current, send, lambda uid: f"session:{uid}", lambda u: {k: v for k, v in u.items() if k != "_id"}), prefix="/api")
    links.install_public_routes(app)
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url="https://test")
    return db, send, inv, signed_in, client


VERIFIER = "1" * 64
CHALLENGE = links.digest(VERIFIER)


async def request(client, send, **kwargs):
    response = await client.post("/api/auth/email-link/request", json={"challenge": CHALLENGE, **kwargs})
    assert response.status_code == 200, response.text
    body = send.call_args.args[2]
    url = body.splitlines()[-1]
    fragment = parse_qs(urlsplit(url).fragment)
    return fragment["token"][0]


async def verify(client, token, **kwargs):
    return await client.post("/api/auth/email-link/verify", json={"token": token, "verifier": VERIFIER, **kwargs})


@pytest.mark.asyncio
async def test_new_invitation_creates_only_intended_family_atomically():
    db, send, inv, _, client = setup()
    async with client:
        token = await request(client, send, invite_token=inv["token"])
        response = await verify(client, token)
    assert response.status_code == 200, response.text
    user = response.json()["user"]
    assert user["family_group_id"] == "family"
    assert user["location_sharing_enabled"] is False
    assert len(db.family_groups.rows) == 1
    assert len(db.members.rows) == 1
    assert db.members.rows[0]["location_sharing_enabled"] is False
    assert db.family_invites.rows[0]["status"] == "accepted"
    assert response.json()["invite_pending"] is False


@pytest.mark.asyncio
async def test_request_sends_only_to_invited_recipient_and_never_creates_account():
    db, send, inv, _, client = setup()
    async with client:
        token = await request(client, send, email="forwarded@example.com", invite_token=inv["token"])
    assert send.call_args.args[0] == "invited@example.com"
    assert len(db.users.rows) == 1
    assert token not in repr(db.email_links.rows)
    assert db.email_links.rows[0]["_id"] == links.digest(token)


@pytest.mark.asyncio
async def test_wrong_installation_cannot_redeem_forwarded_authentication_link():
    db, send, inv, _, client = setup()
    async with client:
        token = await request(client, send, invite_token=inv["token"])
        wrong = await verify(client, token, verifier="2" * 64)
        assert wrong.status_code == 403
        assert len(db.users.rows) == 1
        assert (await verify(client, token)).status_code == 200


@pytest.mark.asyncio
async def test_single_use_even_with_concurrent_redemption():
    db, send, inv, _, client = setup()
    async with client:
        token = await request(client, send, invite_token=inv["token"])
        responses = await asyncio.gather(verify(client, token), verify(client, token))
    assert sorted(r.status_code for r in responses) == [200, 410]
    assert len(db.users.rows) == 2
    assert len(db.members.rows) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("state", ["expired", "revoked"])
async def test_invitation_revalidated_after_email_was_sent(state):
    db, send, inv, _, client = setup()
    async with client:
        token = await request(client, send, invite_token=inv["token"])
        if state == "expired":
            inv["expires_at"] = datetime.now(timezone.utc) - timedelta(seconds=1)
        else:
            inv["status"] = state
        assert (await verify(client, token)).status_code == 410
    assert len(db.users.rows) == 1
    assert db.email_links.rows[0]["used"] is False


@pytest.mark.asyncio
async def test_database_failure_rolls_back_account_invite_and_link():
    db, send, inv, _, client = setup()
    async with client:
        token = await request(client, send, invite_token=inv["token"])
        db.members.fail = True
        assert (await verify(client, token)).status_code == 500
        assert len(db.users.rows) == 1
        assert db.family_invites.rows[0]["status"] == "pending"
        assert db.email_links.rows[0]["used"] is False
        db.members.fail = False
        assert (await verify(client, token)).status_code == 200


@pytest.mark.asyncio
async def test_independent_creation_requires_explicit_intent_and_name():
    db, send, _, _, client = setup()
    async with client:
        token = await request(client, send, email="new@example.com")
        response = await verify(client, token)
        assert response.json()["needs_profile"] is True
        assert len(db.users.rows) == 1
        response = await verify(client, token, full_name="New Person", create_family=True)
        assert response.status_code == 200, response.text
        assert response.json()["user"]["family_group_role"] == "owner"
        assert response.json()["user"]["family_group_id"] != "family"
    assert len(db.family_groups.rows) == 2


@pytest.mark.asyncio
async def test_existing_login_keeps_identity_family_and_subscription():
    db, send, _, user, client = setup()
    user["subscription"] = {"plan": "family-plus", "active": True}
    db.users.rows.append(copy.deepcopy(user))
    async with client:
        token = await request(client, send, email=user["email"])
        response = await verify(client, token)
    assert response.status_code == 200
    assert response.json()["user"]["id"] == user["id"]
    assert response.json()["user"]["family_group_id"] == "solo"
    assert db.users.rows[-1]["subscription"] == user["subscription"]


@pytest.mark.asyncio
async def test_existing_account_requires_explicit_family_confirmation():
    db, send, inv, user, client = setup()
    db.users.rows.append(copy.deepcopy(user))
    db.family_groups.rows.append({"id": "solo", "owner_user_id": user["id"]})
    async with client:
        token = await request(client, send, invite_token=inv["token"])
        result = await verify(client, token)
        assert result.json()["invite_pending"] is True
        assert db.users.rows[-1]["family_group_id"] == "solo"
        assert inv["status"] == "pending"
        result = await client.post("/api/auth/email-link/join", json={
            "invite_token": inv["token"], "expected_family_id": "family",
            "previous_family_id": "solo", "confirmed": True,
        })
        assert result.status_code == 200, result.text
    assert db.users.rows[-1]["family_group_id"] == "family"
    assert db.family_invites.rows[0]["status"] == "accepted"


@pytest.mark.asyncio
@pytest.mark.parametrize("changed", ["deleted", "recreated"])
async def test_old_link_cannot_revive_deleted_identity(changed):
    db, send, _, user, client = setup()
    db.users.rows.append(copy.deepcopy(user))
    async with client:
        token = await request(client, send, email=user["email"])
        db.users.rows.pop()
        if changed == "recreated":
            db.users.rows.append({**user, "id": "replacement"})
        assert (await verify(client, token)).status_code == 410


@pytest.mark.asyncio
async def test_new_invite_can_recreate_deleted_account_without_old_history():
    db, send, inv, _, client = setup()
    # Old user-owned data does not become the new identity by name matching.
    db.members.rows.append({"id": "historic", "user_id": "deleted-id", "owner_id": "deleted-id", "family_group_id": "family"})
    async with client:
        token = await request(client, send, invite_token=inv["token"])
        result = await verify(client, token)
    assert result.status_code == 200
    assert result.json()["user"]["id"] != "deleted-id"
    assert len(db.members.rows) == 2
    assert db.members.rows[0]["user_id"] == "deleted-id"


@pytest.mark.asyncio
async def test_email_failure_is_reported_and_cannot_be_redeemed():
    db, send, _, _, client = setup()
    send.return_value = False
    async with client:
        response = await client.post("/api/auth/email-link/request", json={"email": "new@example.com", "challenge": CHALLENGE})
    assert response.status_code == 503
    assert db.email_links.rows == []


@pytest.mark.asyncio
async def test_request_throttled_without_second_email():
    _, send, _, _, client = setup()
    async with client:
        await request(client, send, email="new@example.com")
        response = await client.post("/api/auth/email-link/request", json={"email": "new@example.com", "challenge": CHALLENGE})
    assert response.status_code == 429
    assert send.call_count == 1


@pytest.mark.asyncio
async def test_expired_link_not_accepted_even_before_ttl_cleanup():
    db, send, _, _, client = setup()
    async with client:
        token = await request(client, send, email="new@example.com")
        db.email_links.rows[0]["expires_at"] = datetime.now(timezone.utc) - timedelta(seconds=1)
        assert (await verify(client, token)).status_code == 410


@pytest.mark.asyncio
async def test_preview_and_scanner_get_never_consume_credentials():
    db, send, inv, _, client = setup()
    async with client:
        await request(client, send, invite_token=inv["token"])
        assert (await client.get("/auth/email-link")).status_code == 200
        result = await client.post("/api/auth/email-link/invitation", json={"invite_token": inv["token"]})
    assert result.status_code == 200
    assert "invitee_email" not in result.json()
    assert db.email_links.rows[0]["used"] is False
    assert len(db.users.rows) == 1


@pytest.mark.asyncio
async def test_signed_in_wrong_recipient_cannot_join():
    db, _, inv, user, client = setup()
    db.users.rows.append({**user, "email": "wrong@example.com"})
    async with client:
        result = await client.post("/api/auth/email-link/join", json={
            "invite_token": inv["token"], "expected_family_id": "family",
            "previous_family_id": "solo", "confirmed": True,
        })
    assert result.status_code == 403
    assert db.users.rows[-1]["family_group_id"] == "solo"
    assert db.family_invites.rows[0]["status"] == "pending"


@pytest.mark.asyncio
async def test_missing_play_signing_fingerprint_fails_closed(monkeypatch):
    monkeypatch.delenv("KINNSHIP_ANDROID_APP_SIGNING_SHA256", raising=False)
    _, _, _, _, client = setup()
    async with client:
        assert (await client.get("/.well-known/assetlinks.json")).status_code == 503


def test_invitation_tokens_have_256_random_bits():
    tokens = {fg.generate_invite_token() for _ in range(100)}
    assert len(tokens) == 100
    assert all(re.fullmatch(r"INV-[A-F0-9]{64}", token) for token in tokens)


def test_old_and_new_creation_share_a_normalized_intrinsic_account_key():
    assert links.account_key(" Invited@Example.com ") == links.account_key("invited@example.com")
    source = open(os.path.join(os.path.dirname(os.path.dirname(__file__)), "server.py")).read()
    assert '"_id": el.account_key(email)' in source


@pytest.mark.asyncio
async def test_non_owner_transfer_preserves_other_peoples_records_and_family():
    db, _, inv, user, client = setup()
    db.users.rows.append(copy.deepcopy(user))
    db.family_groups.rows.append({"id": "solo", "owner_user_id": "another-owner"})
    db.members.rows.extend([
        {"id": "self", "user_id": user["id"], "owner_id": user["id"], "family_group_id": "solo",
         "latitude": 12, "longitude": 13, "location_sharing_enabled": True},
        {"id": "other", "user_id": "other-person", "owner_id": user["id"], "family_group_id": "solo",
         "latitude": 22, "longitude": 23, "location_sharing_enabled": True},
    ])
    db.reminders.rows.extend([
        {"id": "self-med", "member_id": "self", "owner_id": user["id"], "family_group_id": "solo"},
        {"id": "other-med", "member_id": "other", "owner_id": user["id"], "family_group_id": "solo"},
    ])
    async with client:
        result = await client.post("/api/auth/email-link/join", json={
            "invite_token": inv["token"], "expected_family_id": "family",
            "previous_family_id": "solo", "confirmed": True,
        })
    assert result.status_code == 200, result.text
    own, other = db.members.rows
    assert own["family_group_id"] == "family"
    assert own["latitude"] is None and own["longitude"] is None
    assert own["location_sharing_enabled"] is False
    assert other["family_group_id"] == "solo"
    assert other["latitude"] == 22
    assert db.reminders.rows[0]["family_group_id"] == "family"
    assert db.reminders.rows[1]["family_group_id"] == "solo"
    assert any(group["id"] == "solo" for group in db.family_groups.rows)


def stored_rows(db):
    return copy.deepcopy({name: coll.rows for name, coll in db.collections.items() if coll.rows})


@pytest.mark.asyncio
@pytest.mark.parametrize("linked_account", [None, "dependent-without-login-row"])
async def test_owner_transfer_with_dependent_is_rejected_without_any_mutation(linked_account):
    db, _, inv, user, client = setup()
    db.users.rows.append(copy.deepcopy(user))
    db.family_groups.rows.append({"id": "solo", "owner_user_id": user["id"]})
    db.members.rows.extend([
        {"id": "self", "user_id": user["id"], "owner_id": user["id"], "family_group_id": "solo",
         "latitude": 12, "longitude": 13, "location_sharing_enabled": True},
        {"id": "dependent", "owner_id": user["id"], "family_group_id": "solo",
         **({"user_id": linked_account} if linked_account else {})},
    ])
    db.reminders.rows.append({"id": "med", "member_id": "dependent", "owner_id": user["id"], "family_group_id": "solo"})
    before = stored_rows(db)
    async with client:
        result = await client.post("/api/auth/email-link/join", json={
            "invite_token": inv["token"], "expected_family_id": "family",
            "previous_family_id": "solo", "confirmed": True,
        })
    assert result.status_code == 409, result.text
    assert stored_rows(db) == before


@pytest.mark.asyncio
@pytest.mark.parametrize("collection", [name for name in fg.DATA_COLLECTIONS if name != "members"])
@pytest.mark.parametrize("record", [
    {"member_id": "missing-dependent", "owner_id": "existing"},
    {"member_id": "self", "owner_id": "another-owner"},
    {},
])
async def test_owner_transfer_rejects_any_care_record_that_would_remain(collection, record):
    db, _, inv, user, client = setup()
    db.users.rows.append(copy.deepcopy(user))
    db.family_groups.rows.append({"id": "solo", "owner_user_id": user["id"]})
    db.members.rows.append({"id": "self", "user_id": user["id"], "owner_id": user["id"], "family_group_id": "solo"})
    db[collection].rows.append({"id": "care", "family_group_id": "solo", **record})
    before = stored_rows(db)
    async with client:
        result = await client.post("/api/auth/email-link/join", json={
            "invite_token": inv["token"], "expected_family_id": "family",
            "previous_family_id": "solo", "confirmed": True,
        })
    assert result.status_code == 409, result.text
    assert stored_rows(db) == before


@pytest.mark.asyncio
@pytest.mark.parametrize("with_self_records", [False, True])
async def test_empty_or_self_only_owner_transfer_still_succeeds(with_self_records):
    db, _, inv, user, client = setup()
    db.users.rows.append(copy.deepcopy(user))
    db.family_groups.rows.append({"id": "solo", "owner_user_id": user["id"]})
    if with_self_records:
        db.members.rows.append({
            "id": "self", "user_id": user["id"], "owner_id": user["id"],
            "family_group_id": "solo", "latitude": 12, "longitude": 13, "location_sharing_enabled": True,
        })
        for collection in fg.DATA_COLLECTIONS:
            if collection != "members":
                db[collection].rows.append({
                    "id": collection, "member_id": "self", "owner_id": user["id"], "family_group_id": "solo",
                })
    async with client:
        result = await client.post("/api/auth/email-link/join", json={
            "invite_token": inv["token"], "expected_family_id": "family",
            "previous_family_id": "solo", "confirmed": True,
        })
    assert result.status_code == 200, result.text
    assert not any(group["id"] == "solo" for group in db.family_groups.rows)
    assert db.users.rows[-1]["family_group_id"] == "family"
    assert db.family_invites.rows[0]["status"] == "accepted"
    assert db.members.rows[0]["location_sharing_enabled"] is False
    for collection in fg.DATA_COLLECTIONS:
        assert all(row.get("family_group_id") != "solo" for row in db[collection].rows)


@pytest.mark.asyncio
@pytest.mark.parametrize("collection", fg.DATA_COLLECTIONS)
async def test_cleanup_never_deletes_a_family_with_remaining_records(collection):
    db, _, inv, user, client = setup()
    db.users.rows.append(copy.deepcopy(user))
    db.family_groups.rows.append({"id": "solo", "owner_user_id": "missing-account"})
    db[collection].rows.append({"id": "remaining", "family_group_id": "solo"})
    async with client:
        result = await client.post("/api/auth/email-link/join", json={
            "invite_token": inv["token"], "expected_family_id": "family",
            "previous_family_id": "solo", "confirmed": True,
        })
    assert result.status_code == 200, result.text
    assert any(group["id"] == "solo" for group in db.family_groups.rows)
    assert any(row["id"] == "remaining" and row["family_group_id"] == "solo" for row in db[collection].rows)
