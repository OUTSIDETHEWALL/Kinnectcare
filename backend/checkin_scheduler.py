"""Durable missed-check-in detection, independent of client reads.

Family-fenced alert/outbox creation and per-device conditional send ownership
coordinate replicas. External sends never run in a retryable transaction.
An uncertain send is terminal unknown, not evidence of delivery or permission
to duplicate it. Confirmed provider rejection is safely retryable.
"""
import asyncio
import hashlib
import logging
from datetime import datetime, timedelta, timezone
from uuid import uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pymongo.errors import DuplicateKeyError
from fastapi import HTTPException
import family_write_fence as fw

logger = logging.getLogger(__name__)
INTERVALS = {2, 4, 6, 8, 12}
CADENCE_SECONDS = 60
GRACE = timedelta(minutes=15)
NEW_MEMBER_GRACE = timedelta(hours=24)
SEND_TIMEOUT_SECONDS = 20


def as_utc(value):
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    if not isinstance(value, datetime):
        return None
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def fingerprint(token):
    return hashlib.sha256(token.encode()).hexdigest()


def candidate(member, patient, now):
    """Latest matured window only, using current settings and patient timezone."""
    created = as_utc(member.get("created_at"))
    if created and now < created + NEW_MEMBER_GRACE:
        return None
    effective = as_utc(member.get("checkin_settings_effective_at")) or created
    interval = member.get("checkin_interval_hours")
    if interval in INTERVALS:
        anchor = as_utc(member.get("checkin_interval_started_at"))
        if anchor is None:
            return None
        window = timedelta(hours=interval)
        count = (now - anchor - GRACE) // window
        if count < 1:
            return None
        due = anchor + count * window
        if effective and due < effective:
            return None
        return {
            "slot_key": f"interval_{due.replace(microsecond=0).isoformat()}",
            "start": due - window, "due": due,
            "settings": [interval, anchor.isoformat(), member.get("checkin_settings_generation", 0)],
            "label": f"every {interval} hours",
            "message": (
                f"Expected every {interval} hours. The most recent {interval}-hour "
                "window has passed without a check-in."
            ),
        }
    fixed = member.get("daily_checkin_time")
    if not isinstance(fixed, str):
        return None
    try:
        hour, minute = map(int, fixed.split(":"))
        if not (0 <= hour < 24 and 0 <= minute < 60):
            return None
        tz = ZoneInfo(patient.get("timezone") or "UTC")
    except (ValueError, ZoneInfoNotFoundError):
        return None
    local = now.astimezone(tz)
    due_local = local.replace(hour=hour, minute=minute, second=0, microsecond=0, fold=0)
    if now < due_local.astimezone(timezone.utc) + GRACE:
        due_local -= timedelta(days=1)
    if effective and due_local.astimezone(timezone.utc) < effective:
        return None
    day_start = due_local.replace(hour=0, minute=0, second=0, microsecond=0, fold=0)
    return {
        "slot_key": f"fixed_{due_local.date().isoformat()}_{fixed}",
        "start": day_start.astimezone(timezone.utc),
        "due": due_local.astimezone(timezone.utc),
        "settings": [fixed, patient.get("timezone") or "UTC", member.get("checkin_settings_generation", 0)],
        "label": f"by {fixed}",
        "message": f"Expected by {fixed} ({tz.key}) on {due_local.date().isoformat()}. They haven't checked in yet.",
    }


async def ensure_indexes(db):
    # Existing alert identity is shared with the read-triggered compatibility
    # path. Index failure must prevent this worker, not degrade to duplicates.
    await db.alerts.create_index(
        [("family_group_id", 1), ("member_id", 1), ("type", 1), ("slot_key", 1)],
        unique=True, partialFilterExpression={"slot_key": {"$exists": True}},
        name="uniq_alert_slot",
    )
    await db.checkin_deliveries.create_index(
        [("state", 1), ("retry_at", 1)], name="checkin_delivery_ready",
    )
    await db.checkins.create_index(
        [("family_group_id", 1), ("member_id", 1), ("created_at", 1)],
        name="checkin_schedule_evidence",
    )


async def update_settings(db, member_id, current, payload, now):
    """Every schedule writer shares delivery's family fence and revision."""
    gid = current["family_group_id"]

    async def update(tx):
        await fw.actor_in_family(tx, current["id"], gid)
        member = await tx.members.find_one({"id": member_id, "family_group_id": gid})
        if not member:
            raise HTTPException(404, "Member not found")
        if member.get("user_id") != current["id"]:
            await fw.actor_in_family(tx, current["id"], gid, owner=True)
        return await tx.members.update_one(
            {"id": member_id, "family_group_id": gid},
            {"$set": {**payload, "checkin_settings_effective_at": now},
             "$inc": {"checkin_settings_generation": 1}},
        )

    return await fw.run(db, [gid], update)


async def context(tx, member_id, gid, now):
    member = await tx.members.find_one({"id": member_id, "family_group_id": gid})
    if not member:
        return None
    owner = await tx.users.find_one({"id": member.get("owner_id"), "family_group_id": gid})
    if not owner:
        return None
    patient = owner
    if member.get("user_id"):
        patient = await tx.users.find_one({"id": member["user_id"], "family_group_id": gid})
        if not patient:
            return None
    window = candidate(member, patient, now)
    if not window:
        return None
    # Any saved completion since the start suppresses a now-obsolete warning,
    # preserving the existing behavior for late completion as well as on-time.
    completed = await tx.checkins.find_one({
        "family_group_id": gid, "member_id": member_id,
        "created_at": {"$gte": window["start"]},
    })
    return None if completed else (member, window)


async def record_member(db, member_id, gid, now):
    async def record(tx):
        current = await context(tx, member_id, gid, now)
        if current is None:
            return 0
        member, window = current
        selector = {
            "family_group_id": gid, "member_id": member_id,
            "type": "missed_checkin", "slot_key": window["slot_key"],
        }
        if await tx.alerts.find_one(selector):
            # Legacy rows may already have been pushed. Never replay them.
            return 0
        alert_id = str(uuid4())
        title = f"{member['name']} missed {'scheduled' if member.get('checkin_interval_hours') else 'daily'} check-in"
        await tx.alerts.insert_one({
            **selector, "id": alert_id, "owner_id": member["owner_id"],
            "member_name": member["name"], "severity": "critical",
            "title": title, "message": window["message"],
            "acknowledged": False, "resolved": False, "created_at": now,
        })
        # No location is copied to either the alert or its delivery record.
        recipients = await tx.users.find({"family_group_id": gid}, {"_id": 0}).to_list(200)
        seen_tokens = set()
        for user in recipients:
            for token in set(user.get("push_tokens") or []):
                digest = fingerprint(token)
                if digest in seen_tokens:
                    continue
                seen_tokens.add(digest)
                await tx.checkin_deliveries.insert_one({
                    "_id": f"{alert_id}:{user['id']}:{digest}",
                    "alert_id": alert_id, "family_group_id": gid, "member_id": member_id,
                    "user_id": user["id"], "token_hash": digest,
                    "slot_key": window["slot_key"], "settings": window["settings"],
                    "state": "pending", "retry_at": now, "attempts": 0,
                })
        await tx.members.update_one(
            {"id": member_id, "family_group_id": gid}, {"$set": {"status": "warning"}},
        )
        return 1

    try:
        return await fw.run(db, [gid], record)
    except DuplicateKeyError:
        return 0


async def deliver_one(db, row, *, now, send, quiet):
    gid = row["family_group_id"]
    attempt_id = str(uuid4())

    async def reserve(tx):
        saved = await tx.checkin_deliveries.find_one({"_id": row["_id"]})
        if not saved or saved.get("state") != "pending" or as_utc(saved["retry_at"]) > now:
            return None
        current = await context(tx, row["member_id"], gid, now)
        user = await tx.users.find_one({"id": row["user_id"], "family_group_id": gid})
        alert = await tx.alerts.find_one({
            "id": row["alert_id"], "family_group_id": gid, "acknowledged": {"$ne": True},
            "resolved": {"$ne": True},
        })
        cancelled = (
            not current or not user or not alert
            or current[1]["slot_key"] != row["slot_key"]
            or current[1]["settings"] != row["settings"]
        )
        tokens = [] if not user else [
            token for token in user.get("push_tokens", [])
            if fingerprint(token) == row["token_hash"]
        ]
        if cancelled or not tokens or quiet(user):
            await tx.checkin_deliveries.update_one(
                {"_id": row["_id"], "state": "pending"},
                {"$set": {"state": "suppressed", "completed_at": now}},
            )
            return None
        won = await tx.checkin_deliveries.update_one(
            {"_id": row["_id"], "state": "pending", "retry_at": {"$lte": now}},
            {"$set": {"state": "sending", "attempt_id": attempt_id, "attempted_at": now},
             "$inc": {"attempts": 1}},
        )
        if not won.modified_count:
            return None
        member, window = current
        return tokens[0], f"⚠️ {member['name']} missed check-in", (
            f"Expected {window['label']}. Tap to call or check on them."
        )

    try:
        reserved = await fw.run(db, [gid], reserve)
    except HTTPException as error:
        if error.status_code not in (401, 403, 409):
            raise
        await db.checkin_deliveries.update_one(
            {"_id": row["_id"], "state": "pending"},
            {"$set": {"state": "suppressed", "completed_at": now}},
        )
        return
    if reserved is None:
        return
    token, title, body = reserved
    data = {
        "type": "missed_checkin", "member_id": row["member_id"], "alert_id": row["alert_id"],
        "_source_tag": "family:missed_checkin",
    }
    try:
        async with asyncio.timeout(SEND_TIMEOUT_SECONDS):
            import deletion_delivery as dd
            result = await dd.run(
                db, lambda: send([token], title, body, data),
                user_ids=[row["user_id"]], data=data,
                suppressed={"transport_status": "no_valid_tokens"},
                operation_key=f"checkin:{row['_id']}",
            )
    except Exception as error:
        logger.warning("Missed check-in send uncertain: %s", type(error).__name__)
        result = {}
    state = "unknown"
    ticket_id = None
    tickets = result.get("tickets") or []
    if result.get("transport_status") == "response_received" and len(tickets) == 1:
        ticket = tickets[0]
        if ticket.get("status") == "ok" and ticket.get("ticket_id"):
            state, ticket_id = "accepted", ticket["ticket_id"]
        elif ticket.get("status") == "error":
            state = "pending" if ticket.get("error") == "MessageRateExceeded" else "failed"
    elif result.get("transport_status") == "http_error" and result.get("http_status") == 429:
        state = "pending"  # Explicit rejection, not uncertain acceptance.
    elif result.get("transport_status") in ("no_valid_tokens", "blank_push_dropped"):
        state = "failed"
    await db.checkin_deliveries.update_one(
        {"_id": row["_id"], "state": "sending", "attempt_id": attempt_id},
        {"$set": {
            "state": state, "retry_at": now + timedelta(seconds=CADENCE_SECONDS),
            "ticket_id": ticket_id, "completed_at": now if state != "pending" else None,
        }},
    )


async def process_family(db, gid, now=None):
    now = now or datetime.now(timezone.utc)
    count = 0
    async for member in db.members.find({
        "family_group_id": gid,
        "$or": [{"daily_checkin_time": {"$type": "string"}},
                {"checkin_interval_hours": {"$in": sorted(INTERVALS)}}],
    }, {"id": 1}).batch_size(100):
        count += await record_member(db, member["id"], gid, now)
    return count


async def process_pending(db, *, send, quiet, now=None):
    fixed_now = now
    now = now or datetime.now(timezone.utc)
    # One current window per configured member; never enumerate historic days.
    async for member in db.members.find({
        "$or": [{"daily_checkin_time": {"$type": "string"}},
                {"checkin_interval_hours": {"$in": sorted(INTERVALS)}}],
    }, {"id": 1, "family_group_id": 1}).batch_size(100):
        if member.get("family_group_id"):
            try:
                await record_member(
                    db, member["id"], member["family_group_id"],
                    fixed_now or datetime.now(timezone.utc),
                )
            except Exception as error:
                logger.warning("Missed check-in detection deferred: %s", type(error).__name__)
    # A crash after ownership crossed the external boundary is ambiguous.
    # No automatic takeover may resend it, even if no result was persisted.
    await db.checkin_deliveries.update_many(
        {"state": "sending", "attempted_at": {"$lt": now - timedelta(minutes=2)}},
        {"$set": {"state": "unknown", "completed_at": now}},
    )
    rows = await db.checkin_deliveries.find(
        {"state": "pending", "retry_at": {"$lte": now}},
    ).sort("retry_at", 1).limit(500).to_list(500)
    for row in rows:
        try:
            await deliver_one(
                db, row, now=fixed_now or datetime.now(timezone.utc), send=send, quiet=quiet,
            )
        except Exception as error:
            logger.warning("Missed check-in delivery deferred: %s", type(error).__name__)
            await db.checkin_deliveries.update_one(
                {"_id": row["_id"], "state": "pending"},
                {"$set": {"retry_at": now + timedelta(seconds=CADENCE_SECONDS)}},
            )


class CheckinScheduler:
    """Same in-process asyncio scheduling pattern as the medication worker."""
    def __init__(self, db, *, send, quiet):
        self.db, self.send, self.quiet = db, send, quiet
        self.task = None
        self.stop_event = asyncio.Event()

    async def _loop(self):
        while not self.stop_event.is_set():
            try:
                await process_pending(self.db, send=self.send, quiet=self.quiet)
            except Exception as error:
                logger.error("Missed check-in worker failed: %s", type(error).__name__)
            try:
                await asyncio.wait_for(self.stop_event.wait(), CADENCE_SECONDS)
            except asyncio.TimeoutError:
                pass

    def start(self):
        if self.task is None or self.task.done():
            self.stop_event.clear()
            self.task = asyncio.create_task(self._loop())

    async def stop(self):
        self.stop_event.set()
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass
