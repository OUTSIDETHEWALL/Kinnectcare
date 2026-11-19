"""Per-account cleanup under existing identity/family transaction safeguards.

Never a bulk reset or a retention worker. A subject reference alone is not
permission to delete another person's care, and external sends stay outside
transactions. Already submitted provider notifications cannot be recalled.
"""
import copy
import hashlib

from fastapi import HTTPException

import family_write_fence as fw
import sos_history as sh

CARE = ("members", "reminders", "checkins", "alerts", "medication_logs")


async def persist_subject_evidence(db, collection, document, *, member_id,
                                   family_id, subject_user_id, upsert_selector=None):
    """Serialize PRIVATE evidence with deletion of its existing subject row.

    Never acquire the family structural fence for telemetry. This does not
    authorize a location fix or change its publication: callers already made
    that decision. A real write to the parent makes late child inserts conflict
    with deletion; a snapshot read or no-op check would not provide this.
    """
    if collection not in ("location_history", "location_ingest_log", "recovery_push_evidence"):
        raise ValueError("Not a private subject-evidence collection")

    async def persist(session):
        tx = fw.SessionDatabase(db, session)
        parent = await tx.members.update_one({
            "id": member_id, "family_group_id": family_id, "user_id": subject_user_id,
        }, {"$inc": {"private_evidence_epoch": 1}})
        if not parent.matched_count:
            return False
        if upsert_selector is None:
            await tx[collection].insert_one(copy.deepcopy(document))
        else:
            await tx[collection].update_one(
                upsert_selector, {"$set": copy.deepcopy(document)}, upsert=True,
            )
        return True

    return await fw.transaction(db, persist, timeout=2.0)


async def _rows(collection, selector):
    rows = await collection.find(selector).to_list(10001)
    if len(rows) > 10000:
        raise HTTPException(409, "This account needs a reviewed large-history deletion. No data was deleted.")
    return rows


async def _delete_rows(tx, name, rows, counts):
    # IDs come only from records whose authority was checked in this snapshot.
    if rows:
        result = await tx[name].delete_many({"_id": {"$in": [row["_id"] for row in rows]}})
        counts[name] = result.deleted_count
    else:
        counts[name] = 0


async def _care_scope(tx, actor, gid, has_family):
    uid = actor["id"]
    self_ids, subjects = await sh.verified_subjects(tx, uid, gid if has_family else None)
    linked = await _rows(tx.members, {"user_id": uid})
    if any(row.get("id") not in self_ids or row.get("family_group_id") != gid for row in linked):
        raise HTTPException(409, "Ambiguous linked profiles require review before account deletion.")
    if has_family:
        # Existing owner, dependent, other-person care and active-SOS rules.
        # This does not change join/leave/removal policy.
        await sh.verify_departure(tx, uid, gid, CARE)
    elif linked:
        raise HTTPException(409, "Linked care needs a verified family before account deletion.")

    if await tx.alerts.find_one({
        "type": "sos",
        "$or": [{"owner_id": uid}, {"member_id": {"$in": subjects}}],
        "$nor": [{"resolved": {"$eq": True, "$type": "bool"}}],
    }, {"_id": 1}):
        raise HTTPException(409, "Resolve or review your active SOS before deleting your account.")

    selectors = {}
    for name in CARE:
        owned = {"owner_id": uid}
        if name == "members":
            owned = {"$or": [owned, {"user_id": uid}]}
        elif name == "alerts":
            owned["type"] = {"$ne": "sos"}
        rows = await _rows(tx[name], owned)
        for row in rows:
            subject = row.get("id") if name == "members" else row.get("member_id")
            if not has_family or row.get("family_group_id") != gid or subject not in (
                self_ids if name == "members" else subjects
            ):
                raise HTTPException(409, "Resolve other members' or ambiguous care records before deleting your account.")
            if name == "members" and row.get("user_id") != uid:
                raise HTTPException(409, "Hand off dependent care before deleting your account.")
        selectors[name] = rows
    # Other-owned ordinary care is not made deletable by a subject match.
    for name in ("reminders", "checkins", "medication_logs", "alerts"):
        selector = {"member_id": {"$in": self_ids}, "owner_id": {"$ne": uid}}
        if name == "alerts":
            selector["type"] = {"$ne": "sos"}
        if await tx[name].find_one(selector, {"_id": 1}):
            raise HTTPException(409, "Review linked family care before deleting your account.")
    return self_ids, subjects, selectors


async def _medication_rows(tx, gid, self_ids, reminders):
    reminder_ids = [row["id"] for row in reminders]
    # IDs are application identities; reject collisions before using them as
    # ownership evidence for legacy rows that lack family metadata.
    if reminder_ids:
        all_reminders = await _rows(tx.reminders, {"id": {"$in": reminder_ids}})
        if len(all_reminders) != len(reminder_ids):
            raise HTTPException(409, "Ambiguous reminder identities need review before deletion.")
    selected = {}
    for name in ("med_notifications", "medication_occurrences"):
        rows = await _rows(tx[name], {"$or": [
            {"member_id": {"$in": self_ids}}, {"reminder_id": {"$in": reminder_ids}},
        ]})
        for row in rows:
            rid = row.get("reminder_id")
            if row.get("member_id") not in self_ids:
                raise HTTPException(409, "Medication history has an ambiguous subject; no data was deleted.")
            if row.get("family_group_id") not in (None, gid):
                raise HTTPException(409, "Medication history spans another family; review it before deletion.")
            if row.get("family_group_id") is None and rid not in reminder_ids:
                raise HTTPException(409, "Legacy medication history needs verified ownership before deletion.")
            if rid not in reminder_ids and await tx.reminders.find_one({"id": rid}, {"_id": 1}):
                raise HTTPException(409, "Another person's reminder history cannot be deleted.")
            if row.get("family_state") == "sending" or row.get("delivery_state") == "sending":
                raise HTTPException(409, "A medication notification is being sent; retry deletion shortly.")
        selected[name] = rows
    return selected


async def _work_rows(tx, uid, gid, self_ids):
    deliveries = await _rows(tx.checkin_deliveries, {"$or": [
        {"user_id": uid}, {"member_id": {"$in": self_ids}},
    ]})
    if any(row.get("state") == "sending" for row in deliveries):
        raise HTTPException(409, "A check-in notification is being sent; retry deletion shortly.")
    requests = await _rows(tx.checkin_requests, {"$or": [
        {"requester_id": uid}, {"target_user_id": uid}, {"member_id": {"$in": self_ids}},
    ]})
    for row in requests:
        if row.get("target_user_id") not in (None, uid) or row.get("member_id") not in self_ids:
            raise HTTPException(409, "Review requests involving another person's care before account deletion.")
        if row.get("family_group_id") != gid:
            raise HTTPException(409, "Review welfare requests from another family before account deletion.")
        if row.get("response_notification_status") == "sending" or row.get("status") == "responding":
            raise HTTPException(409, "A welfare response is being completed; retry deletion shortly.")
    return {"checkin_deliveries": deliveries, "checkin_requests": requests}


async def _private_rows(tx, uid, self_ids):
    selected = {}
    for name, identity in (
        ("location_history", "subject_user_id"),
        ("location_ingest_log", "subject_user_id"),
        ("recovery_push_evidence", "target_user_id"),
    ):
        rows = await _rows(tx[name], {"$or": [
            {identity: uid}, {"member_id": {"$in": self_ids}},
        ]})
        if any(row.get(identity) not in (None, uid) for row in rows):
            raise HTTPException(409, "Device history has ambiguous ownership; review it before deletion.")
        selected[name] = rows
    legacy = await _rows(tx.family_members, {"$or": [
        {"user_id": uid}, {"id": {"$in": self_ids}},
    ]})
    if any(row.get("user_id") not in (None, uid) for row in legacy):
        raise HTTPException(409, "A legacy profile has ambiguous ownership; review it before deletion.")
    selected["family_members"] = legacy
    return selected


async def delete_account_records(db, actor_id, expected_family_id):
    candidate = await db.users.find_one({"id": actor_id})
    if not candidate:
        raise HTTPException(401, "Please sign in again.")
    gid = candidate.get("family_group_id")
    if expected_family_id != gid:
        raise HTTPException(409, "Your family changed; reopen account deletion.")
    group = await db.family_groups.find_one({"id": gid}) if gid else None

    async def delete(tx):
        actor = await fw.actor_in_family(tx, actor_id, gid)
        email = (actor.get("email") or "").strip().lower()
        if email:
            # The existing email identity row serializes link issuance too,
            # including accounts whose family setup is missing.
            await tx.email_link_identities.update_one(
                {"_id": hashlib.sha256(email.encode()).hexdigest()},
                {"$inc": {"generation": 1}}, upsert=True,
            )
        current_group = await tx.family_groups.find_one({"id": gid}) if gid else None
        if bool(group) != bool(current_group):
            raise HTTPException(409, "Family setup changed; reopen account deletion.")
        self_ids, subjects, care = await _care_scope(tx, actor, gid, bool(current_group))
        medication = await _medication_rows(tx, gid, self_ids, care["reminders"])
        work = await _work_rows(tx, actor_id, gid, self_ids)
        private = await _private_rows(tx, actor_id, self_ids)

        if email and await tx.users.find_one({"email": email, "id": {"$ne": actor_id}}, {"_id": 1}):
            raise HTTPException(409, "Ambiguous account identity requires review before deletion.")

        counts = {}
        # Complete the classification BEFORE any cleanup. All mutations still
        # roll back together on a later failure or transaction retry.
        for name, rows in {**medication, **work, **private, **care}.items():
            await _delete_rows(tx, name, rows, counts)
        invites = {"$or": [
            {"invited_by_user_id": actor_id}, {"accepted_by_user_id": actor_id},
            *([{"invitee_email": email}] if email else []),
        ]}
        counts["family_invites"] = (await tx.family_invites.delete_many(invites)).deleted_count
        credentials = {"$or": [
            {"issued_user_id": actor_id}, *([{"email": email}] if email else []),
        ]}
        counts["email_links"] = (await tx.email_links.delete_many(credentials)).deleted_count
        if email:
            counts["otp_codes"] = (await tx.otp_codes.delete_many({"email": email})).deleted_count
            counts["email_link_identities"] = (await tx.email_link_identities.delete_one({
                "_id": hashlib.sha256(email.encode()).hexdigest(),
            })).deleted_count
        removed = await tx.users.delete_one({"id": actor_id, "family_group_id": gid} if gid else {
            "id": actor_id, "family_group_id": {"$in": [None, ""]},
        })
        if removed.deleted_count != 1:
            raise HTTPException(409, "Your account changed; no data was deleted.")
        counts["users"] = 1
        if current_group and current_group.get("owner_user_id") == actor_id:
            if await tx.alerts.find_one({"family_group_id": gid, "type": "sos"}, {"_id": 1}):
                # Retain the existing history scope, not an active invitation or
                # a deleted owner's personal family display name.
                await tx.family_groups.update_one({"id": gid}, {
                    "$set": {"owner_user_id": None, "name": "Archived family"},
                    "$unset": {"invite_code": ""},
                })
            else:
                counts["family_groups"] = (await tx.family_groups.delete_one({"id": gid})).deleted_count
        return actor, counts

    return await fw.run(
        db, [gid] if group else [], delete,
        timeout=fw.FAMILY_TRANSFER_TIMEOUT_SECONDS, sos_priority=True,
    )
