"""Actual server handlers, synthetic JWTs, owned loopback Mongo and stub billing."""
import ast
import copy
import logging
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Optional

import httpx
import jwt
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

import account_deletion as cleanup
import family_group as fg
import family_write_fence as fw
import sos_history as sh
from test_email_links_mongo_integration import links

DELETE = "/api/auth/account"
KEY = "synthetic-account-deletion-signing-key-not-a-production-secret"
TREE = ast.parse((Path(__file__).resolve().parents[1] / "server.py").read_text())


def source_nodes(*names):
    nodes = [n for n in TREE.body if isinstance(n, (ast.AsyncFunctionDef, ast.ClassDef, ast.FunctionDef))
             and n.name in names]
    assert {n.name for n in nodes} == set(names)
    return ast.Module(body=nodes, type_ignores=[])


def execute(scope, *names):
    exec(compile(source_nodes(*names), "actual-server-account-deletion", "exec"), scope)


def bearer(uid="invitee"):
    return jwt.encode({"sub": uid}, KEY, algorithm="HS256")


@asynccontextmanager
async def account_client(s, *, token=None, billing_failure=False, send_email=None):
    calls = []

    def bill(kind):
        def operation(identifier):
            calls.append((kind, identifier))
            if billing_failure:
                raise RuntimeError("Synthetic billing failure")
        return operation

    scope = {
        "db": s.db, "sh": sh, "fw": fw, "el": links, "fg": fg,
        "Request": Request, "HTTPAuthorizationCredentials": HTTPAuthorizationCredentials,
        "Depends": Depends, "security": HTTPBearer(), "HTTPException": HTTPException,
        "jwt": jwt, "SECRET_KEY": KEY, "ALGORITHM": "HS256",
        "BaseModel": BaseModel, "Optional": Optional,
        "api_router": APIRouter(prefix="/api"),
        "billing": SimpleNamespace(is_configured=lambda: True),
        "stripe": SimpleNamespace(Subscription=SimpleNamespace(delete=bill("subscription")),
                                  Customer=SimpleNamespace(delete=bill("customer"))),
        "logger": logging.getLogger("synthetic-account-tests"),
        "datetime": datetime, "timezone": timezone, "timedelta": timedelta,
        "uuid": uuid,
    }
    execute(scope, "get_authenticated_user", "get_current_user", "DeleteAccountRequest", "delete_account")
    app = FastAPI()
    app.include_router(scope["api_router"])
    app.include_router(fg.build_router(s.db, scope["get_current_user"], send_email=send_email), prefix="/api")
    app.include_router(links.build_router(
        s.db, scope["get_current_user"], lambda *a, **k: None,
        lambda uid: bearer(uid), lambda u: {k: v for k, v in u.items() if k != "_id"},
    ), prefix="/api")
    headers = {"Authorization": "Bearer " + (bearer() if token is None else token)} if token != "" else {}
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="https://synthetic.invalid", headers=headers,
    ) as http:
        yield SimpleNamespace(http=http, billing=calls, scope=scope)


async def delete(http, confirm="DELETE"):
    return await http.request("DELETE", DELETE, json={"confirm": confirm})


async def records(db):
    result = {}
    for name in await db.list_collection_names():
        if name == "family_sos_priority":
            continue  # Existing out-of-transaction, short-lived scheduling metadata.
        rows = await db[name].find({}).sort("_id", 1).to_list(12000)
        if rows:
            result[name] = rows
    return result


async def seed_care(s):
    db = s.db
    now = datetime.now(timezone.utc)
    await db.users.update_one({"id": "invitee"}, {"$set": {
        "push_tokens": ["ExponentPushToken[synthetic-deleted-device]"],
        "subscription": {"stripe_subscription_id": "synthetic-sub", "stripe_customer_id": "synthetic-customer"},
    }})
    await db.members.update_one({"id": "self"}, {"$set": {"name": "Synthetic Patient"}})
    await db.reminders.update_one({"id": "reminders"}, {"$set": {
        "type": "medication", "title": "Synthetic medicine", "active": True, "time": "09:00",
    }})
    await db.med_notifications.insert_one({
        "reminder_id": "reminders", "member_id": "self", "family_group_id": "solo",
        "stage": "due", "slot_time": "09:00", "local_date": "2026-11-19",
    })
    await db.medication_occurrences.insert_one({
        "occurrence_id": "synthetic-occurrence", "reminder_id": "reminders", "member_id": "self",
        "family_group_id": "solo", "acknowledged": True, "family_state": "accepted",
    })
    request = {
        "id": "synthetic-welfare", "family_group_id": "solo", "member_id": "self",
        "target_user_id": "invitee", "requester_id": "invitee", "member_name": "Synthetic Patient",
        "status": "responded", "response_notification_status": "pending", "created_at": now,
    }
    await db.checkin_requests.insert_one(copy.deepcopy(request))
    await db.checkin_deliveries.insert_one({
        "_id": "synthetic-delivery", "member_id": "self", "family_group_id": "solo",
        "user_id": "invitee", "state": "pending", "retry_at": now, "alert_id": "alerts",
    })
    for name in ("location_ingest_log", "location_history"):
        await db[name].insert_one({
            "member_id": "self", "family_group_id": "solo",
            "subject_user_id": "invitee", "latitude": 1.0, "longitude": 2.0,
        })
    await db.recovery_push_evidence.insert_one({
        "request_id": "synthetic-refresh", "member_id": "self", "target_user_id": "invitee",
    })
    await db.family_members.insert_one({"id": "self", "user_id": "invitee"})
    await db.otp_codes.insert_one({"email": "invitee@example.com", "code_hash": "synthetic"})
    await db.email_links.insert_one({
        "_id": "3" * 64, "email": "invitee@example.com", "issued_user_id": "invitee",
        "challenge": links.digest("1" * 64), "expires_at": now + timedelta(minutes=15), "used": False,
    })
    await db.email_link_identities.insert_one({"_id": links.digest("invitee@example.com"), "generation": 1})
    await db.family_groups.update_one({"id": "solo"}, {"$set": {"invite_code": "KINN-OLD-DELETE"}})
    return request


def pause_first_commit(monkeypatch):
    """Pause a real completed transaction callback, before its real commit."""
    import asyncio
    held, release = asyncio.Event(), asyncio.Event()
    original = fw._known_commit
    used = False

    async def controlled(session, callback, **options):
        nonlocal used
        if used:
            return await original(session, callback, **options)
        used = True

        async def hold(active):
            result = await callback(active)
            held.set()
            await release.wait()
            return result
        return await original(session, hold, **options)

    monkeypatch.setattr(fw, "_known_commit", controlled)
    return held, release
