"""Small deletion barrier around provider calls, not a notification queue.

Never expire an active attempt: a paused process or a thread may still submit
it. Cancellation of a request does not cancel its provider task. Process death,
unknown commit, or failed settlement leaves a durable fail-closed blocker.
"""
import asyncio
import hashlib
import uuid
from datetime import datetime, timezone

from fastapi import HTTPException
import family_write_fence as fw

_tasks = set()


def email_key(email):
    return hashlib.sha256(email.strip().lower().encode()).hexdigest()


async def assert_idle(tx, uid, email):
    selector = {"$or": [{"user_ids": uid}]}
    if email:
        selector["$or"].append({"email_hash": email_key(email)})
    if await tx.deletion_deliveries.find_one({**selector, "state": "active"}):
        raise HTTPException(409, "A notification or email is still in progress or needs delivery review. No data was deleted.")
    return selector


async def reserve(db, *, user_ids=(), data=None, email=None, validate=None, operation_key=None):
    attempt = uuid.uuid4().hex

    async def action(tx):
        ids = set(filter(None, user_ids))
        payload = data or {}
        if payload.get("member_id"):
            subject = payload["member_id"]
            user_subject = False
            if payload.get("type") in ("sos", "alert_resolved"):
                alert = await tx.alerts.find_one({"id": payload.get("alert_id"), "type": "sos", "member_id": subject})
                if not alert:
                    return None
                if alert.get("sos_subject_kind") == "user":
                    if subject != alert.get("owner_id"):
                        return None
                    user_subject = True
                elif not alert.get("sos_subject_kind") and subject == alert.get("owner_id"):
                    # Legacy default/self SOS is a user ID, never a guessed
                    # fallback from a missing member. Reject namespace collision.
                    if await tx.members.find_one({"id": subject, "user_id": {"$ne": subject}}):
                        return None
                    user_subject = True
            if user_subject:
                ids.add(subject)
            else:
                member = await tx.members.find_one({"id": subject})
                if not member:
                    return None
                if member.get("user_id"):
                    ids.add(member["user_id"])
        # Family-join payloads identify the joining account too.
        if payload.get("user_id"):
            ids.add(payload["user_id"])
        for uid in sorted(ids):
            result = await tx.users.update_one(
                {"id": uid}, {"$inc": {"deletion_delivery_epoch": 1}},
            )
            if result.matched_count != 1:
                return None
        if email:
            await tx.email_link_identities.update_one(
                {"_id": email_key(email)}, {"$inc": {"generation": 1}}, upsert=True,
            )
        if validate and not await validate(tx):
            return None
        if not ids and not email:
            raise ValueError("Deletion-sensitive delivery needs an identity")
        key = None
        if operation_key:
            key = email_key(str(operation_key))
            if await tx.deletion_deliveries.find_one({"operation_key": key, "state": "active"}):
                return None
        await tx.deletion_deliveries.insert_one({
            "_id": attempt, "user_ids": sorted(ids),
            "email_hash": email_key(email) if email else None,
            "operation_key": key,
            "state": "active", "started_at": datetime.now(timezone.utc),
        })
        return attempt

    return await fw.run(db, [], action)


async def complete(db, attempt):
    # A real provider return proves the application call is no longer active,
    # NOT that the notification was displayed or cannot arrive later.
    result = await db.deletion_deliveries.update_one(
        {"_id": attempt, "state": "active"},
        {"$set": {"state": "completed", "completed_at": datetime.now(timezone.utc)}},
    )
    if result.matched_count != 1:
        raise RuntimeError("Delivery completion did not match its active attempt")


async def run(db, operation, *, suppressed=None, **scope):
    async def owned():
        attempt = await reserve(db, **scope)
        if not attempt:
            return suppressed
        # Do not settle in finally. Cancellation/exception (including a thread
        # abandoned during shutdown) is not proof that submission has stopped.
        result = await operation()
        await complete(db, attempt)
        return result

    task = asyncio.create_task(owned())
    _tasks.add(task)

    def finished(done):
        _tasks.discard(done)
        if not done.cancelled():
            done.exception()  # Retrieve failures even if the caller disconnected.

    task.add_done_callback(finished)
    return await asyncio.shield(task)
