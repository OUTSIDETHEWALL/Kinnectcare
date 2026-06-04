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
"""
from __future__ import annotations

import logging
import secrets
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel

logger = logging.getLogger(__name__)

INVITE_CODE_PREFIX = "KINN"
# Avoid visually ambiguous chars (0/O, 1/I/L)
INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
INVITE_LEN = 6

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
def build_router(db, get_current_user, push_to_user=None):
    """Build the family-group APIRouter wired against the provided db and auth dep."""
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
        target = await get_group_by_code(db, code)
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

    return router
