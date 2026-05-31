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

logger = logging.getLogger(__name__)


# ---------- Stages ----------
STAGE_DUE = "due"
STAGE_FAMILY = "family_alert"
STAGE_REFILL = "refill"

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

# Worker cadence (seconds). Reduced from 30 → 15 to halve the worst-case
# delivery delay for medication reminders (Bug 4 — 5-7min lag complaint).
WORKER_INTERVAL_SECONDS = 15

# Legacy global cutoff — retained as a safety net for "obviously stale" slots
# (e.g. server restart with reminders 6+ hours old).  Per-stage cutoffs are
# checked FIRST and are stricter, so this only catches edge cases.
MAX_STALE_MINUTES = 90


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
    """Create the unique indexes used to make stage firing idempotent."""
    try:
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
    except Exception as e:
        logger.warning(f"med_notifications index ensure skipped: {e}")
    try:
        await db.refill_notifications.create_index(
            [("reminder_id", 1), ("last_refill_at", 1)],
            unique=True,
            name="uniq_reminder_refill_cycle",
        )
    except Exception as e:
        logger.warning(f"refill_notifications index ensure skipped: {e}")


async def _has_taken_log_after(db, reminder_id: str, slot_utc: datetime) -> bool:
    """Return True iff the medication was marked taken for this dose window."""
    doc = await db.medication_logs.find_one(
        {
            "reminder_id": reminder_id,
            "status": "taken",
            "marked_at": {"$gte": slot_utc},
        }
    )
    return doc is not None


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
) -> bool:
    """Atomically reserve a stage. Returns True if we won the race."""
    try:
        await db.med_notifications.insert_one(
            {
                "reminder_id": reminder_id,
                "family_group_id": family_group_id,
                "member_id": member_id,
                "slot_time": slot_time,
                "local_date": local_date,
                "stage": stage,
                "fired_at": now_utc,
            }
        )
        return True
    except Exception:
        return False


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
) -> None:
    """Insert an alert row so the Alerts tab shows complete history."""
    if not family_group_id:
        return
    try:
        await db.alerts.insert_one(
            {
                "id": str(uuid4()),
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
        )
    except Exception as e:
        logger.warning(f"alert insert failed: {e}")


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

            # Skip future slots and stale slots.
            if delta_min < 0:
                continue
            if delta_min > MAX_STALE_MINUTES:
                continue

            # If the medication was logged as taken since the slot fired,
            # suppress all subsequent stages.
            if not is_routine:
                already_taken = await _has_taken_log_after(db, rem["id"], slot_utc)
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
                                "stage": STAGE_DUE,
                                "slot_time": slot_time,
                                "title": rem.get("title"),
                                "categoryIdentifier": cat_id,
                                "channelId": "meds" if not is_routine else "routines",
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
                won = await _try_record_stage(
                    db,
                    reminder_id=rem["id"],
                    family_group_id=family_group_id,
                    member_id=member_id,
                    slot_time=slot_time,
                    local_date=local_date,
                    stage=STAGE_FAMILY,
                    now_utc=now_utc,
                )
                if won:
                    title = f"💊 KINNSHIP ALERT: {member_name} hasn't taken {rem['title']}"
                    body = (
                        f"{member_name} hasn't confirmed their {rem['title']} after 15 min. "
                        "Please check on them."
                    )
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
                                "stage": STAGE_FAMILY,
                                "slot_time": slot_time,
                                "channelId": "meds",
                            },
                            exclude_user_id=None,
                        )
                    except Exception as e:
                        logger.warning(f"family_alert push failed: {e}")
                    await _log_alert(
                        db,
                        owner_id=rem.get("owner_id"),
                        family_group_id=family_group_id,
                        member_id=member_id,
                        member_name=member_name,
                        a_type="medication_escalation",
                        severity="critical",
                        title=title,
                        message=body,
                        now_utc=now_utc,
                    )
                    counters["fired_family_alert"] += 1

    return counters


# ---------- Refill notifications ----------
async def process_refill_notifications(
    db,
    *,
    push_to_user: Callable[[str, str, str, Dict[str, Any]], Awaitable[int]],
    now_utc: Optional[datetime] = None,
) -> Dict[str, int]:
    """Fire ONE refill push per refill cycle when within `refill_reminder_days`
    of run-out.  Idempotent via the `refill_notifications` unique index.
    """
    now_utc = now_utc or datetime.now(timezone.utc)
    counters = {"scanned_refill": 0, "fired_refill": 0}

    cursor = db.reminders.find(
        {
            "category": "medication",
            "days_supply": {"$gt": 0},
            "run_out_at": {"$ne": None},
        },
        {"_id": 0},
    )
    reminders = await cursor.to_list(20000)

    for rem in reminders:
        counters["scanned_refill"] += 1
        run_out_at = rem.get("run_out_at")
        last_refill_at = rem.get("last_refill_at")
        lead = rem.get("refill_reminder_days") or 7

        if not run_out_at or not last_refill_at:
            continue
        if isinstance(run_out_at, str):
            try:
                run_out_at = datetime.fromisoformat(run_out_at.replace("Z", "+00:00"))
            except Exception:
                continue
        if isinstance(last_refill_at, str):
            try:
                last_refill_at = datetime.fromisoformat(last_refill_at.replace("Z", "+00:00"))
            except Exception:
                continue
        if run_out_at.tzinfo is None:
            run_out_at = run_out_at.replace(tzinfo=timezone.utc)
        if last_refill_at.tzinfo is None:
            last_refill_at = last_refill_at.replace(tzinfo=timezone.utc)

        days_until_runout = (run_out_at - now_utc).total_seconds() / 86400.0
        if days_until_runout > lead:
            continue

        try:
            await db.refill_notifications.insert_one(
                {
                    "reminder_id": rem["id"],
                    "last_refill_at": last_refill_at,
                    "family_group_id": rem.get("family_group_id"),
                    "member_id": rem.get("member_id"),
                    "fired_at": now_utc,
                    "days_until_runout_at_fire": round(days_until_runout, 2),
                }
            )
        except Exception:
            continue

        owner_user_id = rem.get("owner_id")
        if not owner_user_id:
            counters["fired_refill"] += 1
            continue

        member_name = rem.get("member_name") or "your loved one"
        med_title = rem.get("title") or "medication"
        days_left = max(0, int(round(days_until_runout)))
        days_phrase = (
            "today" if days_left == 0
            else (f"in {days_left} day" + ("s" if days_left != 1 else ""))
        )

        try:
            await push_to_user(
                owner_user_id,
                f"💊 {member_name}'s {med_title} may be running low",
                f"Time to refill — supply runs out {days_phrase}.",
                {
                    "type": "medication",
                    "subtype": "refill",
                    "reminder_id": rem["id"],
                    "member_id": rem.get("member_id"),
                    "stage": STAGE_REFILL,
                    "days_until_runout": days_left,
                    "channelId": "meds",
                },
            )
        except Exception as e:
            logger.warning(f"refill push failed: {e}")

        await _log_alert(
            db,
            owner_id=owner_user_id,
            family_group_id=rem.get("family_group_id"),
            member_id=rem.get("member_id"),
            member_name=member_name,
            a_type="medication_refill",
            severity="warning",
            title=f"Refill {member_name}'s {med_title}",
            message=(
                f"{member_name}'s {med_title} may be running low — "
                f"time to refill (supply runs out {days_phrase})."
            ),
            now_utc=now_utc,
        )

        counters["fired_refill"] += 1

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
                refill_counters = await process_refill_notifications(
                    self.db,
                    push_to_user=self.push_to_user,
                )
                fired_total = (
                    counters["fired_due"]
                    + counters["fired_family_alert"]
                    + counters["fired_routine_due"]
                    + refill_counters["fired_refill"]
                )
                if fired_total > 0:
                    logger.info(
                        f"Medication scheduler tick → {counters} + {refill_counters}"
                    )
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
