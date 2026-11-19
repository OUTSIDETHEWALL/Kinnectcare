"""Offline end-to-end scheduler scans at local calendar boundaries."""
import asyncio
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from test_medication_occurrence_reliability import DB, server
import med_scheduler as scheduler
from family_fence_unit_seams import install


@pytest.fixture(autouse=True)
def isolated_persistence(monkeypatch):
    install(monkeypatch)


def run(coro):
    # Preserve the ambient loop used by older synchronous tests.
    with asyncio.Runner(loop_factory=asyncio.new_event_loop) as runner:
        return runner.run(coro)


def fixture_db(slot="23:50", tz="UTC", category="medication"):
    db = DB([{
        "id": "r1", "owner_id": "owner", "family_group_id": "g1",
        "member_id": "m1", "category": category, "title": "Test dose",
        "times": [{"time": slot}],
    }])
    db.members.rows.append({
        "id": "m1", "owner_id": "owner", "family_group_id": "g1",
        "user_id": "patient", "name": "Patient",
    })
    db.users.rows.append({"id": "owner", "timezone": tz})
    return db


async def tick(db, now, family, self_pushes=None):
    async def self_push(*args):
        if self_pushes is not None:
            self_pushes.append(args)
        return 1

    return await scheduler.process_pending_notifications(
        db, now_utc=now, push_to_user=self_push, push_to_family_group=family,
    )


@pytest.mark.parametrize("date,slot,tz,elapsed", [
    ("2026-11-18", "23:50", "UTC", 15),
    ("2026-11-18", "23:59", "UTC", 15),
    ("2026-11-18", "14:00", "UTC", 15),
    ("2026-01-31", "23:50", "UTC", 75),
    ("2026-12-31", "23:59", "UTC", 16),
    ("2026-11-18", "23:50", "America/Phoenix", 15),
    ("2026-11-18", "23:59", "Asia/Kathmandu", 16),
    ("2026-03-07", "23:50", "America/New_York", 15),
    ("2026-10-31", "23:59", "America/New_York", 15),
    # Elapsed UTC time, not wall-clock subtraction, across DST transitions.
    ("2026-03-08", "01:50", "America/New_York", 15),
    ("2026-11-01", "01:50", "America/New_York", 15),
])
def test_calendar_boundary_preserves_exact_occurrence(date, slot, tz, elapsed):
    async def scenario():
        db = fixture_db(slot, tz)
        scheduled = datetime.fromisoformat(f"{date}T{slot}").replace(tzinfo=ZoneInfo(tz))
        now = scheduled.astimezone(timezone.utc) + timedelta(minutes=elapsed)
        pushes = []

        async def family(*args):
            pushes.append(args)
            return {"outcome": "accepted", "accepted_ticket_ids": ["test-ticket"]}

        # A fresh scheduler scan with persisted reminders models restart;
        # a previous-day initial-reminder row is not required for recovery.
        await tick(db, now, family)
        await tick(db, now + timedelta(seconds=15), family)
        assert len(pushes) == 1
        identity = scheduler.build_occurrence_id("r1", "m1", slot, date)
        payload = pushes[0][3]
        assert payload["local_date"] == date
        assert payload["occurrence_id"] == identity
        assert pushes[0][0] == "g1"
        assert len(db.alerts.rows) == 1
        assert db.alerts.rows[0]["occurrence_id"] == identity
        assert db.medication_occurrences.rows[0]["family_state"] == "sent"
        assert all(row["local_date"] == date for row in db.med_notifications.rows)

    run(scenario())


@pytest.mark.parametrize("elapsed", [0, 10, 14.99, 75.01, 90, 1440])
def test_previous_day_is_bounded_and_does_not_replay_due(elapsed):
    async def scenario():
        db = fixture_db("23:59")
        now = datetime(2026, 11, 18, 23, 59, tzinfo=timezone.utc) + timedelta(minutes=elapsed)
        # Exercise only the next calendar day, excluding today's valid due.
        if now.day == 18:
            now += timedelta(seconds=1)
        pushes = []

        async def family(*args):
            pushes.append(args)

        # 1440 means today's legitimate initial dose, not stale recovery.
        self_pushes = []
        await tick(db, now, family, self_pushes)
        assert not pushes
        if now.day != 18 and elapsed != 1440:
            assert not self_pushes
            assert not db.med_notifications.rows

    run(scenario())


@pytest.mark.parametrize("ack_min", [0, 5, 14, 16])
def test_acknowledged_previous_occurrence_never_escalates(ack_min):
    async def scenario():
        db = fixture_db()
        due = datetime(2026, 11, 18, 23, 50, tzinfo=timezone.utc)
        db.medication_logs.rows.append({
            "status": "taken",
            "occurrence_id": scheduler.build_occurrence_id("r1", "m1", "23:50", "2026-11-18"),
            "taken_at": due + timedelta(minutes=ack_min),
        })
        pushes = []

        async def family(*args):
            pushes.append(args)

        await tick(db, due + timedelta(minutes=17), family)
        assert not pushes
        assert not db.alerts.rows

    run(scenario())


def test_concurrent_midnight_workers_share_one_delivery():
    async def scenario():
        db = fixture_db()
        now = datetime(2026, 11, 19, 0, 5, tzinfo=timezone.utc)
        entered, release = asyncio.Event(), asyncio.Event()
        pushes = []

        async def family(*args):
            pushes.append(args)
            entered.set()
            await release.wait()
            return {"outcome": "accepted", "accepted_ticket_ids": ["test-ticket"]}

        first = asyncio.create_task(tick(db, now, family))
        await asyncio.wait_for(entered.wait(), 2)
        await asyncio.gather(*(tick(db, now, family) for _ in range(4)))
        release.set()
        await first
        assert len(pushes) == len(db.alerts.rows) == 1

    run(scenario())


def test_midnight_preserves_safe_presend_retry_and_unknown_no_resend(monkeypatch):
    async def scenario():
        db = fixture_db()
        now = datetime(2026, 11, 19, 0, 5, tzinfo=timezone.utc)
        insert = db.alerts.insert_one

        async def fail_once(row):
            db.alerts.insert_one = insert
            raise RuntimeError("temporary storage failure before send")

        db.alerts.insert_one = fail_once
        pushes = []

        async def family(*args):
            pushes.append(args)
            # An uncertain transport cannot safely be retried automatically.
            raise RuntimeError("temporary transport error: acceptance unknown")

        with pytest.raises(RuntimeError, match="temporary storage"):
            await tick(db, now, family)
        assert not pushes
        await tick(db, now + timedelta(minutes=6), family)
        await tick(db, now + timedelta(minutes=12), family)
        assert len(pushes) == len(db.alerts.rows) == 1
        assert db.med_notifications.rows[0]["delivery_state"] == "unknown"
        assert db.medication_occurrences.rows[0]["family_state"] == "unknown"

    run(scenario())


def test_previous_day_routines_do_not_gain_family_or_replayed_due():
    async def scenario():
        db = fixture_db(category="routine")
        pushes = []

        async def family(*args):
            pushes.append(args)

        await tick(db, datetime(2026, 11, 19, 0, 5, tzinfo=timezone.utc), family, pushes)
        assert not pushes
        assert not db.med_notifications.rows

    run(scenario())


@pytest.mark.parametrize("exact", [False, True])
def test_second_fold_taken_acknowledges_first_fold_dose_before_escalation(monkeypatch, exact):
    async def scenario():
        db = fixture_db("01:50", "America/New_York")
        monkeypatch.setattr(server, "db", db)
        monkeypatch.setattr(server, "_med_scheduler_ready", True)
        identity = scheduler.build_occurrence_id("r1", "m1", "01:50", "2026-11-01")
        mark = server.ReminderMark(status="taken", **({
            "member_id": "m1", "slot_time": "01:50", "local_date": "2026-11-01",
            "occurrence_id": identity,
        } if exact else {}))
        # Second-fold 01:02 EST is twelve real minutes after 01:50 EDT.
        acknowledged_at = datetime(2026, 11, 1, 6, 2, tzinfo=timezone.utc)
        occurrence = await server._resolve_mark_occurrence(
            db.reminders.rows[0], mark, {"id": "patient", "family_group_id": "g1"}, acknowledged_at,
        )
        assert occurrence["occurrence_id"] == identity
        result = await server._mark_exact_medication_taken(
            db.reminders.rows[0], {"id": "patient", "family_group_id": "g1"}, mark, acknowledged_at,
        )
        assert result
        assert db.medication_logs.rows[0]["occurrence_id"] == identity

        async def forbidden(*args):
            pytest.fail("A successfully acknowledged first-fold dose must not escalate")

        await tick(db, datetime(2026, 11, 1, 6, 5, tzinfo=timezone.utc), forbidden)
        assert not db.alerts.rows

    run(scenario())
