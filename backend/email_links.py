"""Device-bound email authentication. No GET request consumes a credential.

Invitation context is never identity proof. Links authenticate the mailbox on
the requesting installation; a forwarded invitation only triggers mail to its
original recipient. Mongo transactions fail closed on unsupported deployments.
"""
from __future__ import annotations

import hashlib
import hmac
import html
import os
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel, EmailStr, Field
from pymongo import ReturnDocument

import family_group as fg

TOKEN_RE = re.compile(r"^[a-f0-9]{64}$")
TTL = timedelta(minutes=15)


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def utc(value):
    return value.replace(tzinfo=timezone.utc) if value and value.tzinfo is None else value


class LinkRequest(BaseModel):
    email: EmailStr | None = None
    challenge: str = Field(pattern=r"^[a-f0-9]{64}$")
    invite_token: str | None = Field(default=None, max_length=128)
    full_name: str = Field(default="", max_length=80)
    timezone: str = Field(default="UTC", max_length=100)
    create_family: bool = False


class LinkVerify(BaseModel):
    token: str = Field(pattern=r"^[a-f0-9]{64}$")
    verifier: str = Field(pattern=r"^[a-f0-9]{64}$")
    full_name: str = Field(default="", max_length=80)
    create_family: bool = False


class InviteConfirm(BaseModel):
    invite_token: str = Field(max_length=128)
    expected_family_id: str
    previous_family_id: str | None = None
    confirmed: bool = False


class SessionCollection:
    """Run existing consent-safe family helpers inside the same transaction."""
    def __init__(self, collection, session):
        self.collection, self.session = collection, session

    def __getattr__(self, name):
        method = getattr(self.collection, name)
        def call(*args, **kwargs):
            return method(*args, **kwargs, session=self.session)
        return call


class SessionDatabase:
    def __init__(self, db, session):
        self.db, self.session = db, session

    def __getitem__(self, name):
        return SessionCollection(self.db[name], self.session)

    def __getattr__(self, name):
        return self[name]


async def invitation(db, token, *, accepted_user=None):
    # The new flow deliberately does not accept family-wide wall codes.
    token = fg.normalize_invite_code(token)
    inv = await db.family_invites.find_one({"token": token})
    now = datetime.now(timezone.utc)
    accepted = bool(accepted_user) and inv and inv.get("status") == "accepted" and inv.get("accepted_by_user_id") == accepted_user
    if not inv or (not accepted and (
        inv.get("status") != "pending" or not inv.get("expires_at")
        or utc(inv["expires_at"]) <= now
    )):
        raise HTTPException(410, "This invitation has expired or was withdrawn. Ask your family to send a new invitation.")
    group = await db.family_groups.find_one({"id": inv["family_group_id"]})
    inviter = await db.users.find_one({"id": inv.get("invited_by_user_id")})
    if not group or not inviter or group.get("owner_user_id") != inviter["id"] or inviter.get("family_group_id") != group["id"]:
        raise HTTPException(410, "This invitation is no longer available. Ask your family for a new invitation.")
    return inv, group


async def join_verified(db, user, inv, target):
    if user["email"].strip().lower() != inv["invitee_email"].strip().lower():
        raise HTTPException(403, "This invitation is for a different email address. Sign in with the invited email.")
    old_gid = user.get("family_group_id")
    if old_gid and old_gid != target["id"]:
        old = await db.family_groups.find_one({"id": old_gid})
        if old and old.get("owner_user_id") == user["id"]:
            others = await db.users.count_documents({"family_group_id": old_gid, "id": {"$ne": user["id"]}})
            if others:
                raise HTTPException(409, "Transfer ownership of your current family before joining another family.")
        # Unlike the legacy helper, do not swallow failed writes. Every owned
        # collection moves, or the entire family transition rolls back.
        self_rows = await db.members.find(
            {"user_id": user["id"], "family_group_id": old_gid}, {"id": 1},
        ).to_list(100)
        self_ids = [row["id"] for row in self_rows]
        # A caregiver can own records about other people. Account ownership is
        # not permission to transfer those people's health/location data.
        await db.members.update_many(
            {"user_id": user["id"], "family_group_id": old_gid},
            {"$set": {"family_group_id": target["id"]}},
        )
        for collection in fg.DATA_COLLECTIONS:
            if collection == "members":
                continue
            await db[collection].update_many(
                {"owner_id": user["id"], "member_id": {"$in": self_ids}, "family_group_id": old_gid},
                {"$set": {"family_group_id": target["id"]}},
            )
        # Never publish prior-family coordinates into a new consent lifetime.
        await db.members.update_many(
            {"user_id": user["id"], "family_group_id": target["id"]},
            {"$set": {"location_sharing_enabled": False, "latitude": None, "longitude": None,
                      "coordinate_captured_at": None, "location_name": "Location Sharing Off"},
             "$inc": {"location_consent_generation": 1}},
        )
        await db.users.update_one({"id": user["id"]}, {"$set": {"location_sharing_enabled": False}})
    if inv.get("status") != "accepted":
        result = await db.family_invites.update_one(
            {"id": inv["id"], "status": "pending", "expires_at": {"$gt": datetime.now(timezone.utc)}},
            {"$set": {"status": "accepted", "accepted_by_user_id": user["id"],
                      "accepted_at": datetime.now(timezone.utc)}},
        )
        if result.modified_count != 1:
            raise HTTPException(410, "This invitation is no longer available.")
    await db.users.update_one({"id": user["id"]}, {"$set": {
        "family_group_id": target["id"],
        "family_group_role": "owner" if target.get("owner_user_id") == user["id"] else "member",
    }})
    user["family_group_id"] = target["id"]
    user["family_group_role"] = "owner" if target.get("owner_user_id") == user["id"] else "member"
    await fg.ensure_self_member_row(db, user, target["id"], inv, caller="email_link")
    if old_gid and old_gid != target["id"] and not await db.users.count_documents({"family_group_id": old_gid}):
        await db.family_groups.delete_one({"id": old_gid})
    return user


async def rate_limit(db, key: str, limit: int, window: int):
    now = datetime.now(timezone.utc)
    bucket = int(now.timestamp()) // window
    row = await db.email_link_limits.find_one_and_update(
        {"_id": digest(f"{key}:{bucket}")},
        {"$inc": {"count": 1}, "$setOnInsert": {"expires_at": now + timedelta(seconds=window * 2)}},
        upsert=True, return_document=ReturnDocument.AFTER,
    )
    if row["count"] > limit:
        raise HTTPException(429, "Please wait a minute before requesting another email link.")


def build_router(db, get_current_user, send_email, make_token, public_user):
    router = APIRouter()

    @router.post("/auth/email-link/invitation")
    async def preview_invitation(data: dict):
        token = str(data.get("invite_token") or "")[:128]
        inv, group = await invitation(db, token)
        return {"valid": True, "family_name": group.get("name") or "Your family",
                "family_group_id": group["id"], "inviter_name": inv.get("inviter_name")}

    @router.post("/auth/email-link/request")
    async def request_link(data: LinkRequest, request: Request):
        # Use the actual peer, never a caller-controlled forwarding header.
        await rate_limit(db, f"ip:{request.client.host if request.client else 'unknown'}", 20, 60)
        inv = None
        if data.invite_token:
            inv, _ = await invitation(db, data.invite_token)
            email = inv["invitee_email"].strip().lower()
        elif data.email:
            email = str(data.email).strip().lower()
        else:
            raise HTTPException(400, "Enter your email address.")
        await rate_limit(db, f"email:{email}", 1, 60)
        user = await db.users.find_one({"email": email})
        token = secrets.token_hex(32)
        now = datetime.now(timezone.utc)
        await db.email_links.insert_one({
            "_id": digest(token), "challenge": data.challenge, "email": email,
            # Bind pre-existing account identity. Deletion/recreation cannot
            # cause an old email link to sign in to a different user.
            "issued_user_id": user["id"] if user else None,
            "invite_token": fg.normalize_invite_code(data.invite_token) if inv else None,
            "full_name": data.full_name.strip() or (inv.get("invitee_name", "") if inv else ""),
            "timezone": data.timezone, "create_family": data.create_family,
            "created_at": now, "expires_at": now + TTL, "used": False,
        })
        # Fragments are not included in HTTP requests or web-server access logs.
        origin = (os.environ.get("KINNSHIP_LINK_ORIGIN") or "https://kinnectcare-production.up.railway.app").rstrip("/")
        if not origin.startswith("https://"):
            raise HTTPException(503, "Email sign-in is temporarily unavailable.")
        url = f"{origin}/auth/email-link#token={token}&state={data.challenge}"
        body = ("Tap Continue to Kinnship on the phone where you requested this email. "
                "This link expires in 15 minutes and works once. "
                "If you did not request it, do not open it.\n\n" + url)
        sent = await send_email(
            email, "Continue to Kinnship", body,
            html=f'<p>Continue on the phone where you requested this email.</p><p><a href="{html.escape(url)}">Continue to Kinnship</a></p><p>Valid for 15 minutes, once. If you did not request this, ignore this email.</p>',
        )
        if not sent:
            await db.email_links.delete_one({"_id": digest(token)})
            raise HTTPException(503, "We couldn't send your email link. Please try again in a minute.")
        return {"ok": True, "expires_in_seconds": 900, "message": "Check your email and tap Continue to Kinnship on this phone."}

    @router.post("/auth/email-link/verify")
    async def verify_link(data: LinkVerify):
        token_id = digest(data.token)

        async def transaction(session):
            tx = SessionDatabase(db, session)
            rec = await tx.email_links.find_one({"_id": token_id})
            if not rec or rec.get("used") or utc(rec["expires_at"]) <= datetime.now(timezone.utc):
                raise HTTPException(410, "This link has expired or was already used. Request a new email link.")
            if not hmac.compare_digest(rec["challenge"], digest(data.verifier)):
                raise HTTPException(403, "Open this email on the phone where you requested it, or request a new link here.")
            # Serialize creation across *all* concurrent email-link requests.
            await tx.email_link_identities.update_one(
                {"_id": digest(rec["email"])}, {"$inc": {"generation": 1}}, upsert=True,
            )
            user = await tx.users.find_one({"email": rec["email"]})
            if rec.get("issued_user_id") and (not user or user["id"] != rec["issued_user_id"]):
                raise HTTPException(410, "Your account changed. Request a fresh email link.")
            inv = target = None
            if rec.get("invite_token"):
                inv, target = await invitation(tx, rec["invite_token"], accepted_user=user["id"] if user else None)
            name = data.full_name.strip() or rec.get("full_name", "")
            if not user and (not name or (not inv and not (data.create_family or rec.get("create_family")))):
                # Identity proof stays unconsumed while the user explicitly
                # chooses whether to create a new family, never a silent solo.
                return {"needs_profile": True, "invited": bool(inv)}
            membership_settled = False
            if not user:
                from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
                tz = rec.get("timezone") or "UTC"
                try:
                    ZoneInfo(tz)
                except (ValueError, ZoneInfoNotFoundError):
                    tz = "UTC"
                user = {"id": str(uuid.uuid4()), "email": rec["email"], "full_name": name,
                        "location_sharing_enabled": False,
                        "timezone": tz, "push_tokens": [], "created_at": datetime.now(timezone.utc)}
                await tx.users.insert_one(user)
                if inv:
                    await join_verified(tx, user, inv, target)
                    membership_settled = True
                else:
                    group = await fg.create_group_for_user(tx, user)
                    user.update(family_group_id=group["id"], family_group_role="owner")
                    await fg.ensure_self_member_row(tx, user, group["id"], caller="email_link_create")
            elif not user.get("family_group_id"):
                # Recover old incomplete creation; do not guess a family.
                if not inv:
                    raise HTTPException(409, "Your family setup is incomplete. Open your family invitation to continue.")
                await join_verified(tx, user, inv, target)
                membership_settled = True
            # Existing-account transfers always require an authenticated,
            # explicit confirmation showing current and intended family.
            invite_pending = bool(inv and user.get("family_group_id") != target["id"])
            if inv and not invite_pending and not membership_settled:
                await join_verified(tx, user, inv, target)
            consumed = await tx.email_links.update_one(
                {"_id": token_id, "used": False}, {"$set": {"used": True}},
            )
            if consumed.modified_count != 1:
                raise HTTPException(410, "This link was already used. Request a new email link.")
            return {"access_token": make_token(user["id"]), "token_type": "bearer",
                    "user": public_user(user), "invite_pending": invite_pending,
                    "invite_token": rec.get("invite_token")}

        async with await db.client.start_session() as session:
            return await session.with_transaction(transaction)

    @router.post("/auth/email-link/join")
    async def confirm_invite(data: InviteConfirm, current=Depends(get_current_user)):
        if not data.confirmed:
            raise HTTPException(400, "Please confirm joining this family.")
        async def transaction(session):
            tx = SessionDatabase(db, session)
            user = await tx.users.find_one({"id": current["id"]})
            if not user:
                raise HTTPException(401, "Please sign in again.")
            inv, target = await invitation(tx, data.invite_token, accepted_user=user["id"])
            if target["id"] != data.expected_family_id:
                raise HTTPException(409, "The invitation changed. Please open it again.")
            if user.get("family_group_id") not in (data.previous_family_id, target["id"]):
                raise HTTPException(409, "Your current family changed. Please review the invitation again.")
            await join_verified(tx, user, inv, target)
            return {"ok": True, "group": fg.public_group(target)}
        async with await db.client.start_session() as session:
            return await session.with_transaction(transaction)

    return router


def install_public_routes(app):
    @app.get("/.well-known/assetlinks.json", include_in_schema=False)
    async def asset_links():
        # Play app-signing certificate, NOT the upload certificate. Fail closed
        # until the verified public fingerprint has been supplied by the owner.
        fingerprints = [s.strip().upper() for s in os.environ.get("KINNSHIP_ANDROID_APP_SIGNING_SHA256", "").split(",") if s.strip()]
        if not fingerprints or any(not re.fullmatch(r"(?:[0-9A-F]{2}:){31}[0-9A-F]{2}", f) for f in fingerprints):
            return JSONResponse([], status_code=503)
        return JSONResponse([{"relation": ["delegate_permission/common.handle_all_urls"],
                              "target": {"namespace": "android_app", "package_name": "app.kinnship.client",
                                         "sha256_cert_fingerprints": fingerprints}}])

    @app.get("/auth/email-link", response_class=HTMLResponse, include_in_schema=False)
    async def link_landing():
        # No external assets; no auto redemption; email scanners cannot consume.
        return HTMLResponse("""<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Continue to Kinnship</title><style>body{font:20px system-ui;padding:28px;max-width:480px;margin:auto;color:#163d24}a{display:block;padding:18px;background:#1B5E35;color:white;border-radius:12px;text-align:center;margin:24px 0}p{line-height:1.6}</style></head>
<body><h1>Continue to Kinnship</h1><p>Open this link on the phone where you requested your email.</p>
<a id="open">Open Kinnship</a><p>If Kinnship is not installed, install it from Google Play, open your original invitation again, and request a fresh email link. You never need to type a code.</p>
<a href="https://play.google.com/store/apps/details?id=app.kinnship.client">Install Kinnship</a>
<script>const p=new URLSearchParams(location.hash.slice(1));const t=p.get('token')||'';const s=p.get('state')||'';if(/^[a-f0-9]{64}$/.test(t)&&/^[a-f0-9]{64}$/.test(s)){document.getElementById('open').href='kinnship://auth/email-link#token='+encodeURIComponent(t)+'&state='+encodeURIComponent(s);}else{document.getElementById('open').textContent='This link is incomplete. Request a new email link.';}history.replaceState(null,'',location.pathname);</script></body></html>""",
                            headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
                                     "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"})
