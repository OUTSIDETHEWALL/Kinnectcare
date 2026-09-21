import asyncio
import inspect
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx


BACKEND_DIR = Path(__file__).resolve().parents[1]


class _FakeResponse:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload
        self.text = ""

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            request = httpx.Request("POST", "https://exp.host")
            response = httpx.Response(self.status_code, request=request)
            raise httpx.HTTPStatusError("error", request=request, response=response)


class _FakeClient:
    def __init__(self, response=None, error=None, **_kwargs):
        self.response = response
        self.error = error

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    async def post(self, *_args, **_kwargs):
        if self.error:
            raise self.error
        return self.response


def _run(coro):
    return asyncio.run(coro)


def _import_server():
    import sys
    os.environ.setdefault(
        "JWT_SECRET",
        "test-only-secret-that-is-longer-than-thirty-two-characters",
    )
    os.environ.setdefault("MONGO_URL", "mongodb://127.0.0.1:27017")
    os.environ.setdefault("DB_NAME", "test_database")
    sys.path.insert(0, str(BACKEND_DIR))
    import server
    return server


def test_recovery_send_captures_ticket_without_persisting_token():
    import sys
    sys.path.insert(0, str(BACKEND_DIR))
    from expo_push import send_expo_push_with_tickets

    token = "ExponentPushToken[RECOVERY-TICKET-TEST]"
    response = _FakeResponse(200, {"data": [{"status": "ok", "id": "ticket-123"}]})
    with patch(
        "expo_push.httpx.AsyncClient",
        return_value=_FakeClient(response=response),
    ):
        result = _run(send_expo_push_with_tickets(
            [token],
            "",
            "",
            data={"type": "request_location_refresh", "channelId": "silent_v2"},
            sound="",
            priority="high",
        ))

    assert result["transport_status"] == "response_received"
    assert result["http_status"] == 200
    assert result["dead_tokens"] == []
    assert result["tickets"] == [{
        "token_fingerprint": result["tickets"][0]["token_fingerprint"],
        "status": "ok",
        "ticket_id": "ticket-123",
        "error": None,
    }]
    assert len(result["tickets"][0]["token_fingerprint"]) == 16
    assert token not in repr(result)


def test_legacy_sender_still_returns_only_dead_tokens():
    import sys
    sys.path.insert(0, str(BACKEND_DIR))
    from expo_push import send_expo_push

    response = _FakeResponse(200, {"data": [{
        "status": "error",
        "message": "not registered",
        "details": {"error": "DeviceNotRegistered"},
    }]})
    token = "ExponentPushToken[DEAD-RECOVERY-TEST]"
    with patch(
        "expo_push.httpx.AsyncClient",
        return_value=_FakeClient(response=response),
    ):
        result = _run(send_expo_push([token], "Valid title", "Valid body"))

    assert result == [token]


def test_transport_exception_is_classified_not_raised():
    import sys
    sys.path.insert(0, str(BACKEND_DIR))
    from expo_push import send_expo_push_with_tickets

    with patch(
        "expo_push.httpx.AsyncClient",
        return_value=_FakeClient(error=httpx.ConnectError("offline")),
    ):
        result = _run(send_expo_push_with_tickets(
            ["ExponentPushToken[TRANSPORT-TEST]"],
            "",
            "",
            data={"type": "request_location_refresh"},
            sound="",
        ))

    assert result["transport_status"] == "exception"
    assert result["error_type"] == "ConnectError"
    assert result["tickets"] == []


def test_receipt_query_returns_bounded_safe_fields():
    import sys
    sys.path.insert(0, str(BACKEND_DIR))
    from expo_push import get_expo_push_receipts

    response = _FakeResponse(200, {"data": {
        "ticket-123": {
            "status": "error",
            "message": "FCM rejected this delivery",
            "details": {"error": "DeviceNotRegistered", "extra": "not persisted"},
        },
    }})
    with patch(
        "expo_push.httpx.AsyncClient",
        return_value=_FakeClient(response=response),
    ):
        receipts = _run(get_expo_push_receipts(["ticket-123"]))

    assert receipts == {
        "ticket-123": {
            "status": "error",
            "error": "DeviceNotRegistered",
            "message": "FCM rejected this delivery",
        },
    }


def test_recovery_route_keeps_high_priority_data_only_payload_and_schedules_receipt():
    source = (BACKEND_DIR / "server.py").read_text()
    match = re.search(
        r"@api_router\.post\(\"/members/\{member_id\}/request-location-refresh\"\)"
        r".*?(?=@api_router\.|\Z)",
        source,
        re.DOTALL,
    )
    assert match
    block = match.group(0)
    assert "send_expo_push_with_tickets(" in block
    assert 'title=""' in block
    assert 'body=""' in block
    assert 'priority="high"' in block
    assert '"channelId": "silent_v2"' in block
    assert '"receipt_status": "pending" if ticket_ids else "not_available"' in block
    assert "send_completed_at = datetime.now(timezone.utc)" in block


def test_shared_sender_signature_and_default_are_unchanged():
    import sys
    sys.path.insert(0, str(BACKEND_DIR))
    from expo_push import send_expo_push

    signature = inspect.signature(send_expo_push)
    assert list(signature.parameters) == [
        "tokens", "title", "body", "data", "sound", "priority",
    ]
    assert signature.parameters["priority"].default == "high"


def test_collector_persists_receipt_and_post_acceptance_signal_outcome():
    server = _import_server()
    accepted_at = datetime.now(timezone.utc) - timedelta(minutes=20)
    evidence = {
        "request_id": "request-1",
        "receipt_claim_id": "claim-1",
        "member_id": "member-1",
        "sent_at": accepted_at,
        "receipt_attempts": 0,
        "receipt_check_after": accepted_at + timedelta(minutes=15),
        "tickets": [{"ticket_id": "ticket-1", "status": "ok"}],
    }
    evidence_collection = SimpleNamespace(
        update_one=AsyncMock(return_value=SimpleNamespace(matched_count=1)),
    )
    members_collection = SimpleNamespace(find_one=AsyncMock(return_value={
        "last_seen": accepted_at + timedelta(seconds=5),
        "captured_at": accepted_at - timedelta(seconds=1),
        "battery_updated_at": accepted_at + timedelta(seconds=8),
        "device_presence_at": accepted_at + timedelta(seconds=10),
    }))
    fake_db = SimpleNamespace(
        recovery_push_evidence=evidence_collection,
        members=members_collection,
    )

    with (
        patch.object(server, "db", fake_db),
        patch.object(
            server,
            "get_expo_push_receipts",
            AsyncMock(return_value={
                "ticket-1": {"status": "ok", "error": None, "message": None},
            }),
        ),
    ):
        _run(server._collect_recovery_push_receipts(evidence))

    call = evidence_collection.update_one.await_args
    assert call.args[0] == {
        "request_id": "request-1",
        "receipt_claim_id": "claim-1",
    }
    update = call.args[1]
    saved = update["$set"]
    assert saved["receipt_status"] == "complete"
    assert saved["receipt_attempts"] == 1
    assert saved["receipts"] == {
        "ticket-1": {"status": "ok", "error": None},
    }
    assert saved["signals_after_send"]["location_contact_advanced"] is True
    assert saved["signals_after_send"]["gps_capture_advanced"] is False
    assert saved["signals_after_send"]["battery_advanced"] is True
    assert saved["signals_after_send"]["presence_advanced"] is True
    assert update["$unset"] == {
        "receipt_lease_until": "",
        "receipt_claim_id": "",
    }


def test_partial_receipt_is_requeued_without_sleeping_in_process():
    server = _import_server()
    accepted_at = datetime.now(timezone.utc) - timedelta(minutes=20)
    evidence = {
        "request_id": "request-2",
        "receipt_claim_id": "claim-2",
        "member_id": "member-2",
        "sent_at": accepted_at,
        "receipt_attempts": 0,
        "receipt_check_after": accepted_at + timedelta(minutes=15),
        "tickets": [
            {"ticket_id": "ticket-1", "status": "ok"},
            {"ticket_id": "ticket-2", "status": "ok"},
        ],
    }
    evidence_collection = SimpleNamespace(
        update_one=AsyncMock(return_value=SimpleNamespace(matched_count=1)),
    )
    fake_db = SimpleNamespace(
        recovery_push_evidence=evidence_collection,
        members=SimpleNamespace(find_one=AsyncMock(return_value={})),
    )

    with (
        patch.object(server, "db", fake_db),
        patch.object(
            server,
            "get_expo_push_receipts",
            AsyncMock(return_value={
                "ticket-1": {"status": "ok", "error": None, "message": None},
            }),
        ),
    ):
        _run(server._collect_recovery_push_receipts(evidence))

    saved = evidence_collection.update_one.await_args.args[1]["$set"]
    assert saved["receipt_status"] == "pending"
    assert saved["receipt_attempts"] == 1
    assert saved["receipt_check_after"] > datetime.now(timezone.utc)


def test_recovery_evidence_has_bounded_ttl_and_atomic_worker_claim():
    source = (BACKEND_DIR / "server.py").read_text()
    assert '("recovery_push_evidence", "expires_at", 0,' in source
    assert '"receipt_status": "collecting"' in source
    assert '"receipt_lease_until": now + _RECOVERY_RECEIPT_LEASE' in source
    assert '"receipt_claim_id": claim_id' in source
    assert "return_document=ReturnDocument.AFTER" in source


def test_stale_collector_cannot_overwrite_newer_claim():
    server = _import_server()
    accepted_at = datetime.now(timezone.utc) - timedelta(minutes=20)
    evidence = {
        "request_id": "request-stale",
        "receipt_claim_id": "old-claim",
        "member_id": "member-stale",
        "sent_at": accepted_at,
        "receipt_attempts": 0,
        "tickets": [{"ticket_id": "ticket-stale", "status": "ok"}],
    }
    evidence_collection = SimpleNamespace(
        update_one=AsyncMock(return_value=SimpleNamespace(matched_count=0)),
    )
    fake_db = SimpleNamespace(
        recovery_push_evidence=evidence_collection,
        members=SimpleNamespace(find_one=AsyncMock(return_value={})),
    )
    with (
        patch.object(server, "db", fake_db),
        patch.object(
            server,
            "get_expo_push_receipts",
            AsyncMock(return_value={
                "ticket-stale": {"status": "ok", "error": None, "message": None},
            }),
        ),
    ):
        _run(server._collect_recovery_push_receipts(evidence))

    update_filter = evidence_collection.update_one.await_args.args[0]
    assert update_filter == {
        "request_id": "request-stale",
        "receipt_claim_id": "old-claim",
    }