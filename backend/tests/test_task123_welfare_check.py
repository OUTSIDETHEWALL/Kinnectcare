"""Regression coverage for interactive caregiver welfare checks."""

import asyncio
import copy
import os
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException


for _key, _value in {
    "MONGO_URL": "mongodb://localhost:27017",
    "DB_NAME": "kinnship_test",
    "JWT_SECRET": "test-secret",
}.items():
    os.environ.setdefault(_key, _value)

with patch("motor.motor_asyncio.AsyncIOMotorClient", MagicMock()):
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
    import server  # noqa: E402


FAMILY_ID = "family-123"
CAREGIVER_ID = "caregiver-123"
MEMBER_ID = "member-123"
MEMBER_USER_ID = "member-user-123"


def _run(coro):
    return asyncio.run(coro)


def test_caregiver_welfare_check_persists_request_and_sends_action_category():
    database = MagicMock()
    database.members.find_one = AsyncMock(return_value={
        "id": MEMBER_ID,
        "family_group_id": FAMILY_ID,
        "user_id": MEMBER_USER_ID,
        "name": "Joyce",
    })
    database.checkin_requests.insert_one = AsyncMock()
    database.users.find_one = AsyncMock(return_value={
        "push_tokens": ["ExponentPushToken[test]"],
        "location_sharing_enabled": True,
    })
    current = {
        "id": CAREGIVER_ID,
        "family_group_id": FAMILY_ID,
        "family_group_role": "owner",
        "name": "Charles",
    }

    with patch.object(server, "db", database), patch.object(
        server, "send_expo_push", AsyncMock()
    ) as silent_push, patch.object(
        server, "push_to_user", AsyncMock(return_value=1)
    ) as visible_push:
        result = _run(server.send_checkin_request(MEMBER_ID, current))

    assert result["ok"] is True
    assert result["status"] == "pending"
    assert result["created_at"]
    database.checkin_requests.insert_one.assert_awaited_once()
    silent_push.assert_awaited_once()
    visible_push.assert_awaited_once()
    user_id, title, body, data = visible_push.await_args.args
    assert user_id == MEMBER_USER_ID
    assert title == "Charles is checking on you"
    assert body == "Are you okay?"
    assert data["categoryIdentifier"] == "ARE_YOU_OK"
    assert data["request_id"] == result["request_id"]
    assert data["member_id"] == MEMBER_ID


def test_non_owner_cannot_send_welfare_check():
    database = MagicMock()
    current = {
        "id": MEMBER_USER_ID,
        "family_group_id": FAMILY_ID,
        "family_group_role": "member",
        "name": "Joyce",
    }

    with patch.object(server, "db", database):
        with pytest.raises(HTTPException) as raised:
            _run(server.send_checkin_request(MEMBER_ID, current))

    assert raised.value.status_code == 403
    database.members.find_one.assert_not_called()


def test_welfare_prompt_bypasses_quiet_hours():
    database = MagicMock()
    database.users.find_one = AsyncMock(return_value={
        "push_tokens": ["ExponentPushToken[test]"],
        "quiet_hours": {"enabled": True, "start": "00:00", "end": "23:59"},
        "timezone": "UTC",
    })
    database.users.update_one = AsyncMock()

    with patch.object(server, "db", database), patch.object(
        server, "send_expo_push", AsyncMock(return_value=[])
    ) as send_push:
        attempted = _run(server.push_to_user(
            MEMBER_USER_ID,
            "Charles is checking on you",
            "Are you okay?",
            {"type": "are_you_ok_request"},
        ))

    assert attempted == 1
    send_push.assert_awaited_once()


def test_failed_response_write_releases_processing_claim_for_retry():
    request = {
        "id": "request-failure",
        "family_group_id": FAMILY_ID,
        "requester_id": CAREGIVER_ID,
        "requester_name": "Charles",
        "member_id": MEMBER_ID,
        "member_name": "Joyce",
        "target_user_id": MEMBER_USER_ID,
        "status": "pending",
    }
    database = MagicMock()
    database.checkin_requests.find_one = AsyncMock(return_value=request)
    database.checkin_requests.update_one = AsyncMock(
        side_effect=[
            SimpleNamespace(modified_count=1),
            SimpleNamespace(modified_count=1),
        ]
    )
    database.members.find_one = AsyncMock(return_value={
        "id": MEMBER_ID,
        "family_group_id": FAMILY_ID,
        "user_id": MEMBER_USER_ID,
        "name": "Joyce",
    })
    database.checkins.insert_one = AsyncMock(side_effect=RuntimeError("mongo unavailable"))
    database.checkins.find_one = AsyncMock(return_value=None)
    current = {
        "id": MEMBER_USER_ID,
        "family_group_id": FAMILY_ID,
        "name": "Joyce",
        "timezone": "UTC",
    }

    with patch.object(server, "db", database):
        with pytest.raises(RuntimeError, match="mongo unavailable"):
            _run(server.respond_to_checkin_request(
                "request-failure",
                server.CheckInCreate(member_id=MEMBER_ID),
                current,
            ))

    release = database.checkin_requests.update_one.await_args_list[1]
    assert release.args[1]["$set"] == {"status": "pending"}
    assert release.args[1]["$unset"] == {"processing_started_at": ""}


def test_retry_after_partial_failure_reuses_canonical_checkin_without_duplicate_notifications():
    request = {
        "id": "request-recovery",
        "family_group_id": FAMILY_ID,
        "requester_id": CAREGIVER_ID,
        "requester_name": "Charles",
        "member_id": MEMBER_ID,
        "member_name": "Joyce",
        "target_user_id": MEMBER_USER_ID,
        "status": "pending",
    }
    inserted = {}

    async def insert_once(document):
        if inserted:
            raise RuntimeError("duplicate _id")
        inserted.update(document)

    database = MagicMock()
    database.checkin_requests.find_one = AsyncMock(side_effect=[request, request])
    database.checkin_requests.update_one = AsyncMock(side_effect=[
        SimpleNamespace(modified_count=1),  # first claim
        SimpleNamespace(modified_count=1),  # release after member write failure
        SimpleNamespace(modified_count=1),  # retry claim
        SimpleNamespace(modified_count=1),  # retry finalization
        SimpleNamespace(modified_count=1),  # requester notification claim
        SimpleNamespace(modified_count=1),  # requester notification sent
    ])
    database.members.find_one = AsyncMock(return_value={
        "id": MEMBER_ID,
        "family_group_id": FAMILY_ID,
        "user_id": MEMBER_USER_ID,
        "name": "Joyce",
    })
    database.checkins.insert_one = AsyncMock(side_effect=insert_once)
    database.checkins.find_one = AsyncMock(
        side_effect=lambda *_args, **_kwargs: {
            key: value for key, value in inserted.items() if key != "_id"
        }
    )
    database.members.update_one = AsyncMock(side_effect=[
        RuntimeError("member write unavailable"),
        SimpleNamespace(modified_count=1),
    ])
    database.alerts.update_many = AsyncMock(return_value=SimpleNamespace(modified_count=0))
    current = {
        "id": MEMBER_USER_ID,
        "family_group_id": FAMILY_ID,
        "name": "Joyce",
        "timezone": "UTC",
    }

    with patch.object(server, "db", database), patch.object(
        server, "push_to_user", AsyncMock()
    ) as push_user:
        with pytest.raises(RuntimeError, match="member write unavailable"):
            _run(server.respond_to_checkin_request(
                "request-recovery",
                server.CheckInCreate(member_id=MEMBER_ID),
                current,
            ))
        recovered = _run(server.respond_to_checkin_request(
            "request-recovery",
            server.CheckInCreate(member_id=MEMBER_ID),
            current,
        ))

    assert inserted["_id"] == "welfare-check:request-recovery"
    assert recovered.id == inserted["id"]
    push_user.assert_awaited_once()


def test_repeated_notification_action_returns_original_checkin_without_duplicate_push():
    inserted = {}

    async def remember_insert(document):
        inserted.update(copy.deepcopy(document))

    pending_request = {
        "id": "request-123",
        "family_group_id": FAMILY_ID,
        "requester_id": CAREGIVER_ID,
        "requester_name": "Charles",
        "member_id": MEMBER_ID,
        "member_name": "Joyce",
        "target_user_id": MEMBER_USER_ID,
        "status": "pending",
    }
    database = MagicMock()
    database.checkin_requests.find_one = AsyncMock(side_effect=[
        pending_request,
        {
            **pending_request,
            "status": "responded",
            "checkin_id": "canonical-checkin",
            "response_notification_status": "sent",
        },
    ])
    database.checkin_requests.update_one = AsyncMock(
        return_value=SimpleNamespace(modified_count=1)
    )
    database.members.find_one = AsyncMock(return_value={
        "id": MEMBER_ID,
        "family_group_id": FAMILY_ID,
        "user_id": MEMBER_USER_ID,
        "name": "Joyce",
    })
    database.members.update_one = AsyncMock()
    database.alerts.update_many = AsyncMock()
    database.checkins.insert_one = AsyncMock(side_effect=remember_insert)
    database.checkins.find_one = AsyncMock(side_effect=lambda *_args, **_kwargs: {
        **inserted,
        "id": "canonical-checkin",
    })
    current = {
        "id": MEMBER_USER_ID,
        "family_group_id": FAMILY_ID,
        "name": "Joyce",
        "timezone": "UTC",
    }
    body = server.CheckInCreate(member_id=MEMBER_ID)

    with patch.object(server, "db", database), patch.object(
        server, "push_to_user", AsyncMock(return_value=1)
    ) as requester_push, patch.object(
        server, "push_to_family_group", AsyncMock(return_value=1)
    ) as family_push:
        first = _run(server.respond_to_checkin_request("request-123", body, current))
        inserted["id"] = "canonical-checkin"
        second = _run(server.respond_to_checkin_request("request-123", body, current))

    assert first.source == "request_response"
    assert second.id == "canonical-checkin"
    database.checkins.insert_one.assert_awaited_once()
    assert database.checkin_requests.update_one.await_count == 4
    requester_push.assert_awaited_once()
    family_push.assert_not_awaited()
