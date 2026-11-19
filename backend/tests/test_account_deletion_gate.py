"""Offline tests of the real route bodies; no server startup or provider access."""
import ast
import logging
from pathlib import Path
from types import SimpleNamespace
from typing import Optional
from unittest.mock import AsyncMock, Mock

import httpx
import pytest
from fastapi import APIRouter, Depends, FastAPI, HTTPException
from pydantic import BaseModel


ROOT = Path(__file__).resolve().parents[2]
FLAG = "ACCOUNT_DELETION_HANDOFF_VERIFIED"
PATH = "/api/auth/account"


def route_app(source, value=None, *, authenticated=True):
    tree = ast.parse((ROOT / source).read_text())
    nodes = [n for n in tree.body
             if isinstance(n, (ast.AsyncFunctionDef, ast.ClassDef))
             and n.name in ("DeleteAccountRequest", "delete_account")]
    assert len(nodes) == 2
    actor = {"id": "synthetic-user", "family_group_id": "synthetic-family"}

    async def authenticate():
        if not authenticated:
            raise HTTPException(401, "Synthetic invalid identity")
        return actor

    cleanup = AsyncMock(return_value=(
        actor, {"users": 1},
    ))
    billing = Mock(return_value=False)
    env = {} if value is None else {FLAG: value}
    scope = {
        "BaseModel": BaseModel, "Optional": Optional, "Depends": Depends,
        "HTTPException": HTTPException, "api_router": APIRouter(prefix="/api"),
        "get_authenticated_user": authenticate, "get_current_user": authenticate,
        "os": SimpleNamespace(environ=env),
        "db": object(),  # Any unexpected database access fails immediately.
        "sh": SimpleNamespace(delete_account_records=cleanup),
        "billing": SimpleNamespace(is_configured=billing),
        "stripe": object(),  # No real billing/provider operation can run.
        "logger": logging.getLogger("synthetic-deletion-gate"),
    }
    exec(compile(ast.Module(body=nodes, type_ignores=[]), source, "exec"), scope)
    app = FastAPI()
    app.include_router(scope["api_router"])
    return app, env, cleanup, billing


@pytest.mark.asyncio
@pytest.mark.parametrize("source", ["backend/server.py", "server.py"])
@pytest.mark.parametrize("value", [None, "", "false", "FALSE", "True", "TRUE", "1", " true ", True])
async def test_closed_gate_prevents_cleanup_and_billing(source, value):
    app, _, cleanup, billing = route_app(source, value)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://synthetic.invalid",
    ) as client:
        response = await client.request(
            "DELETE", PATH + "?" + FLAG + "=true",
            headers={FLAG: "true", "X-Account-Deletion-Enabled": "true"},
            json={"confirm": "DELETE", FLAG: True, "enabled": True},
        )
    assert response.status_code == 503
    assert "No data was deleted" in response.json()["detail"]
    cleanup.assert_not_awaited()
    billing.assert_not_called()


@pytest.mark.asyncio
async def test_only_server_attestation_opens_gate_and_reclosing_is_immediate():
    app, env, cleanup, billing = route_app("backend/server.py", "true")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://synthetic.invalid",
    ) as client:
        response = await client.request("DELETE", PATH, json={"confirm": "DELETE"})
        assert response.status_code == 200
        assert response.json()["deleted"] == {"users": 1}
        cleanup.assert_awaited_once_with(
            app.routes[-1].endpoint.__globals__["db"], "synthetic-user", "synthetic-family",
        )
        assert billing.call_count == 1
        env.pop(FLAG)
        response = await client.request("DELETE", PATH, json={"confirm": "DELETE"})
        assert response.status_code == 503
        assert cleanup.await_count == 1
        assert billing.call_count == 1


@pytest.mark.asyncio
async def test_open_gate_still_requires_confirmation():
    app, _, cleanup, billing = route_app("backend/server.py", "true")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://synthetic.invalid",
    ) as client:
        response = await client.request("DELETE", PATH, json={"confirm": "NO"})
    assert response.status_code == 400
    cleanup.assert_not_awaited()
    billing.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("value", [None, "true"])
async def test_gate_does_not_replace_authentication(value):
    app, _, cleanup, billing = route_app("backend/server.py", value, authenticated=False)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://synthetic.invalid",
    ) as client:
        response = await client.request("DELETE", PATH, json={"confirm": "DELETE"})
    assert response.status_code == 401
    cleanup.assert_not_awaited()
    billing.assert_not_called()
