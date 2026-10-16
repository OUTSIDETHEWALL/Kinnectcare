"""Real SOS endpoint/HTTP contract, with all storage and delivery kept offline."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from test_location_consent_write_race import run, server


@pytest.fixture
def sos():
    current = {"id": "sender", "family_group_id": "sos-family",
               "full_name": "SOS Sender", "timezone": "UTC"}
    insert = AsyncMock()
    push = AsyncMock(return_value=0)
    sms = AsyncMock(return_value=[])
    members = SimpleNamespace(
        find=MagicMock(return_value=SimpleNamespace(to_list=AsyncMock(return_value=[]))),
        find_one=AsyncMock(return_value=None),
    )
    db = SimpleNamespace(alerts=SimpleNamespace(insert_one=insert), members=members)
    with patch.object(server, "db", db), \
         patch.object(server, "push_to_family_group", push), \
         patch.object(server.sms, "send_sms_to_many", sms):
        yield SimpleNamespace(current=current, insert=insert, push=push, sms=sms)


@pytest.mark.parametrize("payload", [
    {},
    {"latitude": None, "longitude": None},
    {"latitude": 12.3, "longitude": 45.6},
])
def test_real_sos_accepts_optional_location_and_preserves_family_fanout(sos, payload):
    async def scenario():
        result = await server.trigger_sos(server.SOSRequest(**payload), sos.current)
        # Drain this exact endpoint's strongly held task before closing our loop.
        await asyncio.gather(*list(server._BG_TASKS))
        assert result["ok"] is True
        assert result["emergency_number"] == "911"
        alert = sos.insert.await_args.args[0]
        assert alert["type"] == "sos"
        assert alert["family_group_id"] == "sos-family"
        assert alert["owner_id"] == "sender"
        assert alert["latitude"] == payload.get("latitude")
        assert alert["longitude"] == payload.get("longitude")
        assert sos.push.await_count == 2
        for call in sos.push.await_args_list:
            assert call.args[0] == "sos-family"
            assert call.kwargs["exclude_user_id"] == "sender"
        visible = sos.push.await_args_list[1].args[3]
        assert visible["type"] == "sos"
        assert visible["alert_id"] == alert["id"]
        assert visible["latitude"] == payload.get("latitude")
        assert visible["longitude"] == payload.get("longitude")
        expected = payload if payload.get("latitude") is not None else None
        assert result["coordinates"] == expected
        sos.sms.assert_awaited_once()
    run(scenario())


@pytest.mark.parametrize("payload", [{}, {"latitude": 12.3, "longitude": 45.6}])
def test_http_sos_optional_coordinates(sos, payload):
    async def current():
        return sos.current
    previous = dict(server.app.dependency_overrides)
    server.app.dependency_overrides[server.get_current_user] = current
    try:
        response = TestClient(server.app).post("/api/sos", json=payload)
        assert response.status_code == 200
        assert response.json()["coordinates"] == (payload or None)
        sos.insert.assert_awaited_once()
    finally:
        server.app.dependency_overrides.clear()
        server.app.dependency_overrides.update(previous)


def test_http_sos_still_requires_authentication(sos):
    previous = dict(server.app.dependency_overrides)
    server.app.dependency_overrides.clear()
    try:
        response = TestClient(server.app).post("/api/sos", json={})
        assert response.status_code in (401, 403)
        sos.insert.assert_not_awaited()
        sos.push.assert_not_awaited()
    finally:
        server.app.dependency_overrides.update(previous)
