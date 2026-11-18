"""Refresh authorization; real loopback Mongo and a stubbed push relay."""

import logging
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import httpx
import jwt
import pytest
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorClient

from test_email_links_mongo_integration import local_replica  # noqa: F401
from test_location_consent_write_race import run, server
from test_recovery_push_receipts import TICKET_ONE, _FakeClient, _FakeResponse


MEMBER = "synthetic-private-member"
VIEWER = "synthetic-private-viewer"
TARGET = "synthetic-private-target"
FAMILY = "synthetic-private-family"
TOKEN = "ExponentPushToken[SYNTHETIC-PRIVATE-DEVICE]"
REAL_SEND = server.send_expo_push_with_tickets
PRIVATE = f"{MEMBER} {VIEWER} {TARGET} {FAMILY} {TOKEN} 33.1234567"
PATH = f"/api/members/{MEMBER}/request-location-refresh"
CURRENT = {"id": VIEWER, "family_group_id": FAMILY}


@pytest.fixture
def isolated(monkeypatch):
    monkeypatch.setattr(server, "_REFRESH_PUSH_THROTTLE", {})
    monkeypatch.setattr(server, "_REFRESH_TRACE_LOG", server._deque(maxlen=200))
    sender = AsyncMock(return_value={"transport_status": "response_received", "tickets": []})
    monkeypatch.setattr(server, "send_expo_push_with_tickets", sender)
    return sender


@pytest.mark.parametrize("error", [RuntimeError(PRIVATE), TimeoutError(PRIVATE)])
def test_authority_lookup_error_fails_closed(isolated, monkeypatch, caplog, error):
    async def scenario():
        fetch = AsyncMock(side_effect=error)
        members = MagicMock()
        members.with_options.return_value.aggregate.return_value = SimpleNamespace(to_list=fetch)
        monkeypatch.setattr(server, "db", SimpleNamespace(members=members))
        with pytest.raises(HTTPException) as caught:
            await server.request_location_refresh(MEMBER, CURRENT)
        assert caught.value.status_code == 503
        assert "permissions" in caught.value.detail
        isolated.assert_not_awaited()
        assert not server._REFRESH_TRACE_LOG
        assert not server._REFRESH_PUSH_THROTTLE
        assert "authorization_unavailable" in caplog.text
        for value in PRIVATE.split():
            assert value not in caplog.text
    run(scenario())


def test_authentication_lookup_error_fails_closed(isolated, monkeypatch, caplog):
    async def scenario():
        find_user = AsyncMock(side_effect=RuntimeError(PRIVATE))
        monkeypatch.setattr(server, "db", SimpleNamespace(users=SimpleNamespace(find_one=find_user)))
        bearer = jwt.encode({"sub": VIEWER}, server.SECRET_KEY, algorithm=server.ALGORITHM)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=server.app), base_url="http://test",
        ) as api:
            result = await api.post(PATH, headers={"Authorization": f"Bearer {bearer}"})
        assert result.status_code == 503
        find_user.assert_awaited_once()
        isolated.assert_not_awaited()
        assert "authentication_unavailable" in caplog.text
        assert all(value not in caplog.text for value in PRIVATE.split())
    run(scenario())


@pytest.mark.skipif(
    os.environ.get("KINNSHIP_RUN_LOCAL_MONGO_TESTS") != "1",
    reason="Opt in to disposable loopback MongoDB",
)
@pytest.mark.parametrize(("change", "expected"), [
    ("authorized", 200),
    ("self", 200),
    ("profile_off", "target_sharing_off"),
    ("account_off", "target_sharing_off"),
    ("missing_profile_permission", "target_sharing_off"),
    ("missing_account_permission", "target_sharing_off"),
    ("non_boolean_permission", "target_sharing_off"),
    ("target_moved", 404),
    ("stale_caller", 404),
    ("foreign_caller", 404),
    ("foreign_member", 404),
    ("missing_member", 404),
    ("missing_account", 404),
    ("missing_caller", 404),
    ("no_family", 404),
    ("duplicate_member", 404),
    ("duplicate_account", 404),
    ("malformed_link", 404),
    ("no_link", "no_user_link"),
    ("missing_bearer", 403),
    ("invalid_bearer", 401),
])
def test_refresh_authority_against_real_mongo(local_replica, isolated, monkeypatch, caplog, change, expected):
    async def scenario():
        assert local_replica.startswith("mongodb://127.0.0.1:")
        client = AsyncIOMotorClient(local_replica, serverSelectionTimeoutMS=5000)
        db = client["refresh_authorization_tests"]
        assert Path(server.__file__).resolve() == Path(__file__).resolve().parents[1] / "server.py"
        monkeypatch.setattr(server, "db", db)
        try:
            await db.family_groups.insert_many([{"id": FAMILY}, {"id": "other"}])
            target = {"id": TARGET, "family_group_id": FAMILY,
                      "location_sharing_enabled": True, "push_tokens": [TOKEN]}
            member = {"id": MEMBER, "family_group_id": FAMILY, "user_id": TARGET,
                      "location_sharing_enabled": True, "latitude": 33.1234567}
            await db.users.insert_many([CURRENT.copy(), target.copy()])
            await db.members.insert_one(member.copy())
            if change == "profile_off":
                await db.members.update_one({"id": MEMBER}, {"$set": {"location_sharing_enabled": False}})
            elif change == "account_off":
                await db.users.update_one({"id": TARGET}, {"$set": {"location_sharing_enabled": False}})
            elif change == "missing_profile_permission":
                await db.members.update_one({"id": MEMBER}, {"$unset": {"location_sharing_enabled": ""}})
            elif change == "missing_account_permission":
                await db.users.update_one({"id": TARGET}, {"$unset": {"location_sharing_enabled": ""}})
            elif change == "non_boolean_permission":
                await db.users.update_one({"id": TARGET}, {"$set": {"location_sharing_enabled": 1}})
            elif change == "target_moved":
                await db.users.update_one({"id": TARGET}, {"$set": {"family_group_id": "other"}})
            elif change in ("stale_caller", "foreign_caller"):
                await db.users.update_one({"id": VIEWER}, {"$set": {"family_group_id": "other"}})
            elif change == "foreign_member":
                await db.members.update_one({"id": MEMBER}, {"$set": {"family_group_id": "other"}})
            elif change == "missing_member":
                await db.members.delete_one({"id": MEMBER})
            elif change in ("missing_account", "missing_caller"):
                await db.users.delete_one({"id": TARGET if change == "missing_account" else VIEWER})
            elif change == "no_family":
                await db.family_groups.delete_one({"id": FAMILY})
            elif change == "duplicate_member":
                await db.members.insert_one({**member, "family_group_id": "other"})
            elif change == "duplicate_account":
                await db.users.insert_one({**target, "family_group_id": "other"})
            elif change == "malformed_link":
                await db.members.update_one({"id": MEMBER}, {"$set": {"user_id": [TARGET]}})
            elif change == "no_link":
                await db.members.update_one({"id": MEMBER}, {"$unset": {"user_id": ""}})

            if change in ("stale_caller", "missing_caller", "no_family"):
                # Simulate a change after the HTTP authentication dependency
                # already returned the old valid family context.
                with pytest.raises(HTTPException) as caught:
                    await server.request_location_refresh(MEMBER, CURRENT)
                assert caught.value.status_code == expected
            else:
                subject = TARGET if change == "self" else VIEWER
                bearer = jwt.encode({"sub": subject}, server.SECRET_KEY, algorithm=server.ALGORITHM)
                headers = {"Authorization": f"Bearer {bearer}"}
                if change == "missing_bearer":
                    headers = {}
                elif change == "invalid_bearer":
                    headers = {"Authorization": "Bearer invalid"}
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=server.app), base_url="http://test",
                ) as api:
                    response = await api.post(PATH, headers=headers)
                    if isinstance(expected, str):
                        assert response.status_code == 200
                        assert response.json()["skipped"] == expected
                    else:
                        assert response.status_code == expected
                    if expected == 200:
                        assert response.json()["sent_to"] == 1
                        assert (await api.post(PATH, headers=headers)).json()["skipped"] == "throttled"
            if expected == 200:
                isolated.assert_awaited_once()
                sent = isolated.await_args.kwargs
                assert sent["tokens"] == [TOKEN]
                assert sent["priority"] == "high"
                assert sent["title"] == sent["body"] == ""
                assert sent["data"]["member_id"] == MEMBER
            else:
                isolated.assert_not_awaited()
            # Check application logs; the test HTTP client logs URLs separately.
            app_messages = " ".join(record.getMessage() for record in caplog.records
                                    if record.name == server.logger.name)
            assert all(value not in app_messages for value in PRIVATE.split())
        finally:
            await client.drop_database(db.name)
            client.close()
    with caplog.at_level(logging.INFO):
        run(scenario())


@pytest.mark.parametrize("failure", [
    httpx.Response(400, text=PRIVATE),
    _FakeResponse(200, {"data": [{"status": "error", "message": PRIVATE,
                                  "details": {"error": PRIVATE}}]}),
    _FakeResponse(200, {"data": [{"status": "error", "details": {"error": "DeviceNotRegistered"}}]}),
    RuntimeError(PRIVATE),
])
def test_refresh_transport_logs_do_not_echo_private_fields(monkeypatch, caplog, failure):
    import expo_push
    fake = _FakeClient(error=failure) if isinstance(failure, Exception) else _FakeClient(response=failure)
    monkeypatch.setattr(expo_push.httpx, "AsyncClient", lambda **_: fake)
    with caplog.at_level(logging.INFO):
        run(expo_push.send_expo_push_with_tickets(
            [TOKEN], "", "", data={"type": "request_location_refresh", "member_id": MEMBER},
        ))
    assert "Expo location refresh" in caplog.text
    for value in PRIVATE.split():
        assert value not in caplog.text


def test_refresh_evidence_admits_only_safe_relay_fields(isolated, monkeypatch):
    import expo_push

    async def scenario():
        members = MagicMock()
        members.with_options.return_value.aggregate.return_value = SimpleNamespace(
            to_list=AsyncMock(return_value=[{
                "id": MEMBER, "user_id": TARGET, "family_group_id": FAMILY,
                "location_sharing_enabled": True, "families": [{"id": FAMILY}],
                "callers": [CURRENT],
                "targets": [{"id": TARGET, "family_group_id": FAMILY,
                             "location_sharing_enabled": True, "push_tokens": [TOKEN] * 3}],
            }]),
        )
        evidence = SimpleNamespace(update_one=AsyncMock())
        monkeypatch.setattr(server, "db", SimpleNamespace(members=members, recovery_push_evidence=evidence))
        monkeypatch.setattr(server, "send_expo_push_with_tickets", REAL_SEND)
        response = _FakeResponse(200, {"data": [
            {"status": "ok", "id": TICKET_ONE},
            {"status": "ok", "id": PRIVATE},
            {"status": PRIVATE, "id": PRIVATE, "details": {"error": PRIVATE}},
        ]})
        monkeypatch.setattr(expo_push.httpx, "AsyncClient", lambda **_: _FakeClient(response=response))
        await server.request_location_refresh(MEMBER, CURRENT)
        saved = evidence.update_one.await_args.args[1]["$set"]
        assert saved["receipt_status"] == "pending"
        assert [(t["status"], t["ticket_id"], t["error"]) for t in saved["tickets"]] == [
            ("ok", TICKET_ONE, None), ("ok", None, None), ("unknown", None, "unknown"),
        ]
    run(scenario())
