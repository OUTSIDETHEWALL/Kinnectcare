"""Regression coverage for account removal followed by reinvitation."""

import asyncio
import os
import sys
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException


sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import family_group as fg  # noqa: E402


OWNER_ID = "owner-user"
MEMBER_ID = "member-user"
ORIGINAL_GROUP_ID = "family-original"
MEMBER_EMAIL = "member@example.com"


def _matches(document: dict, query: dict) -> bool:
    for key, expected in query.items():
        actual = document.get(key)
        if isinstance(expected, dict):
            if "$gt" in expected and not (actual is not None and actual > expected["$gt"]):
                return False
            if "$ne" in expected and actual == expected["$ne"]:
                return False
            continue
        if actual != expected:
            return False
    return True


class FakeCollection:
    def __init__(self, documents=None):
        self.documents = [dict(document) for document in (documents or [])]

    async def find_one(self, query, projection=None):
        for document in self.documents:
            if _matches(document, query):
                if not projection:
                    return dict(document)
                included = {
                    key for key, enabled in projection.items()
                    if enabled and key != "_id"
                }
                if included:
                    return {
                        key: value for key, value in document.items()
                        if key in included
                    }
                return {
                    key: value for key, value in document.items()
                    if projection.get(key, 1)
                }
        return None

    async def count_documents(self, query):
        return sum(_matches(document, query) for document in self.documents)

    async def insert_one(self, document):
        self.documents.append(dict(document))
        return SimpleNamespace(inserted_id=document.get("id"))

    async def update_one(self, query, update):
        for document in self.documents:
            if _matches(document, query):
                before = dict(document)
                document.update(update.get("$set", {}))
                return SimpleNamespace(
                    matched_count=1,
                    modified_count=int(document != before),
                )
        return SimpleNamespace(matched_count=0, modified_count=0)

    async def update_many(self, query, update):
        modified = 0
        for document in self.documents:
            if _matches(document, query):
                before = dict(document)
                document.update(update.get("$set", {}))
                modified += int(document != before)
        return SimpleNamespace(matched_count=modified, modified_count=modified)

    async def delete_one(self, query):
        for index, document in enumerate(self.documents):
            if _matches(document, query):
                self.documents.pop(index)
                return SimpleNamespace(deleted_count=1)
        return SimpleNamespace(deleted_count=0)


class FakeDatabase:
    def __init__(self):
        self.users = FakeCollection([
            {
                "id": OWNER_ID,
                "full_name": "Owner",
                "email": "owner@example.com",
                "family_group_id": ORIGINAL_GROUP_ID,
                "family_group_role": "owner",
            },
            {
                "id": MEMBER_ID,
                "full_name": "Family Member",
                "email": MEMBER_EMAIL,
                "family_group_id": ORIGINAL_GROUP_ID,
                "family_group_role": "member",
            },
        ])
        self.family_groups = FakeCollection([
            {
                "id": ORIGINAL_GROUP_ID,
                "name": "Owner's Family",
                "owner_user_id": OWNER_ID,
                "invite_code": "KINN-ABC234",
                "created_at": datetime.now(timezone.utc),
            }
        ])
        self.family_invites = FakeCollection()
        self.members = FakeCollection()
        self.reminders = FakeCollection()
        self.alerts = FakeCollection()
        self.checkins = FakeCollection()
        self.medication_logs = FakeCollection()

    def __getitem__(self, name):
        return getattr(self, name)


def _endpoint(router, path: str):
    return next(route.endpoint for route in router.routes if route.path == path)


def test_remove_account_then_reinvite_same_email():
    database = FakeDatabase()
    owner = database.users.documents[0]
    router = fg.build_router(database, lambda: owner)
    remove_member = _endpoint(router, "/family-group/remove-member")
    send_invite = _endpoint(router, "/family-group/invite")

    async def scenario():
        with pytest.raises(HTTPException) as duplicate:
            await send_invite(
                fg.FamilyInviteCreate(name="Family Member", email=MEMBER_EMAIL),
                current=owner,
            )
        assert duplicate.value.status_code == 409
        assert duplicate.value.detail["code"] == "already_member"

        result = await remove_member(
            fg.FamilyGroupMemberRemove(user_id=MEMBER_ID),
            current=owner,
        )
        assert result == {"ok": True, "removed_user_id": MEMBER_ID}

        moved_user = await database.users.find_one({"id": MEMBER_ID})
        assert moved_user["family_group_id"] != ORIGINAL_GROUP_ID
        assert moved_user["family_group_role"] == "owner"
        solo_group = await database.family_groups.find_one({
            "id": moved_user["family_group_id"],
            "owner_user_id": MEMBER_ID,
        })
        assert solo_group is not None

        reinvite = await send_invite(
            fg.FamilyInviteCreate(name="Family Member", email=MEMBER_EMAIL),
            current=owner,
        )
        assert reinvite["ok"] is True
        assert reinvite["invite"]["status"] == "pending"
        assert reinvite["invite"]["invitee_email"] == MEMBER_EMAIL

    asyncio.run(scenario())


def test_solo_group_creation_fails_if_user_was_not_moved():
    database = FakeDatabase()
    database.users.documents = [
        document for document in database.users.documents
        if document["id"] != MEMBER_ID
    ]
    original_group_count = len(database.family_groups.documents)

    with pytest.raises(RuntimeError, match="Could not move user"):
        asyncio.run(fg.create_group_for_user(
            database,
            {"id": MEMBER_ID, "full_name": "Family Member"},
        ))

    assert len(database.family_groups.documents) == original_group_count