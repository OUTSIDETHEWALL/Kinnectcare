"""Focused authorization coverage for family reminder administration."""

import asyncio
import os
import sys
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException
from fastapi import Request


os.environ.setdefault("JWT_SECRET", "test-suite-only-signing-secret-that-is-long-enough")
os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "family_roles_permission_tests")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import server  # noqa: E402


def _matches(document, query):
    return all(document.get(key) == value for key, value in query.items())


class Collection:
    def __init__(self, rows=()):
        self.rows = [dict(row) for row in rows]

    async def find_one(self, query, projection=None):
        for row in self.rows:
            if _matches(row, query):
                return dict(row)
        return None

    async def insert_one(self, row):
        self.rows.append(dict(row))
        return SimpleNamespace(inserted_id=row.get("id"))

    async def update_one(self, query, update):
        for row in self.rows:
            if _matches(row, query):
                row.update(update.get("$set", {}))
                return SimpleNamespace(matched_count=1, modified_count=1)
        return SimpleNamespace(matched_count=0, modified_count=0)

    async def delete_one(self, query):
        for index, row in enumerate(self.rows):
            if _matches(row, query):
                self.rows.pop(index)
                return SimpleNamespace(deleted_count=1)
        return SimpleNamespace(deleted_count=0)

    async def delete_many(self, query):
        before = len(self.rows)
        self.rows = [row for row in self.rows if not _matches(row, query)]
        return SimpleNamespace(deleted_count=before - len(self.rows))

    async def count_documents(self, query):
        return sum(_matches(row, query) for row in self.rows)


class Database:
    def __init__(self):
        self.family_groups = Collection([
            {"id": "family-a", "owner_user_id": "owner"},
            {"id": "family-b", "owner_user_id": "outside-owner"},
        ])
        self.members = Collection([
            {
                "id": "owner-member", "owner_id": "owner", "family_group_id": "family-a",
                "user_id": "owner", "name": "Owner", "age": 70, "phone": "+15550000001",
                "gender": "other", "role": "senior",
            },
            {
                "id": "member-member", "owner_id": "member", "family_group_id": "family-a",
                "user_id": "member", "name": "Member", "age": 65, "phone": "+15550000002",
                "gender": "other", "role": "senior",
            },
            {
                "id": "outside-member", "owner_id": "outside", "family_group_id": "family-b",
                "user_id": "outside", "name": "Outside", "age": 60, "phone": "+15550000003",
                "gender": "other", "role": "senior",
            },
        ])
        self.reminders = Collection([
            {
                "id": "member-reminder", "family_group_id": "family-a",
                "member_id": "member-member", "member_name": "Member",
                "owner_id": "owner", "category": "medication", "title": "Medication",
                "times": [], "time": "", "status": "pending", "taken": False,
            },
            {
                "id": "outside-reminder", "family_group_id": "family-b",
                "member_id": "outside-member", "member_name": "Outside",
                "owner_id": "outside-owner", "category": "routine", "title": "Walk",
                "times": [], "time": "", "status": "pending", "taken": False,
            },
        ])
        self.medication_logs = Collection()
        self.med_notifications = Collection()

    def __getitem__(self, name):
        return getattr(self, name)


@pytest.fixture
def permissions_db(monkeypatch):
    database = Database()
    monkeypatch.setattr(server, "db", database)
    return database


def _user(user_id, role="member", group="family-a"):
    # Deliberately stale roles prove ownership is read from family_groups.
    return {"id": user_id, "family_group_id": group, "family_group_role": role}


def test_reminder_administration_uses_authoritative_owner_and_family_scope(permissions_db):
    async def scenario():
        stale_owner = _user("owner", role="member")
        stale_member = _user("member", role="owner")

        created = await server.create_reminder(
            server.ReminderCreate(
                member_id="member-member", category="medication",
                title="Owner created", dosage=None, times=[],
            ),
            current=stale_owner,
        )
        assert created.member_id == "member-member"

        for operation in (
            lambda: server.create_reminder(
                server.ReminderCreate(
                    member_id="member-member", category="routine",
                    title="Forbidden", dosage=None, times=[],
                ), current=stale_member,
            ),
            lambda: server.update_reminder(
                "member-reminder", server.ReminderUpdate(title="Forbidden"),
                current=stale_member,
            ),
            lambda: server.delete_reminder("member-reminder", current=stale_member),
        ):
            with pytest.raises(HTTPException) as denied:
                await operation()
            assert denied.value.status_code == 403

        # A reminder in another family is never found or modified.
        with pytest.raises(HTTPException) as isolated:
            await server.update_reminder(
                "outside-reminder", server.ReminderUpdate(title="Leaked"),
                current=stale_owner,
            )
        assert isolated.value.status_code == 404
        assert (await permissions_db.reminders.find_one(
            {"id": "outside-reminder"}
        ))["title"] == "Walk"

    asyncio.run(scenario())


def test_only_target_member_can_complete_reminder(permissions_db):
    async def scenario():
        owner = _user("owner", role="owner")
        member = _user("member", role="member")

        # Owners administer reminders but cannot complete another user's dose.
        with pytest.raises(HTTPException) as owner_denied:
            await server.mark_reminder(
                "member-reminder", server.ReminderMark(status="taken"), current=owner,
            )
        assert owner_denied.value.status_code == 403

        result = await server.mark_reminder(
            "member-reminder", server.ReminderMark(status="taken"), current=member,
        )
        assert result == {"ok": True, "status": "taken"}
        reminder = await permissions_db.reminders.find_one({"id": "member-reminder"})
        assert reminder["taken"] is True

        with pytest.raises(HTTPException) as cross_family:
            await server.toggle_reminder("outside-reminder", current=member)
        assert cross_family.value.status_code == 404

    asyncio.run(scenario())


def test_member_mutation_routes_enforce_owner_or_self_over_http(permissions_db, monkeypatch):
    """Exercise the mounted API routes, not just endpoint functions."""
    users = {
        "owner-token": _user("owner", role="member"),
        "member-token": _user("member", role="owner"),
    }

    async def test_current_user(request: Request):
        return users[request.headers["x-test-user"]]

    async def unlimited_members(*_args, **_kwargs):
        return float("inf")

    monkeypatch.setattr(server.billing, "get_member_limit_for_group", unlimited_members)
    server.app.dependency_overrides[server.get_current_user] = test_current_user

    async def scenario():
        transport = httpx.ASGITransport(app=server.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            owner_headers = {"x-test-user": "owner-token"}
            member_headers = {"x-test-user": "member-token"}

            # Owner administration remains allowed, even when its cached role is stale.
            assert (await client.put(
                "/api/members/member-member", headers=owner_headers,
                json={"name": "Owner Updated"},
            )).status_code == 200
            created = await client.post(
                "/api/members", headers=owner_headers,
                json={"name": "New Member", "age": 72, "phone": "+15550000004",
                      "gender": "other", "role": "senior"},
            )
            assert created.status_code == 200

            # A linked member may update its own profile and schedule.
            assert (await client.put(
                "/api/members/member-member", headers=member_headers,
                json={"phone": "+15550000022"},
            )).status_code == 200
            assert (await client.put(
                "/api/members/member-member/checkin-settings", headers=member_headers,
                json={"daily_checkin_time": "08:30"},
            )).status_code == 200
            assert (await client.put(
                "/api/members/member-member/checkin-settings", headers=owner_headers,
                json={"checkin_interval_hours": 4},
            )).status_code == 200

            # Cached owner role does not let that member alter another target.
            assert (await client.put(
                "/api/members/owner-member", headers=member_headers,
                json={"name": "Forbidden"},
            )).status_code == 403
            assert (await client.put(
                "/api/members/owner-member/checkin-settings", headers=member_headers,
                json={"daily_checkin_time": "08:30"},
            )).status_code == 403
            assert (await client.delete(
                "/api/members/owner-member", headers=member_headers,
            )).status_code == 403

            # Cross-family targets are not discoverable or mutable.
            assert (await client.put(
                "/api/members/outside-member", headers=owner_headers,
                json={"name": "Cross-family"},
            )).status_code == 404

            # The owner can also remove a family member it created.
            assert (await client.delete(
                f"/api/members/{created.json()['id']}", headers=owner_headers,
            )).status_code == 200

    try:
        asyncio.run(scenario())
    finally:
        server.app.dependency_overrides.pop(server.get_current_user, None)