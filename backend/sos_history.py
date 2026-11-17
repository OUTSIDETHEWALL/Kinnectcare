"""Strict self-SOS history classification, never general family authority.

The SOS endpoint's default subject is a user ID, not a members.id. Both forms
are valid, but only when they unambiguously identify the authenticated account.
These selectors are used inside the caller's transaction where available.
"""
from fastapi import HTTPException
from pymongo.read_concern import ReadConcern
import family_write_fence as fw


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


async def verify_departure(db, user_id, family_id, collections):
    """Shared admission for join, leave and removal under the source fence."""
    self_ids, subjects = await verified_subjects(db, user_id, family_id)
    history = resolved_self_sos(user_id, subjects, family_id)
    if await db.alerts.find_one({
        "family_group_id": family_id, "type": "sos", "$nor": [history],
        "$or": [{"owner_id": user_id}, {"member_id": {"$in": subjects},
                                        "$nor": [{"resolved": {"$eq": True, "$type": "bool"}}]}],
    }, {"_id": 1}):
        raise HTTPException(409, "Resolve or review your current family's SOS before leaving it.")
    family = await db.family_groups.find_one({"id": family_id})
    if not family:
        raise HTTPException(409, "The source family could not be verified.")
    for collection, subject in (("members", "user_id"), ("reminders", "member_id")):
        if collection not in collections:
            continue
        own_subjects = [user_id] if collection == "members" else self_ids
        if await db[collection].find_one({
            "owner_id": user_id, "family_group_id": family_id,
            subject: {"$nin": own_subjects},
        }, {"_id": 1}):
            raise HTTPException(409, "Hand off dependent care in your current family before leaving it.")
    if "reminders" in collections and await db.reminders.find_one({
        "family_group_id": family_id, "member_id": {"$in": self_ids},
        "owner_id": {"$ne": user_id},
    }, {"_id": 1}):
        raise HTTPException(409, "Review reminders assigned by your current family before leaving it.")
    if self_ids and await db.medication_occurrences.find_one({
        "member_id": {"$in": self_ids}, "family_state": "sending",
        "$or": [{"family_group_id": family_id}, {"family_group_id": {"$exists": False}}],
    }, {"_id": 1}):
        raise HTTPException(409, "A medication notification is being sent; retry shortly.")
    if family and family.get("owner_user_id") == user_id:
        if await db.users.find_one({"family_group_id": family_id, "id": {"$ne": user_id}}, {"_id": 1}):
            raise HTTPException(409, "Transfer ownership of your current family before leaving it.")
        for collection in collections:
            remaining = {"family_group_id": family_id}
            if collection == "members":
                remaining["user_id"] = {"$ne": user_id}
            else:
                allowed = [movable_records(collection, user_id, self_ids, family_id)]
                if collection == "alerts":
                    allowed.append(history)
                remaining["$nor"] = allowed
            if await db[collection].find_one(remaining, {"_id": 1}):
                raise HTTPException(409, "Your current family still has members or care records. Transfer ownership before leaving it.")
    return self_ids


async def move_verified_self_records(db, user_id, source, target, self_ids, collections):
    if "reminders" in collections and self_ids:
        reminders = await db.reminders.find(
            movable_records("reminders", user_id, self_ids, source), {"id": 1},
        ).to_list(1001)
        if len(reminders) > 1000:
            raise HTTPException(409, "Too many reminders to safely transfer.")
        related = {"reminder_id": {"$in": [row["id"] for row in reminders]},
                   "member_id": {"$in": self_ids}, "family_group_id": source}
        if reminders and await db.medication_occurrences.find_one({
            **related, "family_group_id": {"$exists": False},
        }, {"_id": 1}):
            raise HTTPException(409, "Review legacy medication history before transferring these reminders.")
        for collection in ("medication_occurrences", "med_notifications"):
            await db[collection].update_many(related, {"$set": {"family_group_id": target}})
    await db.members.update_many(
        {"id": {"$in": self_ids}, "user_id": user_id, "family_group_id": source},
        {"$set": {"family_group_id": target}},
    )
    for collection in collections:
        if collection != "members":
            await db[collection].update_many(
                movable_records(collection, user_id, self_ids, source),
                {"$set": {"family_group_id": target}},
            )


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


async def read_family_alerts(db, actor_id, family_id):
    """Authorize and read from one snapshot without writing on every poll."""
    async def read(session):
        tx = fw.SessionDatabase(db, session)
        await fw.actor_in_family(tx, actor_id, family_id)
        scope = await family_alert_query(tx, family_id)
        return await tx.alerts.find(scope, {"_id": 0}).sort("created_at", -1).to_list(2000)
    # A snapshot linearizes at its first read. Return no archived SOS when
    # membership changed before the alert operation finished: a snapshot
    # alone could still return data visible at request start.
    rows = await fw.transaction(db, read, read_concern=ReadConcern("snapshot"))
    sos_owners = {row.get("owner_id") for row in rows if row.get("type") == "sos"}
    identities = sos_owners | {actor_id}
    current = await db.users.find(
        {"id": {"$in": list(identities)}, "family_group_id": family_id}, {"id": 1},
    ).to_list(len(identities))
    allowed = {user["id"] for user in current}
    if actor_id not in allowed:
        raise HTTPException(409, "Your family changed; reopen this action.")
    # Legacy active SOS remain visible even when the owner is no longer
    # present. Do not reuse snapshot details for those rows: they may have
    # been resolved and archived before the final authorization check.
    legacy_ids = [row["id"] for row in rows if row.get("type") == "sos"
                  and row.get("owner_id") not in allowed and row.get("resolved") is not True]
    active = {}
    if legacy_ids:
        active = {row["id"]: row for row in await db.alerts.find({
            "id": {"$in": legacy_ids}, "type": "sos", "family_group_id": family_id,
            "resolved": {"$ne": True},
        }, {"_id": 0}).to_list(len(legacy_ids))}
    return [row if row.get("type") != "sos" or row.get("owner_id") in allowed else active[row["id"]]
            for row in rows if row.get("type") != "sos" or row.get("owner_id") in allowed or row["id"] in active]


async def acknowledge_in_family(db, actor_id, family_id, alert_id, *, complete_medication=None):
    """Check current authority and acknowledge within the transfer fence."""
    async def ack(tx):
        await fw.actor_in_family(tx, actor_id, family_id)
        scope = await family_alert_query(tx, family_id)
        alert = await tx.alerts.find_one({"id": alert_id, **scope}, {"_id": 0})
        if not alert:
            raise HTTPException(404, "Alert not found")
        if alert.get("type") == "sos" and not await tx.users.find_one({
            "id": alert.get("owner_id"), "family_group_id": family_id,
        }, {"_id": 1}):
            raise HTTPException(404, "Alert not found")
        medication = alert.get("type") == "medication" and alert.get("self_due") is True
        if medication:
            if complete_medication is None:
                raise HTTPException(409, "Medication acknowledgment requires an exact occurrence.")
            await complete_medication(tx, alert)
        result = await tx.alerts.update_one({"id": alert_id, **scope}, {"$set": {"acknowledged": True}})
        if result.matched_count != 1:
            raise HTTPException(409, "Alert changed.")
        return alert
    return await fw.run(db, [family_id], ack)


async def delete_account_records(db, actor_id, family_id):
    """Delete only when the old deletion scope can be coordinated safely."""
    if not family_id:
        raise HTTPException(409, "Complete family setup before deleting your account.")

    async def delete(tx):
        actor = await fw.actor_in_family(tx, actor_id, family_id)
        # Do not abandon an active incident or a family that needs its owner.
        await verify_departure(tx, actor_id, family_id, (
            "members", "reminders", "alerts", "checkins", "medication_logs",
        ))
        self_ids, subjects = await verified_subjects(tx, actor_id, family_id)
        if await tx.members.find_one({
            "family_group_id": family_id, "owner_id": actor_id, "user_id": {"$ne": actor_id},
        }, {"_id": 1}):
            raise HTTPException(409, "Resolve dependent care before deleting your account.")
        if await tx.alerts.find_one({
            "family_group_id": family_id, "member_id": {"$in": subjects}, "type": "sos",
            "$nor": [{"resolved": {"$eq": True, "$type": "bool"}}],
        }, {"_id": 1}):
            raise HTTPException(409, "Resolve your active SOS before deleting your account.")
        # Existing scheduler/check-in state is not uniformly family-scoped.
        # Reject rather than leaving references or deleting ambiguous records.
        for collection in ("reminders", "checkins", "medication_logs", "alerts"):
            foreign = {"member_id": {"$in": self_ids}, "owner_id": {"$ne": actor_id}}
            if collection == "alerts":
                foreign["type"] = {"$ne": "sos"}
            if await tx[collection].find_one(foreign, {"_id": 1}):
                raise HTTPException(409, "Resolve linked care records before deleting your account.")
        for collection in ("med_notifications", "medication_occurrences", "checkin_requests"):
            references = {"member_id": {"$in": self_ids}}
            if collection == "checkin_requests":
                references = {"$or": [references, {"requester_id": actor_id}, {"target_user_id": actor_id}]}
            if await tx[collection].find_one(references, {"_id": 1}):
                raise HTTPException(409, "Resolve linked care records before deleting your account.")
        counts = {}
        for collection in ("members", "reminders", "checkins", "alerts", "medication_logs"):
            owned = {"owner_id": actor_id}
            if collection == "members":
                owned = {"$or": [owned, {"user_id": actor_id}]}
            if collection == "alerts":
                owned["type"] = {"$ne": "sos"}
            if await tx[collection].find_one({**owned, "family_group_id": {"$ne": family_id}}, {"_id": 1}):
                raise HTTPException(409, "Account records span more than one family and cannot be deleted safely.")
            if collection != "members" and await tx[collection].find_one({
                **owned, "family_group_id": family_id, "member_id": {"$nin": subjects},
            }, {"_id": 1}):
                raise HTTPException(409, "Resolve other members' care records before deleting your account.")
            counts[collection] = (await tx[collection].delete_many({
                **owned, "family_group_id": family_id,
            })).deleted_count
        await tx.users.delete_one({"id": actor_id, "family_group_id": family_id})
        return actor, counts

    return await fw.run(db, [family_id], delete)


async def delete_dependent_records(db, actor_id, family_id, member_id):
    async def delete(tx):
        await fw.actor_in_family(tx, actor_id, family_id, owner=True)
        query = {"id": member_id, "family_group_id": family_id}
        member = await tx.members.find_one(query)
        if not member:
            raise HTTPException(404, "Member not found")
        if member.get("user_id"):
            raise HTTPException(409, "Use family removal for a member with an account.")
        scope = {"family_group_id": family_id, "member_id": member_id}
        if await tx.alerts.find_one({
            **scope, "type": "sos", "$nor": [{"resolved": {"$eq": True, "$type": "bool"}}],
        }, {"_id": 1}):
            raise HTTPException(409, "Resolve this member's active SOS before removing them.")
        counts = {}
        for collection in ("reminders", "checkins", "alerts", "medication_logs", "med_notifications", "medication_occurrences", "checkin_requests"):
            selector = {**scope, "type": {"$ne": "sos"}} if collection == "alerts" else scope
            if collection == "medication_occurrences":
                # Legacy occurrence rows may lack family_id; never delete
                # ambiguous unscoped state based only on a member reference.
                if await tx[collection].find_one({
                    "member_id": member_id, "family_group_id": {"$exists": False},
                }, {"_id": 1}):
                    raise HTTPException(409, "This member has legacy medication records and cannot be deleted safely.")
            counts[collection] = (await tx[collection].delete_many(selector)).deleted_count
        await tx.members.delete_one(query)
        return counts

    return await fw.run(db, [family_id], delete)
