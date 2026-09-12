"""Kinnship Medication & Routine Self-Alert Scheduler (v6.3).

Per the v6.3 spec:
  Stage 1 — "due"           at T+0     → ONE self-push to the member's own device
                                           with an "I Took It" action button.
  Stage 2 — "family_alert"  at T+15m   → ONE push to the WHOLE family group
                                           IF the user has not confirmed.
  STOP.  No further reminders for that slot.

Routines (category="routine", e.g. walks, hydration):
  Stage 1 — "due"           at T+0     → ONE self-push only.  No family alert.

Each stage is idempotent thanks to the unique index on
  (reminder_id, slot_time, local_date, stage)
plus an early-suppress check via medication_logs.

Every fired push is ALSO recorded into the `alerts` collection so the Alerts
tab shows a complete history of activity (per user requirement).
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Dict, List, Optional
from uuid import uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from pymongo.errors import DuplicateKeyError

logger = logging.getLogger(__name__)


# ---------- Stages ----------
STAGE_DUE = "due"
STAGE_FAMILY = "family_alert"

# Per v6.3: T+0 self, T+15 family. No remind_30, no 2h escalation.
STAGE_OFFSETS_MIN: Dict[str, int] = {
    STAGE_DUE: 0,
    STAGE_FAMILY: 15,
}

# Per-stage stale cutoff (delta_min upper bound):
#   STAGE_DUE     — fires if delta_min in [0, 10].  Past 10min stale → skip
#                    so adding a med for an earlier-today slot doesn't backfire.
#   STAGE_FAMILY  — fires if delta_min in [15, 75].  Gives a 60-minute window
#                    for the family alert to fire reliably (previous 16-min
#                    global cap was a 1-min sliver and routinely missed by
#                    the 30s scheduler tick — caused Bug 1 in v6.3).
#
# Critical: these are PER-STAGE so the family alert is NOT bound by the
# (smaller) DUE window, fixing the "no family alert ever fired" regression.
STAGE_MAX_STALE_MIN: Dict[str, int] = {
    STAGE_DUE: 10,
    STAGE_FAMILY: 75,
}


def build_occurrence_id(
    reminder_id: str, member_id: str, slot_time: str, local_date: str
) -> str:
    """Return the stable identity for one scheduled medication occurrence.

    Keep the source fields on persisted documents as well as this digest.  The
    length-prefixed form is compact, deterministic, and shared with the
    mobile retry queue (which must be able to derive the same value without a
    cryptographic library).
    """
    return "|".join(
        f"{len(part)}:{part}"
        for part in (
            str(reminder_id),
            str(member_id),
            str(slot_time),
            str(local_date),
        )
    )

# Worker cadence (seconds). Reduced from 30 → 15 to halve the worst-case
# delivery delay for medication reminders (Bug 4 — 5-7min lag complaint).
WORKER_INTERVAL_SECONDS = 15

# Legacy global cutoff — retained as a safety net for "obviously stale" slots
# (e.g. server restart with reminders 6+ hours old).  Per-stage cutoffs are
# checked FIRST and are stricter, so this only catches edge cases.
MAX_STALE_MINUTES = 90

# A worker crash can leave an occurrence claimed before its alert is durable.
# Claims older than this are safe to retry; a live scan always finalizes much
# sooner than this window.
OCCURRENCE_CLAIM_STALE_MINUTES = 5
FAMILY_RECOVERY_HORIZON_MINUTES = 90


# ---------- Helpers ----------
def _user_tz(tz_name: Optional[str]) -> ZoneInfo:
    try:
        return ZoneInfo(tz_name or "UTC")
    except ZoneInfoNotFoundError:
        return ZoneInfo("UTC")


def _parse_hhmm(s: str) -> Optional[int]:
    try:
        h, m = s.split(":")
        h_i, m_i = int(h), int(m)
        if 0 <= h_i <= 23 and 0 <= m_i <= 59:
            return h_i * 60 + m_i
    except Exception:
        return None
    return None


async def ensure_indexes(db) -> None:
    """Create the unique indexes required before the worker may run.

    These are correctness prerequisites, not optional performance indexes:
    swallowing a failure here would allow two scheduler workers to escalate
    one occurrence.  Let the startup caller fail closed.
    """
    await db.med_notifications.create_index(
        [
            ("reminder_id", 1),
            ("slot_time", 1),
            ("local_date", 1),
            ("stage", 1),
        ],
        unique=True,
        name="uniq_reminder_slot_date_stage",
    )
    # Only taken rows participate in this uniqueness constraint.  Legacy
    # marks and rows without occurrence identity remain readable.
    await db.medication_logs.create_index(
        [("occurrence_id", 1)],
        unique=True,
        partialFilterExpression={"status": "taken", "occurrence_id": {"$exists": True}},
        name="uniq_taken_medication_occurrence",
    )
    await db.medication_occurrences.create_index(
        [("occurrence_id", 1)],
        unique=True,
        name="uniq_medication_occurrence_state",
    )
    # A retry after an ambiguous alert write must discover the same durable
    # escalation instead of creating another Missed Med row.
    await db.alerts.create_index(
        [("occurrence_id", 1)],
        unique=True,
        partialFilterExpression={
            "type": "medication_escalation",
            "occurrence_id": {"$exists": True},
        },
        name="uniq_medication_escalation_occurrence",
    )


async def _has_taken_log_after(
    db,
    reminder_id: str,
    member_id: str,
    slot_time: str,
    local_date: str,
) -> bool:
    """Return True iff this exact medication occurrence was marked taken."""
    occurrence_id = build_occurrence_id(
        reminder_id, member_id, slot_time, local_date
    )
    doc = await db.medication_logs.find_one(
        {
            "occurrence_id": occurrence_id,
            "status": "taken",
        }
    )
    return doc is not None


async def _ensure_occurrence_state(
    db,
    *,
    occurrence_id: str,
    reminder_id: str,
    member_id: str,
    slot_time: str,
    local_date: str,
) -> bool:
    """Create the small durable coordination row used by the race guard."""
    collection = getattr(db, "medication_occurrences", None)
    if collection is None:
        return False
    try:
        await collection.insert_one(
            {
                "occurrence_id": occurrence_id,
                "reminder_id": reminder_id,
                "member_id": member_id,
                "slot_time": slot_time,
                "local_date": local_date,
                "acknowledged": False,
                "family_claimed": False,
            }
        )
    except DuplicateKeyError:
        # The other side of the race created the state first.  The following
        # atomic update decides who owns the occurrence.
        pass
    return True


async def _claim_occurrence_for_family(
    db,
    *,
    occurrence_id: str,
    reminder_id: str,
    member_id: str,
    slot_time: str,
    local_date: str,
    now_utc: datetime,
) -> Optional[str]:
    """Atomically claim an occurrence before starting family escalation.

    The acknowledgment endpoint uses the inverse conditional update.  Thus
    exactly one side wins the boundary: a successful acknowledgment or the
    family-stage claim.  A claim remains ``sending`` until the push and alert
    row have been attempted, so an in-flight acknowledgment cannot be
    reported as taken alongside that escalation.
    """
    if not await _ensure_occurrence_state(
        db,
        occurrence_id=occurrence_id,
        reminder_id=reminder_id,
        member_id=member_id,
        slot_time=slot_time,
        local_date=local_date,
    ):
        return None
    collection = db.medication_occurrences
    claim_token = str(uuid4())
    result = await collection.update_one(
        {
            "occurrence_id": occurrence_id,
            "acknowledged": {"$ne": True},
            "family_claimed": {"$ne": True},
        },
        {
            "$set": {
                "family_claimed": True,
                "family_claimed_at": now_utc,
                "family_state": "sending",
                "family_claim_token": claim_token,
                "family_recovery_deadline_at": now_utc + timedelta(
                    minutes=FAMILY_RECOVERY_HORIZON_MINUTES
                ),
            }
        },
    )
    if getattr(result, "matched_count", 0):
        return claim_token
    # Transfer ownership atomically.  family_claimed stays true throughout,
    # so the acknowledgment conditional can never win this handoff.
    stale_query = {
        "occurrence_id": occurrence_id,
        "acknowledged": {"$ne": True},
        "family_claimed": True,
        "family_state": "sending",
        "family_claimed_at": {
            "$lt": now_utc - timedelta(minutes=OCCURRENCE_CLAIM_STALE_MINUTES)
        },
        "family_recovery_deadline_at": {"$gt": now_utc},
    }
    result = await collection.update_one(
        stale_query,
        {
            "$set": {
                "family_claim_token": claim_token,
                "family_claimed_at": now_utc,
            }
        },
    )
    if not getattr(result, "matched_count", 0):
        # Rows created before deadlines were added get one deadline at the
        # moment they are first recovered.  Existing absolute deadlines are
        # never moved by a takeover.
        stale_query.pop("family_recovery_deadline_at")
        stale_query["family_recovery_deadline_at"] = {"$exists": False}
        result = await collection.update_one(
            stale_query,
            {
                "$set": {
                    "family_claim_token": claim_token,
                    "family_claimed_at": now_utc,
                    "family_recovery_deadline_at": now_utc + timedelta(
                        minutes=FAMILY_RECOVERY_HORIZON_MINUTES
                    ),
                }
            },
        )
    return claim_token if getattr(result, "matched_count", 0) else None


async def _finish_occurrence_family_claim(
    db, occurrence_id: str, now_utc: datetime, claim_token: Optional[str] = None
) -> None:
    collection = getattr(db, "medication_occurrences", None)
    if collection is None:
        return
    await collection.update_one(
        {
            "occurrence_id": occurrence_id,
            "family_state": "sending",
            **({"family_claim_token": claim_token} if claim_token else {}),
        },
        {"$set": {"family_state": "sent", "escalation_sent_at": now_utc}},
    )


async def _try_record_stage(
    db,
    *,
    reminder_id: str,
    family_group_id: str,
    member_id: str,
    slot_time: str,
    local_date: str,
    stage: str,
    now_utc: datetime,
    claim_token: Optional[str] = None,
) -> bool:
    """Reserve or reclaim a delivery stage without duplicating a push."""
    row = {
        "reminder_id": reminder_id,
        "family_group_id": family_group_id,
        "member_id": member_id,
        "slot_time": slot_time,
        "local_date": local_date,
        "stage": stage,
        "fired_at": now_utc,
    }
    if stage == STAGE_FAMILY:
        row.update({
            "delivery_state": "sending",
            "delivery_claimed_at": now_utc,
            "delivery_recovery_deadline_at": now_utc + timedelta(
                minutes=FAMILY_RECOVERY_HORIZON_MINUTES
            ),
            "family_claim_token": claim_token,
        })
    try:
        await db.med_notifications.insert_one(row)
        return True
    except DuplicateKeyError:
        if stage != STAGE_FAMILY:
            return False
        query = {
            "reminder_id": reminder_id,
            "member_id": member_id,
            "slot_time": slot_time,
            "local_date": local_date,
            "stage": stage,
        }
        existing = await db.med_notifications.find_one(query, {"_id": 0})
        if not existing or existing.get("delivery_state") == "sent":
            return False
        if existing.get("delivery_attempted_at"):
            return False
        claimed_at = existing.get("delivery_claimed_at") or existing.get("fired_at")
        if not claimed_at or claimed_at >= now_utc - timedelta(
            minutes=OCCURRENCE_CLAIM_STALE_MINUTES
        ):
            return False
        result = await db.med_notifications.update_one(
            {
                **query,
                "delivery_state": "sending",
                "delivery_attempted_at": {"$exists": False},
                "delivery_claimed_at": claimed_at,
            },
            {
                "$set": {
                    "delivery_claimed_at": now_utc,
                    "family_claim_token": claim_token,
                }
            },
        )
        return bool(getattr(result, "matched_count", 0))


async def _mark_stage_attempted(
    db,
    *,
    reminder_id: str,
    member_id: str,
    slot_time: str,
    local_date: str,
    stage: str,
    claim_token: Optional[str],
    now_utc: datetime,
) -> bool:
    """Record the push attempt before calling the non-transactional push API."""
    result = await db.med_notifications.update_one(
        {
            "reminder_id": reminder_id,
            "member_id": member_id,
            "slot_time": slot_time,
            "local_date": local_date,
            "stage": stage,
            "delivery_state": "sending",
            "delivery_attempted_at": {"$exists": False},
            **({"family_claim_token": claim_token} if claim_token else {}),
        },
        {"$set": {"delivery_attempted_at": now_utc}},
    )
    return bool(getattr(result, "matched_count", 0))


async def _finish_family_stage(
    db,
    *,
    reminder_id: str,
    member_id: str,
    slot_time: str,
    local_date: str,
    claim_token: Optional[str],
    now_utc: datetime,
) -> None:
    await db.med_notifications.update_one(
        {
            "reminder_id": reminder_id,
            "member_id": member_id,
            "slot_time": slot_time,
            "local_date": local_date,
            "stage": STAGE_FAMILY,
            "delivery_state": "sending",
            **({"family_claim_token": claim_token} if claim_token else {}),
        },
        {"$set": {"delivery_state": "sent", "delivery_sent_at": now_utc}},
    )


async def _log_alert(
    db,
    *,
    owner_id: Optional[str],
    family_group_id: Optional[str],
    member_id: str,
    member_name: str,
    a_type: str,
    severity: str,
    title: str,
    message: str,
    now_utc: datetime,
    reminder_id: Optional[str] = None,
    medication_name: Optional[str] = None,
    dosage: Optional[str] = None,
    scheduled_time: Optional[str] = None,
    missed_at: Optional[datetime] = None,
    missed_local_date: Optional[str] = None,
    occurrence_id: Optional[str] = None,
    alert_id: Optional[str] = None,
    raise_on_error: bool = False,
) -> None:
    """Insert an alert row so the Alerts tab shows complete history."""
    if not family_group_id:
        return
    try:
        doc = {
            "id": alert_id or str(uuid4()),
            "owner_id": owner_id or "",
            "family_group_id": family_group_id,
            "member_id": member_id,
            "member_name": member_name,
            "type": a_type,
            "severity": severity,
            "title": title,
            "message": message,
            "acknowledged": False,
            "created_at": now_utc,
        }
        if missed_at is not None:
            doc.update({
                "reminder_id": reminder_id,
                "medication_name": medication_name,
                "dosage": dosage,
                "scheduled_time": scheduled_time,
                "missed_at": missed_at,
                "missed_local_date": missed_local_date,
            })
        if occurrence_id:
            doc["occurrence_id"] = occurrence_id
        await db.alerts.insert_one(doc)
    except Exception as e:
        if raise_on_error:
            raise
        logger.warning(f"alert insert failed: {e}")


def build_medication_escalation_alert_id(occurrence_id: str) -> str:
    """Return a deterministic alert ID for one medication occurrence."""
    return f"medication-escalation:{occurrence_id}"


async def _ensure_medication_escalation_alert(
    db,
    *,
    alert_id: str,
    owner_id: Optional[str],
    family_group_id: str,
    member_id: str,
    member_name: str,
    title: str,
    message: str,
    now_utc: datetime,
    reminder_id: str,
    medication_name: Optional[str],
    dosage: Optional[str],
    scheduled_time: str,
    local_date: str,
    occurrence_id: str,
) -> str:
    """Durably get-or-create the exact escalation alert.

    The partial unique occurrence index makes retries converge.  If an insert
    raises after Mongo may have committed it, the follow-up read recognizes
    that same row; no cleanup race or second Missed Med row is needed.
    """
    query = {
        "type": "medication_escalation",
        "occurrence_id": occurrence_id,
    }
    existing = await db.alerts.find_one(query, {"_id": 0})
    if existing:
        return existing.get("id") or alert_id
    doc = {
        "id": alert_id,
        "owner_id": owner_id or "",
        "family_group_id": family_group_id,
        "member_id": member_id,
        "member_name": member_name,
        "type": "medication_escalation",
        "severity": "critical",
        "title": title,
        "message": message,
        "acknowledged": False,
        "created_at": now_utc,
        "reminder_id": reminder_id,
        "medication_name": medication_name,
        "dosage": dosage,
        "scheduled_time": scheduled_time,
        "missed_at": now_utc,
        "missed_local_date": local_date,
        "occurrence_id": occurrence_id,
    }
    try:
        await db.alerts.insert_one(doc)
        return alert_id
    except DuplicateKeyError:
        existing = await db.alerts.find_one(query, {"_id": 0})
        if existing:
            return existing.get("id") or alert_id
        raise
    except Exception:
        # A network/driver error can be ambiguous.  Read once before
        # propagating; if the row exists, it is the committed idempotent
        # result and the caller may safely continue to stage/push it.
        existing = await db.alerts.find_one(query, {"_id": 0})
        if existing:
            return existing.get("id") or alert_id
        raise


def _resolve_slot(now_local: datetime, slot_time: str) -> Optional[Dict[str, Any]]:
    """Resolve a "HH:MM" slot string to today's slot in the user's local tz.

    Returns dict { slot_local, slot_utc, local_date, delta_min } or None
    if the slot string is malformed.  Unlike the legacy implementation this
    does NOT fall back to yesterday's slot — we strictly evaluate the
    CURRENT day's slot so we never re-fire across a day rollover.
    """
    if _parse_hhmm(slot_time) is None:
        return None
    hh, mm = slot_time.split(":")
    slot_local = now_local.replace(hour=int(hh), minute=int(mm), second=0, microsecond=0)
    slot_utc = slot_local.astimezone(timezone.utc)
    now_utc = now_local.astimezone(timezone.utc)
    return {
        "slot_local": slot_local,
        "slot_utc": slot_utc,
        "local_date": slot_local.date().isoformat(),
        "delta_min": (now_utc - slot_utc).total_seconds() / 60.0,
    }


async def _recover_stale_family_deliveries(
    db,
    reminders: List[dict],
    *,
    push_to_family_group: Callable[..., Awaitable[int]],
    now_utc: datetime,
    counters: Dict[str, int],
) -> None:
    """Retry pre-push crashes without reopening the acknowledgment race."""
    reminders_by_id = {rem.get("id"): rem for rem in reminders}
    contexts: Dict[str, dict] = {}
    stage_cursor = db.med_notifications.find(
        {
            "stage": STAGE_FAMILY,
            "delivery_state": "sending",
        },
        {"_id": 0},
    )
    for stage in await stage_cursor.to_list(20000):
        occurrence_id = build_occurrence_id(
            stage["reminder_id"],
            stage["member_id"],
            stage["slot_time"],
            stage["local_date"],
        )
        contexts[occurrence_id] = stage
    state_cursor = db.medication_occurrences.find(
        {
            "family_claimed": True,
            "family_state": "sending",
            "family_claimed_at": {"$exists": True},
        },
        {"_id": 0},
    )
    for state in await state_cursor.to_list(20000):
        contexts.setdefault(state["occurrence_id"], state)

    for occurrence_id, context in contexts.items():
        if context.get("delivery_attempted_at"):
            state = await db.medication_occurrences.find_one(
                {"occurrence_id": occurrence_id}, {"_id": 0}
            )
            await _finish_family_stage(
                db,
                reminder_id=context["reminder_id"],
                member_id=context["member_id"],
                slot_time=context["slot_time"],
                local_date=context["local_date"],
                claim_token=context.get("family_claim_token"),
                now_utc=now_utc,
            )
            if state and state.get("family_state") == "sending":
                await _finish_occurrence_family_claim(
                    db,
                    occurrence_id,
                    now_utc,
                    state.get("family_claim_token"),
                )
            continue
        claimed_at = (
            context.get("delivery_claimed_at")
            or context.get("family_claimed_at")
        )
        if not claimed_at or claimed_at >= now_utc - timedelta(
            minutes=OCCURRENCE_CLAIM_STALE_MINUTES
        ):
            continue
        deadline = (
            context.get("delivery_recovery_deadline_at")
            or context.get("family_recovery_deadline_at")
        )
        if deadline and now_utc > deadline:
            alert = await db.alerts.find_one(
                {
                    "type": "medication_escalation",
                    "occurrence_id": occurrence_id,
                },
                {"_id": 0},
            )
            if alert:
                # An alert is durable escalation state.  Without an attempted
                # stage it remains eligible for a later bounded recovery pass;
                # never release its family exclusivity as an ordinary timeout.
                continue
            await db.medication_occurrences.update_one(
                {
                    "occurrence_id": occurrence_id,
                    "family_claimed": True,
                    "family_state": "sending",
                },
                {"$set": {"family_claimed": False, "family_state": "expired"}},
            )
            continue
        reminder_id = context.get("reminder_id")
        rem = reminders_by_id.get(reminder_id)
        if not rem:
            continue
        member_id = context.get("member_id") or rem.get("member_id")
        member = await db.members.find_one(
            {"id": member_id},
            {"_id": 0, "owner_id": 1, "family_group_id": 1, "name": 1},
        )
        if not member:
            continue
        family_group_id = rem.get("family_group_id") or member.get("family_group_id")
        if not family_group_id:
            continue
        slot_time = context["slot_time"]
        local_date = context["local_date"]
        if await _has_taken_log_after(
            db, rem["id"], member_id, slot_time, local_date
        ):
            continue
        claim_token = await _claim_occurrence_for_family(
            db,
            occurrence_id=occurrence_id,
            reminder_id=rem["id"],
            member_id=member_id,
            slot_time=slot_time,
            local_date=local_date,
            now_utc=now_utc,
        )
        if not claim_token:
            continue
        member_name = member.get("name") or rem.get("member_name") or "your loved one"
        title = f"💊 KINNSHIP ALERT: {member_name} hasn't taken {rem['title']}"
        body = (
            f"{member_name} hasn't confirmed their {rem['title']} after 15 min. "
            "Please check on them."
        )
        alert_id = build_medication_escalation_alert_id(occurrence_id)
        await _ensure_medication_escalation_alert(
            db,
            alert_id=alert_id,
            owner_id=rem.get("owner_id") or member.get("owner_id"),
            family_group_id=family_group_id,
            member_id=member_id,
            member_name=member_name,
            title=title,
            message=body,
            now_utc=now_utc,
            reminder_id=rem["id"],
            medication_name=rem.get("title"),
            dosage=rem.get("dosage"),
            scheduled_time=slot_time,
            local_date=local_date,
            occurrence_id=occurrence_id,
        )
        won = await _try_record_stage(
            db,
            reminder_id=rem["id"],
            family_group_id=family_group_id,
            member_id=member_id,
            slot_time=slot_time,
            local_date=local_date,
            stage=STAGE_FAMILY,
            now_utc=now_utc,
            claim_token=claim_token,
        )
        if not won or not await _mark_stage_attempted(
            db,
            reminder_id=rem["id"],
            member_id=member_id,
            slot_time=slot_time,
            local_date=local_date,
            stage=STAGE_FAMILY,
            claim_token=claim_token,
            now_utc=now_utc,
        ):
            continue
        try:
            await push_to_family_group(
                family_group_id,
                title,
                body,
                {
                    "type": "medication",
                    "subtype": "family_alert",
                    "reminder_id": rem["id"],
                    "member_id": member_id,
                    "member_name": member_name,
                    "stage": STAGE_FAMILY,
                    "slot_time": slot_time,
                    "local_date": local_date,
                    "occurrence_id": occurrence_id,
                    "alert_id": alert_id,
                    "title": rem.get("title"),
                    "dosage": rem.get("dosage"),
                    "channelId": "meds_v2",
                },
                exclude_user_id=None,
            )
        except Exception as e:
            logger.warning(f"recovered family_alert push failed: {e}")
        await _finish_family_stage(
            db,
            reminder_id=rem["id"],
            member_id=member_id,
            slot_time=slot_time,
            local_date=local_date,
            claim_token=claim_token,
            now_utc=now_utc,
        )
        await _finish_occurrence_family_claim(
            db, occurrence_id, now_utc, claim_token
        )
        counters["fired_family_alert"] += 1


# ---------- Core scan ----------
async def process_pending_notifications(
    db,
    *,
    push_to_user: Callable[[str, str, str, Dict[str, Any]], Awaitable[int]],
    push_to_family_group: Callable[..., Awaitable[int]],
    now_utc: Optional[datetime] = None,
) -> Dict[str, int]:
    """Scan reminders and fire any due stage(s).  Idempotent."""
    now_utc = now_utc or datetime.now(timezone.utc)
    counters = {
        "scanned_reminders": 0,
        "fired_due": 0,
        "fired_family_alert": 0,
        "fired_routine_due": 0,
        "skipped_taken": 0,
    }

    # Iterate BOTH medication AND routine reminders.
    cursor = db.reminders.find(
        {"category": {"$in": ["medication", "routine"]}}, {"_id": 0}
    )
    reminders = await cursor.to_list(20000)
    await _recover_stale_family_deliveries(
        db,
        reminders,
        push_to_family_group=push_to_family_group,
        now_utc=now_utc,
        counters=counters,
    )

    for rem in reminders:
        times = rem.get("times") or []
        if not times:
            continue
        counters["scanned_reminders"] += 1
        is_routine = (rem.get("category") == "routine")

        member_id = rem["member_id"]
        member = await db.members.find_one(
            {"id": member_id},
            {"_id": 0, "owner_id": 1, "user_id": 1, "family_group_id": 1, "name": 1},
        )
        if not member:
            continue

        family_group_id = rem.get("family_group_id") or member.get("family_group_id")
        if not family_group_id:
            continue

        member_name = member.get("name") or rem.get("member_name") or "your loved one"

        # Resolve recipient for SELF notification.  Prefer explicit member.user_id
        # (the senior's own account), else the owner who tracks them.
        self_user_id = member.get("user_id") or member.get("owner_id") or rem.get("owner_id")

        # Resolve timezone via the owner user.
        owner_user = await db.users.find_one(
            {"id": member.get("owner_id") or rem.get("owner_id")},
            {"_id": 0, "timezone": 1},
        )
        tz = _user_tz(owner_user.get("timezone") if owner_user else None)
        now_local = now_utc.astimezone(tz)

        for slot in times:
            slot_time = slot.get("time") if isinstance(slot, dict) else None
            if not slot_time:
                continue
            resolved = _resolve_slot(now_local, slot_time)
            if not resolved:
                continue
            delta_min = resolved["delta_min"]
            slot_utc = resolved["slot_utc"]
            local_date = resolved["local_date"]
            occurrence_id = build_occurrence_id(
                rem["id"], member_id, slot_time, local_date
            )

            # Skip future slots and stale slots.
            if delta_min < 0:
                continue
            if delta_min > MAX_STALE_MINUTES:
                continue

            # If the medication was logged as taken since the slot fired,
            # suppress all subsequent stages.
            if not is_routine:
                already_taken = await _has_taken_log_after(
                    db, rem["id"], member_id, slot_time, local_date
                )
                if already_taken:
                    counters["skipped_taken"] += 1
                    continue

            # -------- Stage 1: T+0 self-push --------
            # Per-stage stale gate: only fire DUE if within 10 min of the slot.
            # Past that, the family alert stage takes over without firing the
            # T+0 retroactively (prevents "you should have taken this 30 min
            # ago" pings to the senior).
            if (delta_min >= STAGE_OFFSETS_MIN[STAGE_DUE]
                    and delta_min <= STAGE_MAX_STALE_MIN[STAGE_DUE]):
                won = await _try_record_stage(
                    db,
                    reminder_id=rem["id"],
                    family_group_id=family_group_id,
                    member_id=member_id,
                    slot_time=slot_time,
                    local_date=local_date,
                    stage=STAGE_DUE,
                    now_utc=now_utc,
                )
                if won and self_user_id:
                    if is_routine:
                        title = f"🌿 Time for {rem['title']}"
                        body = (
                            (rem.get("dosage") + "\n\nTap ✅ DONE when complete.")
                            if rem.get("dosage")
                            else f"It's time for your {rem['title']}.\n\nTap ✅ DONE below when complete."
                        )
                        data_type = "routine"
                        cat_id = "ROUTINE_DUE"
                        a_type = "routine"
                        sev = "info"
                    else:
                        title = f"💊 Time to take your {rem['title']}"
                        body = (
                            (rem.get("dosage") + "\n\nTap ✅ TOOK IT below when done, or ⏰ SNOOZE for 10 minutes.")
                            if rem.get("dosage")
                            else f"It's time for your {rem['title']}.\n\nTap ✅ TOOK IT below when done, or ⏰ SNOOZE for 10 minutes."
                        )
                        data_type = "medication"
                        cat_id = "MEDICATION_DUE"
                        a_type = "medication"
                        sev = "info"
                    try:
                        await push_to_user(
                            self_user_id,
                            title,
                            body,
                            {
                                "type": data_type,
                                "subtype": "self_due",
                                "reminder_id": rem["id"],
                                "member_id": member_id,
                                "member_name": member_name,
                                "stage": STAGE_DUE,
                                "slot_time": slot_time,
                                "local_date": local_date,
                                "occurrence_id": occurrence_id,
                                "title": rem.get("title"),
                                "dosage": rem.get("dosage"),
                                "categoryIdentifier": cat_id,
                                "channelId": "meds_v2" if not is_routine else "routines",
                            },
                        )
                    except Exception as e:
                        logger.warning(f"stage_due push failed: {e}")
                    # Log to alerts feed.
                    await _log_alert(
                        db,
                        owner_id=rem.get("owner_id"),
                        family_group_id=family_group_id,
                        member_id=member_id,
                        member_name=member_name,
                        a_type=a_type,
                        severity=sev,
                        title=title,
                        message=f"Reminder sent at {slot_time} local.",
                        now_utc=now_utc,
                    )
                    if is_routine:
                        counters["fired_routine_due"] += 1
                    else:
                        counters["fired_due"] += 1

            # -------- Stage 2: T+15m family alert (medication only) --------
            if is_routine:
                continue
            # Per-stage stale gate: fire family alert if delta_min in
            # [15, 75].  CRITICAL: previously bound by the 16-min global cap
            # which gave a 1-minute window that the 30s tick routinely
            # missed (Bug 1 in v6.3 — "no family alert ever").  Now 60-min
            # window guarantees the alert fires even if the scheduler tick
            # lands a bit late or the server briefly stalled.
            if (delta_min >= STAGE_OFFSETS_MIN[STAGE_FAMILY]
                    and delta_min <= STAGE_MAX_STALE_MIN[STAGE_FAMILY]):
                # Claim the exact occurrence before reserving/sending the
                # escalation.  The acknowledgment endpoint performs the
                # competing conditional update, which closes the T+15 race.
                claim_token = await _claim_occurrence_for_family(
                    db,
                    occurrence_id=occurrence_id,
                    reminder_id=rem["id"],
                    member_id=member_id,
                    slot_time=slot_time,
                    local_date=local_date,
                    now_utc=now_utc,
                )
                if not claim_token:
                    counters["skipped_taken"] += 1
                    continue
                title = f"💊 KINNSHIP ALERT: {member_name} hasn't taken {rem['title']}"
                body = (
                    f"{member_name} hasn't confirmed their {rem['title']} after 15 min. "
                    "Please check on them."
                )
                alert_id = build_medication_escalation_alert_id(occurrence_id)
                # Alert durability precedes stage reservation and push.  If
                # the driver reports an ambiguous insert, this helper reads
                # back the unique occurrence row and reuses its exact ID.
                await _ensure_medication_escalation_alert(
                    db,
                    alert_id=alert_id,
                    owner_id=rem.get("owner_id"),
                    family_group_id=family_group_id,
                    member_id=member_id,
                    member_name=member_name,
                    title=title,
                    message=body,
                    now_utc=now_utc,
                    reminder_id=rem["id"],
                    medication_name=rem.get("title"),
                    dosage=rem.get("dosage"),
                    scheduled_time=slot_time,
                    local_date=local_date,
                    occurrence_id=occurrence_id,
                )
                won = await _try_record_stage(
                    db,
                    reminder_id=rem["id"],
                    family_group_id=family_group_id,
                    member_id=member_id,
                    slot_time=slot_time,
                    local_date=local_date,
                    stage=STAGE_FAMILY,
                    now_utc=now_utc,
                    claim_token=claim_token,
                )
                if won:
                    if not await _mark_stage_attempted(
                        db,
                        reminder_id=rem["id"],
                        member_id=member_id,
                        slot_time=slot_time,
                        local_date=local_date,
                        stage=STAGE_FAMILY,
                        claim_token=claim_token,
                        now_utc=now_utc,
                    ):
                        continue
                    try:
                        await push_to_family_group(
                            family_group_id,
                            title,
                            body,
                            {
                                "type": "medication",
                                "subtype": "family_alert",
                                "reminder_id": rem["id"],
                                "member_id": member_id,
                                "member_name": member_name,
                                "stage": STAGE_FAMILY,
                                "slot_time": slot_time,
                                "local_date": local_date,
                                "occurrence_id": occurrence_id,
                                "alert_id": alert_id,
                                "title": rem.get("title"),
                                "dosage": rem.get("dosage"),
                                "channelId": "meds_v2",
                            },
                            exclude_user_id=None,
                        )
                    except Exception as e:
                        logger.warning(f"family_alert push failed: {e}")
                    counters["fired_family_alert"] += 1
                    await _finish_family_stage(
                        db,
                        reminder_id=rem["id"],
                        member_id=member_id,
                        slot_time=slot_time,
                        local_date=local_date,
                        claim_token=claim_token,
                        now_utc=now_utc,
                    )
                    await _finish_occurrence_family_claim(
                        db, occurrence_id, now_utc, claim_token
                    )
                else:
                    # Another worker owns the unique stage row and is
                    # responsible for the already-durable alert/push.
                    await _finish_occurrence_family_claim(
                        db, occurrence_id, now_utc, claim_token
                    )

    return counters


class MedicationScheduler:
    """Persistent background task wrapper."""

    def __init__(self, db, push_to_user, push_to_family_group):
        self.db = db
        self.push_to_user = push_to_user
        self.push_to_family_group = push_to_family_group
        self._task: Optional[asyncio.Task] = None
        self._stop_event = asyncio.Event()

    async def _loop(self) -> None:
        logger.info("Medication scheduler loop started.")
        while not self._stop_event.is_set():
            try:
                counters = await process_pending_notifications(
                    self.db,
                    push_to_user=self.push_to_user,
                    push_to_family_group=self.push_to_family_group,
                )
                fired_total = (
                    counters["fired_due"]
                    + counters["fired_family_alert"]
                    + counters["fired_routine_due"]
                )
                if fired_total > 0:
                    logger.info(f"Medication scheduler tick → {counters}")
            except Exception as e:
                logger.warning(f"Medication scheduler tick failed: {e}")
            try:
                await asyncio.wait_for(
                    self._stop_event.wait(), timeout=WORKER_INTERVAL_SECONDS
                )
            except asyncio.TimeoutError:
                pass
        logger.info("Medication scheduler loop stopped.")

    def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._stop_event.clear()
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        self._stop_event.set()
        if self._task:
            try:
                await asyncio.wait_for(self._task, timeout=5)
            except Exception:
                pass
