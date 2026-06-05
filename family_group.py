"""Kinnship Family Group module.

A Family Group lets multiple Kinnship user accounts share the same set of
members, reminders, alerts, and check-ins. Every user belongs to exactly one
family group at a time. The user who created the group is its owner; only the
owner can regenerate the invite code, rename the group, or remove other members
from the group.

Schema (db.family_groups):
    {
        id: str (uuid),
        name: str,
        owner_user_id: str,
        invite_code: str (e.g. "KINN-A3B7Q9", unique),
        created_at: datetime,
    }

User document gets two fields:
    family_group_id: str
    family_group_role: "owner" | "member"

All data collections (members, reminders, alerts, checkins, medication_logs)
get a `family_group_id` field for fast group-scoped queries.

Schema (db.family_invites) — per-recipient invites sent by email.  Distinct
from `family_groups.invite_code` (which is the group's shareable wall code).
A per-invite token is single-use, expires after 7 days, and can be revoked
without affecting other pending invites.

    {
        id: str (uuid),
        token: str (e.g. "INV-X3K9P2", unique),
        family_group_id: str,
        invited_by_user_id: str,
        inviter_name: str,         # cached for display in the email
        invitee_name: str,
        invitee_email: str,        # lower-cased
        status: "pending"|"accepted"|"expired"|"revoked",
        created_at: datetime,
        expires_at: datetime,      # created_at + 7 days
        accepted_by_user_id: Optional[str],
        accepted_at: Optional[datetime],
    }
"""
from __future__ import annotations

import logging
import os
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable, List, Optional, Tuple

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel, EmailStr

logger = logging.getLogger(__name__)

INVITE_CODE_PREFIX = "KINN"
PER_INVITE_PREFIX = "INV"
# Avoid visually ambiguous chars (0/O, 1/I/L)
INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
INVITE_LEN = 6
INVITE_TTL_DAYS = 7

DATA_COLLECTIONS = (
    "members",
    "reminders",
    "alerts",
    "checkins",
    "medication_logs",
)


# ---------- Models ----------
class FamilyGroupRename(BaseModel):
    name: str


class FamilyGroupJoin(BaseModel):
    invite_code: str


class FamilyGroupMemberRemove(BaseModel):
    user_id: str


class FamilyInviteCreate(BaseModel):
    name: str
    email: EmailStr


# ---------- Helpers ----------
def generate_invite_code() -> str:
    code = "".join(secrets.choice(INVITE_ALPHABET) for _ in range(INVITE_LEN))
    return f"{INVITE_CODE_PREFIX}-{code}"


def normalize_invite_code(code: str) -> str:
    if not code:
        return ""
    return code.strip().upper().replace(" ", "")


async def _generate_unique_invite_code(db) -> str:
    for _ in range(8):
        c = generate_invite_code()
        if not await db.family_groups.find_one({"invite_code": c}):
            return c
    # Extreme fallback
    return f"{INVITE_CODE_PREFIX}-{uuid.uuid4().hex[:8].upper()}"


def generate_invite_token() -> str:
    code = "".join(secrets.choice(INVITE_ALPHABET) for _ in range(INVITE_LEN))
    return f"{PER_INVITE_PREFIX}-{code}"


async def _generate_unique_invite_token(db) -> str:
    for _ in range(8):
        c = generate_invite_token()
        if not await db.family_invites.find_one({"token": c}):
            return c
    return f"{PER_INVITE_PREFIX}-{uuid.uuid4().hex[:8].upper()}"


async def resolve_invite_code(
    db, code: str
) -> Tuple[Optional[dict], Optional[dict]]:
    """Resolve any invite code (family-wide OR per-recipient token).

    Returns (group, invite) where exactly one path is taken:
      • per-invite token (`INV-XXXXXX`) → returns (group, invite_doc)
      • family-wide code (`KINN-XXXXXX`) → returns (group, None)
      • unknown / expired / revoked / accepted → returns (None, None)

    Expired pending invites are auto-transitioned to `expired` on read so
    they never come back from the dead even if expires_at is later bumped.
    """
    code = normalize_invite_code(code)
    if not code:
        return None, None

    if code.startswith(PER_INVITE_PREFIX + "-"):
        invite = await db.family_invites.find_one({"token": code}, {"_id": 0})
        if not invite or invite.get("status") != "pending":
            return None, None
        # Expiry check — Motor returns datetimes from MongoDB as TZ-naive
        # (BSON has no timezone), so coerce to UTC-aware before comparing.
        exp = invite.get("expires_at")
        if isinstance(exp, datetime):
            if exp.tzinfo is None:
                exp = exp.replace(tzinfo=timezone.utc)
            if datetime.now(timezone.utc) > exp:
                try:
                    await db.family_invites.update_one(
                        {"id": invite["id"]}, {"$set": {"status": "expired"}}
                    )
                except Exception:
                    pass
                return None, None
        group = await db.family_groups.find_one(
            {"id": invite["family_group_id"]}, {"_id": 0}
        )
        if not group:
            return None, None
        return group, invite

    # Fall back to family-wide code lookup.
    group = await get_group_by_code(db, code)
    return group, None


async def accept_invite(db, invite_id: str, accepted_by_user_id: str) -> None:
    """Mark a pending invite as accepted. Idempotent."""
    await db.family_invites.update_one(
        {"id": invite_id, "status": "pending"},
        {"$set": {
            "status": "accepted",
            "accepted_by_user_id": accepted_by_user_id,
            "accepted_at": datetime.now(timezone.utc),
        }},
    )


def _invite_email_body(
    *, inviter_name: str, group_name: str, token: str, invitee_name: str,
    expires_at: datetime,
) -> Tuple[str, str, str]:
    """Build (subject, plain-text body, HTML body) for the invite email.

    Modern mail clients (Gmail, Apple Mail, Outlook) render the HTML
    version; plain-text clients and screen readers fall back to text.
    Both versions carry the same content so accessibility doesn't
    suffer.

    The possessive form always appends `'s` (e.g. "Charles" → "Charles's",
    "Bob" → "Bob's") — modern Chicago Manual of Style.
    """
    inviter_possessive = f"{inviter_name}'s"
    subject = f"You're invited to join {inviter_possessive} Family on Kinnship"
    exp_str = expires_at.strftime("%B %d, %Y")

    # ---- Plain-text version (fallback) ----
    text_body = (
        f"Hi {invitee_name},\n\n"
        f"{inviter_name} has invited you to join {inviter_possessive} Family "
        f"on Kinnship — the family safety and senior wellness app that keeps "
        f"loved ones connected and protected.\n\n"
        f"WHAT KINNSHIP DOES\n"
        f"  • One-tap SOS alerts that notify your whole family\n"
        f"  • Daily check-ins so loved ones know you're okay\n"
        f"  • Automatic fall detection on your phone\n"
        f"  • Medication reminders with family follow-up\n"
        f"  • Location sharing during emergencies only\n\n"
        f"YOUR PERSONAL INVITE CODE\n\n"
        f"    {token}\n\n"
        f"HOW TO JOIN (about 3 minutes)\n"
        f"  1. Download Kinnship\n"
        f"     • iPhone: search 'Kinnship' on the App Store\n"
        f"     • Android: search 'Kinnship' on Google Play\n"
        f"  2. Open the app and tap Sign Up\n"
        f"  3. Enter your email and verify with the 6-digit code we send\n"
        f"  4. On the \"Family invite code\" field, enter: {token}\n"
        f"  5. You're in — you'll join {inviter_possessive} family automatically.\n\n"
        f"This invite expires on {exp_str}.  If you didn't expect this email, "
        f"you can safely ignore it — no account will be created.\n\n"
        f"Welcome to the Kinnship family,\n"
        f"— The Kinnship team"
    )

    # ---- HTML version (primary, used by modern clients) ----
    # Table-based layout for max email-client compatibility (Outlook
    # especially).  Inline styles only — no external stylesheets.
    html_body = f"""<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>{subject}</title></head>
<body style="margin:0;padding:0;background-color:#f4f6f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;line-height:1.5;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#f4f6f4;padding:32px 12px;">
  <tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background-color:#ffffff;border-radius:14px;box-shadow:0 2px 8px rgba(27,94,53,0.08);overflow:hidden;">

      <!-- Header band -->
      <tr><td style="background-color:#1B5E35;padding:32px 32px 26px 32px;text-align:center;">
        <div style="color:#ffffff;font-size:28px;font-weight:700;letter-spacing:-0.5px;line-height:1;">Kinnship</div>
        <div style="color:#a5d6a7;font-size:13px;margin-top:6px;letter-spacing:0.8px;text-transform:uppercase;">Family safety · Senior wellness</div>
      </td></tr>

      <!-- Greeting + intro -->
      <tr><td style="padding:32px 32px 8px 32px;">
        <p style="margin:0 0 18px 0;font-size:17px;color:#1a1a1a;">Hi {invitee_name},</p>
        <p style="margin:0 0 24px 0;font-size:16px;color:#333;">
          <strong>{inviter_name}</strong> has invited you to join
          <strong>{inviter_possessive} Family</strong> on Kinnship — the family
          safety and senior wellness app that keeps loved ones connected and protected.
        </p>
      </td></tr>

      <!-- Invite code box (most visually prominent element) -->
      <tr><td style="padding:0 32px 24px 32px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
          <tr><td style="background-color:#f1f8e9;border:2px solid #1B5E35;border-radius:12px;padding:24px 16px;text-align:center;">
            <div style="font-size:11px;color:#558b2f;font-weight:700;letter-spacing:1.5px;margin-bottom:10px;text-transform:uppercase;">Your personal invite code</div>
            <div style="font-family:'SFMono-Regular',Consolas,Menlo,'Courier New',monospace;font-size:30px;font-weight:700;color:#1B5E35;letter-spacing:4px;">{token}</div>
            <div style="font-size:11px;color:#777;margin-top:10px;">Single-use · Expires {exp_str}</div>
          </td></tr>
        </table>
      </td></tr>

      <!-- What Kinnship does -->
      <tr><td style="padding:0 32px 8px 32px;">
        <h3 style="margin:0 0 14px 0;font-size:15px;color:#1B5E35;font-weight:700;letter-spacing:0.3px;">WHAT YOU'LL GET</h3>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:15px;color:#333;line-height:1.7;">
          <tr><td style="padding:3px 0;"><strong>🆘 One-tap SOS</strong> — alerts your whole family in seconds</td></tr>
          <tr><td style="padding:3px 0;"><strong>✅ Daily check-ins</strong> — peace of mind for everyone</td></tr>
          <tr><td style="padding:3px 0;"><strong>🏥 Fall detection</strong> — automatic alerts if you slip</td></tr>
          <tr><td style="padding:3px 0;"><strong>💊 Medication reminders</strong> — never miss a dose</td></tr>
          <tr><td style="padding:3px 0;"><strong>📍 Location sharing</strong> — only during emergencies</td></tr>
        </table>
      </td></tr>

      <!-- How to join -->
      <tr><td style="padding:24px 32px 8px 32px;">
        <h3 style="margin:0 0 14px 0;font-size:15px;color:#1B5E35;font-weight:700;letter-spacing:0.3px;">HOW TO JOIN (3 MINUTES)</h3>
        <ol style="margin:0;padding-left:22px;font-size:15px;color:#333;line-height:1.8;">
          <li>Download <strong>Kinnship</strong> from the App Store (iPhone) or Google Play (Android).</li>
          <li>Open the app and tap <strong>Sign Up</strong>.</li>
          <li>Enter your email and verify with the 6-digit code we send.</li>
          <li>On the <strong>Family invite code</strong> field, enter:
            <span style="display:inline-block;background-color:#f1f8e9;color:#1B5E35;font-family:'SFMono-Regular',Consolas,Menlo,monospace;font-weight:700;padding:2px 8px;border-radius:5px;letter-spacing:1px;">{token}</span></li>
          <li>You're in! You'll join {inviter_possessive} family automatically.</li>
        </ol>
      </td></tr>

      <!-- Expiry/ignore note -->
      <tr><td style="padding:24px 32px 28px 32px;">
        <p style="margin:0;font-size:13px;color:#666;border-top:1px solid #e8eae8;padding-top:18px;line-height:1.6;">
          This invite expires on <strong>{exp_str}</strong>. If you didn't expect this email
          you can safely ignore it — no account will be created.
        </p>
      </td></tr>

      <!-- Footer -->
      <tr><td style="background-color:#fafbfa;padding:20px 32px;text-align:center;border-top:1px solid #e8eae8;">
        <p style="margin:0;font-size:12px;color:#999;">Welcome to the Kinnship family,</p>
        <p style="margin:4px 0 0 0;font-size:12px;color:#999;">— The Kinnship team</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>"""

    return subject, text_body, html_body


def _default_group_name(user: dict) -> str:
    name = (user.get("full_name") or "Family").strip()
    first = name.split()[0] if name else "Family"
    return f"{first}'s Family"


async def create_group_for_user(db, user: dict) -> dict:
    """Create a brand-new family group with this user as owner."""
    code = await _generate_unique_invite_code(db)
    group = {
        "id": str(uuid.uuid4()),
        "name": _default_group_name(user),
        "owner_user_id": user["id"],
        "invite_code": code,
        "created_at": datetime.now(timezone.utc),
    }
    await db.family_groups.insert_one(group)
    # `insert_one` mutates `group` to add a Mongo `_id` (ObjectId).  Strip
    # it before returning so callers that pass the dict straight into a
    # JSON response don't hit ObjectId-serialisation crashes.
    group.pop("_id", None)
    await db.users.update_one(
        {"id": user["id"]},
        {"$set": {
            "family_group_id": group["id"],
            "family_group_role": "owner",
        }},
    )
    return group


async def get_group(db, group_id: Optional[str]) -> Optional[dict]:
    if not group_id:
        return None
    return await db.family_groups.find_one({"id": group_id}, {"_id": 0})


async def get_group_by_code(db, code: str) -> Optional[dict]:
    code = normalize_invite_code(code)
    if not code:
        return None
    return await db.family_groups.find_one({"invite_code": code}, {"_id": 0})


async def list_group_users(db, group_id: str) -> List[dict]:
    if not group_id:
        return []
    cursor = db.users.find(
        {"family_group_id": group_id},
        {"_id": 0, "hashed_password": 0, "push_tokens": 0},
    )
    return await cursor.to_list(200)


async def list_group_user_ids(db, group_id: str) -> List[str]:
    if not group_id:
        return []
    cursor = db.users.find({"family_group_id": group_id}, {"_id": 0, "id": 1})
    docs = await cursor.to_list(200)
    return [d["id"] for d in docs if d.get("id")]


async def ensure_family_group(db, user: dict) -> str:
    """Make sure the user has a valid family_group_id; lazy-create solo group.

    Also backfills `family_group_id` on the user's existing owned data so legacy
    accounts seamlessly join the group-scoped query model.
    """
    gid = user.get("family_group_id")
    if gid:
        g = await db.family_groups.find_one({"id": gid}, {"_id": 0, "id": 1})
        if g:
            return gid
    # Need a new solo group.
    group = await create_group_for_user(db, user)
    gid = group["id"]
    user["family_group_id"] = gid
    user["family_group_role"] = "owner"
    # Backfill family_group_id on this user's existing owned data.
    for coll in DATA_COLLECTIONS:
        try:
            await db[coll].update_many(
                {"owner_id": user["id"], "family_group_id": {"$exists": False}},
                {"$set": {"family_group_id": gid}},
            )
        except Exception as e:
            logger.warning(f"ensure_family_group backfill {coll} failed: {e}")
    return gid


async def transfer_data_to_group(db, owner_user_id: str, target_group_id: str) -> None:
    """Re-tag this user's owned data into a new group (used when they join)."""
    for coll in DATA_COLLECTIONS:
        try:
            await db[coll].update_many(
                {"owner_id": owner_user_id},
                {"$set": {"family_group_id": target_group_id}},
            )
        except Exception as e:
            logger.warning(f"transfer_data_to_group {coll} failed: {e}")


def public_group(group: dict) -> dict:
    if not group:
        return {}
    return {
        "id": group["id"],
        "name": group.get("name") or "Family",
        "owner_user_id": group.get("owner_user_id"),
        "invite_code": group.get("invite_code"),
        "created_at": (
            group["created_at"].isoformat()
            if isinstance(group.get("created_at"), datetime)
            else group.get("created_at")
        ),
    }


def public_member_row(u: dict, owner_user_id: Optional[str]) -> dict:
    return {
        "user_id": u.get("id"),
        "full_name": u.get("full_name") or "",
        "email": u.get("email") or "",
        "role": "owner" if (owner_user_id and u.get("id") == owner_user_id) else "member",
        "joined_at": (
            u["created_at"].isoformat()
            if isinstance(u.get("created_at"), datetime) else u.get("created_at")
        ),
    }


# ---------- Routes (registered on /api/family-group) ----------
def build_router(
    db,
    get_current_user,
    push_to_user=None,
    send_email: Optional[Callable[[str, str, str], Awaitable[bool]]] = None,
):
    """Build the family-group APIRouter wired against the provided db and auth dep.

    `send_email(to_email, subject, body) -> bool` is an OPTIONAL coroutine that
    delivers an outgoing email (e.g. via Resend).  When provided, the
    /invite endpoint will call it after creating the invite record; when
    None the invite is still recorded (useful in tests) but no email goes
    out.
    """
    router = APIRouter(prefix="/family-group", tags=["family-group"])

    @router.get("")
    async def get_my_family_group(current=Depends(get_current_user)):
        gid = await ensure_family_group(db, current)
        group = await get_group(db, gid)
        users = await list_group_users(db, gid)
        owner_id = group.get("owner_user_id") if group else None
        members = [public_member_row(u, owner_id) for u in users]
        # Sort: owner first, then by name
        members.sort(key=lambda r: (0 if r["role"] == "owner" else 1, r["full_name"].lower()))
        return {
            "group": public_group(group),
            "members": members,
            "my_role": "owner" if current.get("id") == owner_id else "member",
            "member_count": len(members),
        }

    @router.put("")
    async def rename_family_group(
        data: FamilyGroupRename,
        current=Depends(get_current_user),
    ):
        gid = await ensure_family_group(db, current)
        group = await get_group(db, gid)
        if not group:
            raise HTTPException(404, "Family group not found")
        if group.get("owner_user_id") != current["id"]:
            raise HTTPException(403, "Only the group owner can rename the family")
        new_name = (data.name or "").strip()
        if not new_name or len(new_name) > 80:
            raise HTTPException(400, "Name must be 1-80 characters")
        await db.family_groups.update_one(
            {"id": gid}, {"$set": {"name": new_name}}
        )
        group["name"] = new_name
        return {"ok": True, "group": public_group(group)}

    @router.post("/regenerate-code")
    async def regenerate_invite_code(current=Depends(get_current_user)):
        gid = await ensure_family_group(db, current)
        group = await get_group(db, gid)
        if not group:
            raise HTTPException(404, "Family group not found")
        if group.get("owner_user_id") != current["id"]:
            raise HTTPException(403, "Only the group owner can regenerate the invite code")
        new_code = await _generate_unique_invite_code(db)
        await db.family_groups.update_one({"id": gid}, {"$set": {"invite_code": new_code}})
        group["invite_code"] = new_code
        return {"ok": True, "invite_code": new_code, "group": public_group(group)}

    @router.post("/join")
    async def join_family_group(
        data: FamilyGroupJoin,
        current=Depends(get_current_user),
    ):
        """Join an existing family group via invite code.

        Behavior:
          - If the user is the OWNER of a multi-user group, joining is rejected (they
            would orphan other members). They must transfer ownership first.
          - If the user is in a solo group, that group is deleted after they leave.
          - The user's data (members/reminders/alerts/etc.) is re-tagged to the new
            target group so the family sees a merged dashboard immediately.
        """
        code = normalize_invite_code(data.invite_code)
        # Accept BOTH the family-wide KINN- code AND a per-recipient
        # INV- token (issued via POST /family-group/invite).  The
        # resolver returns (group, invite_doc) — invite_doc is None
        # for family-wide codes.  Without this fork, existing
        # signed-in users typing an INV- token from their email got
        # "Invite code not found" because the original implementation
        # only checked db.family_groups.invite_code.
        target, accepted_invite = await resolve_invite_code(db, code)
        if not target:
            raise HTTPException(404, "Invite code not found")
        old_gid = current.get("family_group_id")
        if target["id"] == old_gid:
            return {"ok": True, "already_member": True, "group": public_group(target)}

        # Owner of multi-user group can't leave
        if old_gid:
            old_group = await get_group(db, old_gid)
            if old_group and old_group.get("owner_user_id") == current["id"]:
                co_users = await db.users.count_documents(
                    {"family_group_id": old_gid, "id": {"$ne": current["id"]}}
                )
                if co_users > 0:
                    raise HTTPException(
                        400,
                        "You're the owner of a family with other members. "
                        "Remove them first or transfer ownership before joining a different family.",
                    )

        # Move data to new group, update user, delete old solo group
        await transfer_data_to_group(db, current["id"], target["id"])
        await db.users.update_one(
            {"id": current["id"]},
            {"$set": {
                "family_group_id": target["id"],
                "family_group_role": "member",
            }},
        )
        # Cleanup old solo group if it has no users left
        if old_gid and old_gid != target["id"]:
            remaining = await db.users.count_documents({"family_group_id": old_gid})
            if remaining == 0:
                await db.family_groups.delete_one({"id": old_gid})

        current["family_group_id"] = target["id"]
        current["family_group_role"] = "member"

        # Notify other group members via push that someone joined
        if push_to_user is not None:
            try:
                other_ids = await list_group_user_ids(db, target["id"])
                joiner_name = current.get("full_name") or "A new family member"
                for uid in other_ids:
                    if uid == current["id"]:
                        continue
                    await push_to_user(
                        uid,
                        "👋 New family member joined",
                        f"{joiner_name} just joined your Kinnship family.",
                        {"type": "family_join", "user_id": current["id"]},
                    )
            except Exception as e:
                logger.warning(f"join push notify failed: {e}")

        # If this join consumed a per-recipient INV- token, mark it
        # accepted (locks the token from re-use) and send a targeted
        # "your invite was accepted" push to whoever sent the invite.
        # Best-effort — never fail the join just because the
        # bookkeeping push misfires.
        if accepted_invite:
            try:
                await accept_invite(db, accepted_invite["id"], current["id"])
            except Exception as e:
                logger.warning(f"accept_invite bookkeeping failed: {e}")
            inviter_id = accepted_invite.get("invited_by_user_id")
            if push_to_user is not None and inviter_id and inviter_id != current["id"]:
                try:
                    joiner_name = current.get("full_name") or "Your invited family member"
                    await push_to_user(
                        inviter_id,
                        "✅ Family invite accepted",
                        f"{joiner_name} just joined your Kinnship family.",
                        {
                            "type": "family_join",
                            "user_id": current["id"],
                            "invite_id": accepted_invite["id"],
                        },
                    )
                except Exception as e:
                    logger.warning(f"inviter push failed: {e}")

        return {"ok": True, "group": public_group(target)}

    @router.post("/leave")
    async def leave_family_group(current=Depends(get_current_user)):
        gid = current.get("family_group_id")
        if not gid:
            raise HTTPException(400, "You are not in a family group")
        group = await get_group(db, gid)
        if not group:
            # Out of sync; just lazy-create new solo group.
            new_group = await create_group_for_user(db, current)
            return {"ok": True, "new_group": public_group(new_group)}
        if group.get("owner_user_id") == current["id"]:
            co_users = await db.users.count_documents(
                {"family_group_id": gid, "id": {"$ne": current["id"]}}
            )
            if co_users > 0:
                raise HTTPException(
                    400,
                    "You're the owner of a family with other members. "
                    "Transfer ownership or remove other members first.",
                )
        # Detach the user's existing data and ship it into a fresh solo group.
        new_group = await create_group_for_user(db, current)
        await transfer_data_to_group(db, current["id"], new_group["id"])
        # If old group has no more users, delete it
        remaining = await db.users.count_documents({"family_group_id": gid})
        if remaining == 0:
            await db.family_groups.delete_one({"id": gid})
        return {"ok": True, "new_group": public_group(new_group)}

    @router.post("/remove-member")
    async def remove_member(
        data: FamilyGroupMemberRemove,
        current=Depends(get_current_user),
    ):
        gid = await ensure_family_group(db, current)
        group = await get_group(db, gid)
        if not group:
            raise HTTPException(404, "Family group not found")
        if group.get("owner_user_id") != current["id"]:
            raise HTTPException(403, "Only the group owner can remove members")
        if data.user_id == current["id"]:
            raise HTTPException(400, "Cannot remove yourself; use leave instead")
        target_user = await db.users.find_one(
            {"id": data.user_id, "family_group_id": gid}, {"_id": 0}
        )
        if not target_user:
            raise HTTPException(404, "User is not in your family group")
        # Move the removed user to a fresh solo group (preserves their own data).
        solo = await create_group_for_user(db, target_user)
        await transfer_data_to_group(db, target_user["id"], solo["id"])
        return {"ok": True, "removed_user_id": data.user_id}

    # ----- Email invitations (per-recipient tokens) -----
    @router.post("/invite")
    async def send_invite(
        data: FamilyInviteCreate,
        current=Depends(get_current_user),
    ):
        """Email a single-use invite token to a prospective family member.

        Any group member (owner or member) can send invites — staying
        consistent with how /family-group/regenerate-code is owner-only
        but viewing+sharing the wall code is open to all.  Keep this
        open so e.g. a sibling caregiver can invite their parent without
        needing the household owner's account.
        """
        gid = await ensure_family_group(db, current)
        group = await get_group(db, gid)
        if not group:
            raise HTTPException(404, "Family group not found")

        name = (data.name or "").strip()
        email = (data.email or "").strip().lower()
        if not name or len(name) > 80:
            raise HTTPException(400, "Name must be 1-80 characters")
        if not email or "@" not in email:
            raise HTTPException(400, "Valid email required")

        # Soft cap: refuse if there are already 50 pending invites for
        # this group (abuse-prevention; tweak later if needed).
        pending = await db.family_invites.count_documents(
            {"family_group_id": gid, "status": "pending"}
        )
        if pending >= 50:
            raise HTTPException(
                429, "Too many pending invites. Revoke old ones first."
            )

        token = await _generate_unique_invite_token(db)
        now = datetime.now(timezone.utc)
        expires = now + timedelta(days=INVITE_TTL_DAYS)
        inviter_name = (current.get("full_name") or "A Kinnship user").strip()
        group_name = group.get("name") or "Family"

        invite_doc = {
            "id": str(uuid.uuid4()),
            "token": token,
            "family_group_id": gid,
            "invited_by_user_id": current["id"],
            "inviter_name": inviter_name,
            "invitee_name": name,
            "invitee_email": email,
            "status": "pending",
            "created_at": now,
            "expires_at": expires,
            "accepted_by_user_id": None,
            "accepted_at": None,
        }
        await db.family_invites.insert_one(invite_doc)

        # Send the email out-of-band.  Don't fail the request if the
        # transport is misconfigured — the invite row is persisted and
        # the inviter can copy the token to share manually as fallback.
        #
        # `RESEND_INVITE_FROM` lets the operator use a different verified
        # sender for invites than for OTPs (e.g. `Kinnship <hello@kinnship.app>`
        # for invites, `Kinnship <noreply@resend.dev>` for OTPs).  Falls
        # back to `RESEND_FROM` if not configured.
        delivered = False
        if send_email is not None:
            try:
                subject, text_body, html_body = _invite_email_body(
                    inviter_name=inviter_name,
                    group_name=group_name,
                    token=token,
                    invitee_name=name,
                    expires_at=expires,
                )
                invite_from = (
                    os.environ.get("RESEND_INVITE_FROM")
                    or os.environ.get("RESEND_FROM")
                )
                delivered = bool(await send_email(
                    email, subject, text_body,
                    html=html_body, from_override=invite_from,
                ))
            except Exception as e:
                logger.warning(f"family invite email send failed: {e}")
                delivered = False
        return {
            "ok": True,
            "delivered": delivered,
            "invite": _public_invite(invite_doc),
        }

    @router.get("/invites")
    async def list_invites(current=Depends(get_current_user)):
        """List all invites for the current user's family group."""
        gid = await ensure_family_group(db, current)
        cursor = db.family_invites.find(
            {"family_group_id": gid}, {"_id": 0}
        ).sort("created_at", -1)
        rows = await cursor.to_list(200)
        # Auto-transition any obviously-stale pending rows to `expired`
        # on read so the client sees consistent state without a cron.
        # Mongo returns datetimes as TZ-naive (BSON has no tzinfo) so we
        # promote them to UTC-aware before comparing — otherwise this
        # crashes with "can't compare offset-naive and offset-aware
        # datetimes".
        now = datetime.now(timezone.utc)
        cleaned = []
        for r in rows:
            exp = r.get("expires_at")
            if isinstance(exp, datetime) and exp.tzinfo is None:
                exp = exp.replace(tzinfo=timezone.utc)
            if (
                r.get("status") == "pending"
                and isinstance(exp, datetime)
                and now > exp
            ):
                try:
                    await db.family_invites.update_one(
                        {"id": r["id"]}, {"$set": {"status": "expired"}}
                    )
                except Exception:
                    pass
                r["status"] = "expired"
            cleaned.append(_public_invite(r))
        return {"invites": cleaned, "count": len(cleaned)}

    @router.delete("/invites/{invite_id}")
    async def revoke_invite(
        invite_id: str,
        current=Depends(get_current_user),
    ):
        """Revoke a still-pending invite. No-op if already
        accepted/expired/revoked."""
        gid = await ensure_family_group(db, current)
        inv = await db.family_invites.find_one(
            {"id": invite_id, "family_group_id": gid}, {"_id": 0}
        )
        if not inv:
            raise HTTPException(404, "Invite not found")
        if inv.get("status") != "pending":
            return {"ok": True, "status": inv.get("status")}
        await db.family_invites.update_one(
            {"id": invite_id}, {"$set": {"status": "revoked"}}
        )
        return {"ok": True, "status": "revoked"}

    return router


def _public_invite(inv: dict) -> dict:
    """Serialise an invite row for API consumers (no internal ObjectIDs,
    safe ISO datetimes)."""
    def _iso(v):
        return v.isoformat() if isinstance(v, datetime) else v
    return {
        "id": inv.get("id"),
        "token": inv.get("token"),
        "invitee_name": inv.get("invitee_name"),
        "invitee_email": inv.get("invitee_email"),
        "inviter_name": inv.get("inviter_name"),
        "status": inv.get("status"),
        "created_at": _iso(inv.get("created_at")),
        "expires_at": _iso(inv.get("expires_at")),
        "accepted_at": _iso(inv.get("accepted_at")),
        "accepted_by_user_id": inv.get("accepted_by_user_id"),
    }
