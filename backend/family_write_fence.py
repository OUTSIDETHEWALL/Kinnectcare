"""Cooperative transaction fence for structural family mutations.

Never use for telemetry or polling. Raw MongoDB writes and legacy maintenance
scripts do not participate automatically. No incident fields serve as locks.
"""
import asyncio
import copy
import logging

from fastapi import HTTPException
from pymongo.errors import PyMongoError
import family_sos_priority


# A transfer performs sequential, security-sensitive reads and writes across
# both families. Budget the *whole* transaction, including conflict/commit
# retries, below the mobile client's 45s request timeout. Do not apply this
# longer bound to SOS persistence or other short structural writes.
FAMILY_TRANSFER_TIMEOUT_SECONDS = 10.0


class SessionCollection:
    def __init__(self, collection, session):
        self.collection, self.session = collection, session

    def __getattr__(self, name):
        method = getattr(self.collection, name)
        def call(*args, **kwargs):
            return method(*args, **kwargs, session=self.session)
        return call


class SessionDatabase:
    def __init__(self, db, session, *, priority=None):
        self.db, self.session = db, session
        self.families = set()
        self.sos_priority = priority

    def __getitem__(self, name):
        return SessionCollection(self.db[name], self.session)

    def __getattr__(self, name):
        return self[name]


async def acquire(tx, family_ids):
    if not isinstance(tx, SessionDatabase):
        raise RuntimeError("A family fence requires the caller's transaction")
    requested = set(filter(None, family_ids)) - tx.families
    if tx.sos_priority is not None:
        tx.sos_priority.families.update(filter(None, family_ids))
        await tx.sos_priority.check()
    if requested and tx.families and min(requested) < max(tx.families):
        raise HTTPException(409, "Family scope changed; retry the operation.")
    for gid in sorted(requested):
        result = await tx.family_groups.update_one(
            {"id": gid}, {"$inc": {"family_write_epoch": 1}},
        )
        if result.matched_count != 1:
            raise HTTPException(409, "Family is no longer available.")
        tx.families.add(gid)


async def run(db, family_ids, action, *, timeout=2.0, sos_priority=False):
    """Abort on cancellation; callbacks must contain only database work.

    Motor retries the entire callback on transient write conflicts and retries
    an uncertain commit, not the external delivery. The outer bound avoids its
    otherwise long default retry window. An uncertain timed-out operation must
    not be reported successful or deliver notifications.
    """
    if isinstance(db, SessionDatabase):
        if sos_priority and db.sos_priority is None:
            raise RuntimeError("A priority transfer requires its own monitored transaction")
        await acquire(db, family_ids)
        return await action(db)

    priority = family_sos_priority.TransferPriority(db) if sos_priority else None

    async def callback(session):
        tx = SessionDatabase(db, session, priority=priority)
        await acquire(tx, family_ids)
        return await action(tx)

    try:
        async with asyncio.timeout(timeout):
            async with await db.client.start_session() as session:
                if priority is not None:
                    return await priority.execute(lambda: _known_commit(session, callback))
                return await _known_commit(session, callback)
    except TimeoutError as error:
        raise HTTPException(503, "Family operation timed out; check its status before retrying.") from error


async def transaction(db, callback, *, timeout=1.0, **options):
    """Bound an existing session-style transfer callback without nesting."""
    try:
        async with asyncio.timeout(timeout):
            async with await db.client.start_session() as session:
                return await _known_commit(session, callback, **options)
    except TimeoutError as error:
        raise HTTPException(503, "Transfer timed out; check your family before retrying.") from error


async def _known_commit(session, callback, **options):
    """Commit before Motor's transaction context can auto-commit on exit.

    The installed Motor context commits outside its own commit-retry loop.
    Explicit callback commits are supported by with_transaction. Retry only
    commit on uncertainty, never the domain callback or external delivery.
    A transient aborted transaction still uses Motor's whole-callback retry.
    Both loops remain inside the caller's deadline.
    """
    async def execute(active_session):
        result = await callback(active_session)
        while True:
            try:
                await active_session.commit_transaction()
                return result
            except PyMongoError as error:
                if not error.has_error_label("UnknownTransactionCommitResult"):
                    raise
                await asyncio.sleep(0)
    return await session.with_transaction(execute, **options)


async def actor_in_family(tx, actor_id, gid, *, owner=False):
    actor = await tx.users.find_one({"id": actor_id})
    if not actor:
        raise HTTPException(401, "Please sign in again.")
    if actor.get("family_group_id") != gid:
        raise HTTPException(409, "Your family changed; reopen this action.")
    if owner:
        group = await tx.family_groups.find_one({"id": gid})
        if not group or group.get("owner_user_id") != actor_id:
            raise HTTPException(403, "Only the current family owner can do this.")
    return actor


async def insert_record(db, collection, document, *, actor_id=None, owner=False):
    """Structural insert with fresh identity and member-family validation."""
    gid = document.get("family_group_id")
    if not gid:
        raise HTTPException(409, "A current family is required.")

    async def action(tx):
        if actor_id:
            await actor_in_family(tx, actor_id, gid, owner=owner)
        member_id = document.get("member_id")
        if member_id:
            member = await tx.members.find_one({"id": member_id, "family_group_id": gid})
            if not member:
                raise HTTPException(409, "The member's family changed; reopen this action.")
            if member.get("user_id"):
                await actor_in_family(tx, member["user_id"], gid)
        # insert_one may add _id; never leak retry-local mutation to the caller.
        return await tx[collection].insert_one(copy.deepcopy(document))

    return await run(db, [gid], action)


async def create_dependent(db, document, actor_id):
    return await insert_record(db, "members", document, actor_id=actor_id, owner=True)


async def insert_background_record(db, collection, document):
    """Skip a stale queued scope explicitly, never send for an uncommitted row.

    Only structural incident creation is fenced; callers' telemetry/state
    machines are deliberately outside this helper.
    """
    try:
        await insert_record(db, collection, document, actor_id=document.get("owner_id") or None)
        return True
    except HTTPException as error:
        if error.status_code not in (401, 409):
            raise
        logging.getLogger(__name__).info(
            "Skipped stale family background insert collection=%s status=%s",
            collection, error.status_code,
        )
        return False


async def persist_sos(db, document, actor_id, *, explicit_member_id=None):
    """Return the committed scope. Delivery belongs strictly after this call.

    A conflict retries against current membership, not a cached authentication
    object. No member selection is silently changed for an explicit subject.
    """
    for _ in range(3):
        candidate = await db.users.find_one({"id": actor_id})
        if not candidate:
            raise HTTPException(401, "Please sign in again.")
        gid = candidate.get("family_group_id")
        if not gid:
            raise HTTPException(409, "Family setup is incomplete.")
        if explicit_member_id and not await db.members.find_one(
            {"id": explicit_member_id, "family_group_id": gid}, {"_id": 1},
        ):
            raise HTTPException(403, "That person is not in your current family.")
        # Ask long transfer transactions to yield; SOS still takes the SAME
        # family fence and revalidates identity/subject inside its 2s transaction.
        await family_sos_priority.announce(db, gid)

        async def action(tx):
            actor = await actor_in_family(tx, actor_id, gid)
            if explicit_member_id and not await tx.members.find_one(
                {"id": explicit_member_id, "family_group_id": gid},
            ):
                raise HTTPException(403, "That person is not in your current family.")
            row = {**copy.deepcopy(document), "family_group_id": gid,
                   "owner_id": actor_id, "member_id": explicit_member_id or actor_id,
                   "sos_subject_kind": "member" if explicit_member_id else "user"}
            if row.get("resolved") is not True:
                row.pop("resolved_at", None)
            await tx.alerts.insert_one(row)
            return row, actor

        try:
            return await run(db, [gid], action)
        except HTTPException as error:
            if error.status_code != 409:
                raise
    raise HTTPException(409, "Your family changed repeatedly; reopen SOS.")


async def change_sos_resolution(db, family_id, alert_id, actor_id, updates, *, include_ordinary=False):
    """Internal persistence boundary; does not introduce a reopen endpoint."""
    if set(updates) - {"resolved", "resolved_at", "resolved_by_user_id",
                       "resolved_by_name", "acknowledged"}:
        raise ValueError("Not a resolution-only mutation")
    if type(updates.get("resolved")) is not bool:
        raise ValueError("An explicit boolean resolution is required")

    async def action(tx):
        await actor_in_family(tx, actor_id, family_id)
        selector = {"id": alert_id, "family_group_id": family_id}
        if not include_ordinary or updates["resolved"] is False:
            selector["type"] = "sos"
        alert = await tx.alerts.find_one(selector, {"_id": 0})
        if not alert:
            raise HTTPException(404, "Alert not found")
        # Departed-owner historical incidents are never reactivated or disclosed.
        if alert.get("type") == "sos" and not await tx.users.find_one(
            {"id": alert.get("owner_id"), "family_group_id": family_id}, {"_id": 1},
        ):
            raise HTTPException(404, "Alert not found")
        if updates["resolved"] is False:
            # Reopening is only an internal owner/subject action, not broad
            # caregiver authority over a retired incident.
            if actor_id != alert["owner_id"]:
                raise HTTPException(403, "Only the current incident owner can reopen it.")
        if alert.get("resolved") is updates["resolved"]:
            return alert, False
        result = await tx.alerts.update_one(
            {**selector, "type": alert.get("type")},
            {"$set": copy.deepcopy(updates)},
        )
        if result.matched_count != 1:
            raise HTTPException(409, "Alert changed.")
        return {**alert, **updates}, True

    return await run(db, [family_id], action)
