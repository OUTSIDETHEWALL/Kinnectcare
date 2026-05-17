"""Kinnship Medication Self-Alert Scheduler.

Runs a lightweight background task that scans medication reminders and fires
push notifications in three stages per scheduled dose:

  Stage 1 — "due"           at T+0     → self-push to the member's own device
  Stage 2 — "remind_30"     at T+30m   → gentle self-reminder to the same device
  Stage 3 — "escalate_2h"   at T+2h    → push to the WHOLE family group

Each stage:
  * fires at most once per (reminder_id, slot_time, local_date) thanks to a
    unique index on `med_notifications`
  * is skipped automatically if the member has already logged the medication
    as `taken` for the slot (we look at medication_logs from slot time onwards)
  * the 2-hour family escalation only happens for members who have ≥1
    medication reminder on their profile (which is naturally satisfied since
    we only iterate medication-category reminders).

The scheduler is intentionally idempotent: scanning the same window many times
will never duplicate notifications.  This also means we can expose a manual
`/api/medications/_tick` endpoint for testing without any risk of double-send.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Dict, List, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

logger = logging.getLogger(__name__)


# ---------- Constants ----------
STAGE_DUE = "due"
STAGE_REMIND_30 = "remind_30"
STAGE_ESCALATE_2H = "escalate_2h"

STAGE_OFFSETS_MIN: Dict[str, int] = {
    STAGE_DUE: 0,
    STAGE_REMIND_30: 30,
    STAGE_ESCALATE_2H: 120,
}

# Worker cadence (seconds). Production runs every 30s; tests force-call tick().
WORKER_INTERVAL_SECONDS = 30

# Maximum age of a missed window we'll still fire (to recover from outages).
# Anything past this is considered stale and silently skipped.
MAX_STALE_MINUTES = 60 * 24  # 24h


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
    """Create the unique index used to make stage firing idempotent."""
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
    """Atomically reserve a stage. Returns True if we won the race, False if
    another worker already fired this exact (reminder, slot, date, stage).
    """
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
        # Likely a duplicate-key error from the unique index — meaning we
        # already fired this notification. That's the entire point.
        return False


# ---------- Core scan ----------
async def process_pending_notifications(
    db,
    *,
    push_to_user: Callable[[str, str, str, Dict[str, Any]], Awaitable[int]],
    push_to_family_group: Callable[..., Awaitable[int]],
    now_utc: Optional[datetime] = None,
) -> Dict[str, int]:
    """Run one scan over medication reminders and fire any due stage(s).

    Args:
        db: motor database
        push_to_user: async callable(user_id, title, body, data) -> #devices
        push_to_family_group: async callable(family_group_id, title, body,
            data, exclude_user_id=None) -> #devices
        now_utc: optional override for "now" (testing/replay). Defaults to
            real UTC now.

    Returns a counters dict for observability:
        {
            "scanned_reminders": int,
            "fired_due": int,
            "fired_remind_30": int,
            "fired_escalate_2h": int,
            "skipped_taken": int,
        }
    """
    now_utc = now_utc or datetime.now(timezone.utc)
    counters = {
        "scanned_reminders": 0,
        "fired_due": 0,
        "fired_remind_30": 0,
        "fired_escalate_2h": 0,
        "skipped_taken": 0,
    }

    # Iterate medication reminders (only — routines do NOT escalate).
    cursor = db.reminders.find({"category": "medication"}, {"_id": 0})
    reminders = await cursor.to_list(20000)

    for rem in reminders:
        times = rem.get("times") or []
        if not times:
            continue
        counters["scanned_reminders"] += 1

        member_id = rem["member_id"]
        member = await db.members.find_one(
            {"id": member_id}, {"_id": 0, "owner_id": 1, "user_id": 1, "family_group_id": 1, "name": 1}
        )
        if not member:
            continue

        family_group_id = rem.get("family_group_id") or member.get("family_group_id")
        if not family_group_id:
            continue

        # Resolve the user account who receives the SELF notification.
        # Prefer an explicit member.user_id link; otherwise fall back to the
        # account that owns the member profile.
        self_user_id = member.get("user_id") or member.get("owner_id") or rem.get("owner_id")

        # Resolve timezone via the user who owns the member profile, since the
        # senior may not have their own user account yet.
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
            if _parse_hhmm(slot_time) is None:
                continue

            hh, mm = slot_time.split(":")
            slot_local_today = now_local.replace(
                hour=int(hh), minute=int(mm), second=0, microsecond=0
            )
            # If today's slot hasn't happened yet, fall back to yesterday's
            # occurrence — that way the 2-hour escalation can still fire
            # across a day rollover.
            if slot_local_today > now_local:
                slot_local = slot_local_today - timedelta(days=1)
            else:
                slot_local = slot_local_today
            slot_utc = slot_local.astimezone(timezone.utc)
            local_date = slot_local.date().isoformat()
            delta_min = (now_utc - slot_utc).total_seconds() / 60.0

            # Future slot — nothing to do yet.
            if delta_min < 0:
                continue
            # Too stale (e.g. backfill on a long-stopped server) — skip silently.
            if delta_min > MAX_STALE_MINUTES:
                continue

            # If the senior already took this dose, every stage is suppressed.
            already_taken = await _has_taken_log_after(db, rem["id"], slot_utc)
            if already_taken:
                counters["skipped_taken"] += 1
                continue

            # Stage 1: due (T+0)
            if delta_min >= STAGE_OFFSETS_MIN[STAGE_DUE]:
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
                    try:
                        await push_to_user(
                            self_user_id,
                            f"💊 Time to take your {rem['title']}",
                            (rem.get("dosage") + " — tap to mark as taken.") if rem.get("dosage")
                            else "Tap to mark as taken.",
                            {
                                "type": "medication_self_due",
                                "reminder_id": rem["id"],
                                "member_id": member_id,
                                "stage": STAGE_DUE,
                                "slot_time": slot_time,
                            },
                        )
                    except Exception as e:
                        logger.warning(f"med_due push failed: {e}")
                    counters["fired_due"] += 1

            # Stage 2: gentle reminder (T+30)
            if delta_min >= STAGE_OFFSETS_MIN[STAGE_REMIND_30]:
                won = await _try_record_stage(
                    db,
                    reminder_id=rem["id"],
                    family_group_id=family_group_id,
                    member_id=member_id,
                    slot_time=slot_time,
                    local_date=local_date,
                    stage=STAGE_REMIND_30,
                    now_utc=now_utc,
                )
                if won and self_user_id:
                    try:
                        await push_to_user(
                            self_user_id,
                            f"💊 Reminder: Don't forget your {rem['title']}",
                            "It's been 30 minutes. Tap to mark as taken.",
                            {
                                "type": "medication_self_remind",
                                "reminder_id": rem["id"],
                                "member_id": member_id,
                                "stage": STAGE_REMIND_30,
                                "slot_time": slot_time,
                            },
                        )
                    except Exception as e:
                        logger.warning(f"med_remind_30 push failed: {e}")
                    counters["fired_remind_30"] += 1

            # Stage 3: family escalation (T+2h)
            if delta_min >= STAGE_OFFSETS_MIN[STAGE_ESCALATE_2H]:
                won = await _try_record_stage(
                    db,
                    reminder_id=rem["id"],
                    family_group_id=family_group_id,
                    member_id=member_id,
                    slot_time=slot_time,
                    local_date=local_date,
                    stage=STAGE_ESCALATE_2H,
                    now_utc=now_utc,
                )
                if won:
                    member_name = member.get("name") or rem.get("member_name") or "your loved one"
                    try:
                        # Also record an Alert row so caregivers see it in /alerts.
                        from uuid import uuid4
                        await db.alerts.insert_one(
                            {
                                "id": str(uuid4()),
                                "owner_id": rem.get("owner_id"),
                                "family_group_id": family_group_id,
                                "member_id": member_id,
                                "member_name": member_name,
                                "type": "medication_escalation",
                                "severity": "critical",
                                "title": f"{member_name} hasn't taken {rem['title']}",
                                "message": (
                                    f"KINNSHIP ALERT: {member_name} hasn't confirmed their "
                                    f"{rem['title']} after 2 hours. Please check on them."
                                ),
                                "acknowledged": False,
                                "created_at": now_utc,
                            }
                        )
                    except Exception as e:
                        logger.warning(f"med_escalate alert insert failed: {e}")
                    try:
                        await push_to_family_group(
                            family_group_id,
                            f"💊 KINNSHIP ALERT: {member_name} hasn't taken {rem['title']}",
                            f"{member_name} hasn't confirmed their {rem['title']} after 2 hours. "
                            "Please check on them.",
                            {
                                "type": "medication_family_escalation",
                                "reminder_id": rem["id"],
                                "member_id": member_id,
                                "stage": STAGE_ESCALATE_2H,
                                "slot_time": slot_time,
                            },
                            exclude_user_id=None,
                        )
                    except Exception as e:
                        logger.warning(f"med_escalate push failed: {e}")
                    counters["fired_escalate_2h"] += 1

    return counters


# ---------- Background worker ----------
class MedicationScheduler:
    """Persistent background task wrapper. Starts on app startup, stops on shutdown."""

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
                    + counters["fired_remind_30"]
                    + counters["fired_escalate_2h"]
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
