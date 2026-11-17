"""Strict self-SOS history classification, never general family authority.

The SOS endpoint's default subject is a user ID, not a members.id. Both forms
are valid, but only when they unambiguously identify the authenticated account.
These selectors are used inside the caller's transaction where available.
"""
from fastapi import HTTPException


async def verified_subjects(db, user_id, family_id=None):
    query = {"user_id": user_id}
    if family_id is not None:
        query["family_group_id"] = family_id
    rows = await db.members.find(query, {"id": 1}).to_list(1001)
    if len(rows) > 1000:
        raise HTTPException(409, "Too many member references to safely verify family history.")
    member_ids = {r["id"] for r in rows if isinstance(r.get("id"), str) and r["id"]}
    candidates = member_ids | {user_id}
    # A duplicate/colliding member reference must never become self authority.
    references = await db.members.find({"id": {"$in": list(candidates)}},
                                       {"id": 1, "user_id": 1}).to_list(2001)
    if len(references) > 2000:
        raise HTTPException(409, "Ambiguous member references prevent safe family transfer.")
    counts = {}
    invalid = set()
    for row in references:
        ref = row["id"]
        counts[ref] = counts.get(ref, 0) + 1
        if row.get("user_id") != user_id or counts[ref] > 1:
            invalid.add(ref)
    accounts = await db.users.find({"id": {"$in": list(candidates)}}, {"id": 1}).to_list(1002)
    invalid.update(r["id"] for r in accounts if r["id"] != user_id)
    return sorted(member_ids - invalid), sorted(candidates - invalid)


def resolved_self_sos(user_id, subjects, family_id=None):
    """Only an explicit BSON boolean true counts; 1/string/missing do not."""
    query = {
        "owner_id": user_id,
        "member_id": {"$in": subjects},
        "type": "sos",
        "resolved": {"$eq": True, "$type": "bool"},
    }
    if family_id is not None:
        query["family_group_id"] = family_id
    return query


def movable_records(collection, user_id, member_ids, family_id):
    query = {"owner_id": user_id, "member_id": {"$in": member_ids},
             "family_group_id": family_id}
    if collection == "alerts":
        # SOS history is retained in place; unresolved/ambiguous SOS is not
        # made transferable by the ordinary self-care-record selector.
        query["type"] = {"$ne": "sos"}
    return query


async def removal_move_query(db, user_id, collection):
    query = {"owner_id": user_id}
    if collection == "alerts":
        _, subjects = await verified_subjects(db, user_id)
        query["$nor"] = [resolved_self_sos(user_id, subjects)]
    return query


async def own_history(db, user_id):
    # Re-read identity; a retained token for a deleted account grants nothing.
    if not await db.users.find_one({"id": user_id}, {"id": 1}):
        raise HTTPException(401, "Please sign in again.")
    _, subjects = await verified_subjects(db, user_id)
    # This endpoint intentionally returns a small safe projection, not raw
    # alerts: old messages/titles can embed GPS and other people's details.
    rows = await db.alerts.find(
        resolved_self_sos(user_id, subjects),
        {"_id": 0, "id": 1, "type": 1, "resolved": 1,
         "created_at": 1, "resolved_at": 1},
    ).sort([("created_at", -1), ("id", 1)]).to_list(101)
    return {"items": rows[:100], "has_more": len(rows) > 100}


async def family_alert_query(db, family_id):
    """Retained resolved incidents must not restore former-family access.

    Deliberately restrict all resolved SOS with a departed/deleted owner,
    even if its subject is now ambiguous. The own-history selector is separate.
    """
    users = await db.users.find({"family_group_id": family_id}, {"id": 1}).to_list(10001)
    if len(users) > 10000:
        raise HTTPException(409, "Family alert access could not be safely verified.")
    return {
        "family_group_id": family_id,
        "$or": [
            {"type": {"$ne": "sos"}},
            {"resolved": {"$ne": True}},
            {"owner_id": {"$in": [u["id"] for u in users]}},
        ],
    }
