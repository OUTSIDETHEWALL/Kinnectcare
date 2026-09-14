"""Focused backend coverage for occurrence-scoped medication acknowledgments."""

import asyncio
import os
import sys
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "medication_occurrence_tests")
os.environ.setdefault("JWT_SECRET", "test-suite-only-signing-secret-that-is-long-enough")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import med_scheduler  # noqa: E402
import server  # noqa: E402
from expo_push import _collapse_id  # noqa: E402
from fastapi import HTTPException  # noqa: E402
from pymongo.errors import DuplicateKeyError  # noqa: E402


def _match(row, query):
    for key, expected in query.items():
        if key == "$or":
            if not any(_match(row, option) for option in expected):
                return False
            continue
        actual = row.get(key)
        if isinstance(expected, dict):
            if "$in" in expected and actual not in expected["$in"]:
                return False
            if "$ne" in expected and actual == expected["$ne"]:
                return False
            if "$exists" in expected and ((key in row) != expected["$exists"]):
                return False
            if "$lt" in expected and not (actual is not None and actual < expected["$lt"]):
                return False
            if "$gt" in expected and not (actual is not None and actual > expected["$gt"]):
                return False
            continue
        if actual != expected:
            return False
    return True


class Collection:
    def __init__(self, rows=()):
        self.rows = [dict(row) for row in rows]

    async def find_one(self, query, projection=None):
        return next((dict(row) for row in self.rows if _match(row, query)), None)

    def find(self, query, projection=None):
        rows = [dict(row) for row in self.rows if _match(row, query)]

        class Cursor:
            async def to_list(self, length=None):
                return rows[:length] if length else rows

        return Cursor()

    async def insert_one(self, row):
        if row.get("stage") and any(
            old.get("stage") == row.get("stage")
            and old.get("reminder_id") == row.get("reminder_id")
            and old.get("member_id") == row.get("member_id")
            and old.get("slot_time") == row.get("slot_time")
            and old.get("local_date") == row.get("local_date")
            for old in self.rows
        ):
            raise DuplicateKeyError("duplicate stage")
        if any(
            row.get("occurrence_id")
            and old.get("occurrence_id") == row.get("occurrence_id")
            and (
                row.get("status") == "taken"
                or "status" not in row
            )
            for old in self.rows
        ):
            raise DuplicateKeyError("duplicate occurrence")
        if any(
            row.get("terminal_occurrence_key")
            and old.get("terminal_occurrence_key")
            == row.get("terminal_occurrence_key")
            for old in self.rows
        ):
            raise DuplicateKeyError("duplicate terminal occurrence")
        self.rows.append(dict(row))
        return SimpleNamespace(inserted_id=row.get("id"))

    async def update_one(self, query, update, **kwargs):
        for row in self.rows:
            if _match(row, query):
                row.update(update.get("$set", {}))
                return SimpleNamespace(matched_count=1, modified_count=1)
        return SimpleNamespace(matched_count=0, modified_count=0)

    async def delete_many(self, query):
        before = len(self.rows)
        self.rows = [row for row in self.rows if not _match(row, query)]
        return SimpleNamespace(deleted_count=before - len(self.rows))

    async def delete_one(self, query):
        for index, row in enumerate(self.rows):
            if _match(row, query):
                self.rows.pop(index)
                return SimpleNamespace(deleted_count=1)
        return SimpleNamespace(deleted_count=0)


class DB:
    def __init__(self, reminders=()):
        self.reminders = Collection(reminders)
        self.members = Collection()
        self.users = Collection()
        self.medication_logs = Collection()
        self.medication_occurrences = Collection()
        self.med_notifications = Collection()
        self.alerts = Collection()

    def __getitem__(self, key):
        return getattr(self, key)


def _occurrence(reminder="r1", member="m1", slot="14:00", date="2026-09-12"):
    return med_scheduler.build_occurrence_id(reminder, member, slot, date)


def test_taken_logs_are_isolated_by_slot_date_and_member():
    async def scenario():
        db = DB()
        db.medication_logs.rows.append({
            "occurrence_id": _occurrence(),
            "status": "taken",
        })
        assert await med_scheduler._has_taken_log_after(
            db, "r1", "m1", "14:00", "2026-09-12"
        )
        assert not await med_scheduler._has_taken_log_after(
            db, "r1", "m1", "20:00", "2026-09-12"
        )
        assert not await med_scheduler._has_taken_log_after(
            db, "r1", "m1", "14:00", "2026-09-13"
        )
        assert not await med_scheduler._has_taken_log_after(
            db, "r1", "m2", "14:00", "2026-09-12"
        )

    asyncio.run(scenario())


def test_legacy_single_slot_does_not_expire_after_scheduler_window(monkeypatch):
    async def scenario():
        db = DB()
        db.users.rows.append({"id": "owner", "timezone": "UTC"})
        monkeypatch.setattr(server, "db", db)
        rem = {
            "id": "r1", "owner_id": "owner", "member_id": "m1",
            "category": "medication", "times": [{"time": "14:00"}],
        }
        current = {"id": "senior", "timezone": "UTC"}
        active = await server._resolve_mark_occurrence(
            rem, server.ReminderMark(status="taken"), current,
            datetime(2026, 9, 12, 14, 16, tzinfo=timezone.utc),
        )
        assert active["slot_time"] == "14:00"
        assert active["local_date"] == "2026-09-12"
        inactive = await server._resolve_mark_occurrence(
            rem, server.ReminderMark(status="taken"), current,
            datetime(2026, 9, 12, 16, 0, tzinfo=timezone.utc),
        )
        assert inactive["local_date"] == "2026-09-12"
        before_today = await server._resolve_mark_occurrence(
            rem, server.ReminderMark(status="taken"), current,
            datetime(2026, 9, 12, 13, 0, tzinfo=timezone.utc),
        )
        assert before_today["local_date"] == "2026-09-11"
        routine = {
            "id": "routine-1", "owner_id": "owner", "member_id": "m1",
            "category": "routine", "times": [{"time": "08:00"}],
        }
        late_routine = await server._resolve_mark_occurrence(
            routine, server.ReminderMark(status="taken"), current,
            datetime(2026, 9, 12, 20, 0, tzinfo=timezone.utc),
        )
        assert late_routine["slot_time"] == "08:00"
        assert late_routine["local_date"] == "2026-09-12"

    asyncio.run(scenario())


def test_legacy_multi_slot_uses_nearest_prior_configured_occurrence(monkeypatch):
    async def scenario():
        db = DB()
        db.users.rows.append({"id": "owner", "timezone": "UTC"})
        monkeypatch.setattr(server, "db", db)
        rem = {
            "id": "r1", "owner_id": "owner", "member_id": "m1",
            "category": "medication",
            "times": [{"time": "14:00"}, {"time": "14:10"}],
        }
        result = await server._resolve_mark_occurrence(
            rem, server.ReminderMark(status="taken"),
            {"id": "senior", "timezone": "UTC"},
            datetime(2026, 9, 12, 14, 16, tzinfo=timezone.utc),
        )
        assert result["slot_time"] == "14:10"
        assert result["local_date"] == "2026-09-12"

    asyncio.run(scenario())


def test_legacy_mark_and_scheduler_share_owner_local_date_at_utc_boundary(monkeypatch):
    async def scenario():
        db = DB()
        db.users.rows.append({"id": "owner", "timezone": "America/Phoenix"})
        monkeypatch.setattr(server, "db", db)
        rem = {
            "id": "r1", "owner_id": "owner", "member_id": "m1",
            "category": "medication", "times": [{"time": "23:00"}],
        }
        # 06:16 UTC is 23:16 on the prior date in Phoenix.
        result = await server._resolve_mark_occurrence(
            rem, server.ReminderMark(status="taken"),
            {"id": "senior", "timezone": "UTC"},
            datetime(2026, 9, 13, 6, 16, tzinfo=timezone.utc),
        )
        assert result["local_date"] == "2026-09-12"
        assert result["occurrence_id"] == _occurrence(
            "r1", "m1", "23:00", "2026-09-12"
        )

    asyncio.run(scenario())


def test_mark_is_idempotent_and_persists_exact_occurrence(monkeypatch):
    async def scenario():
        db = DB()
        db.reminders.rows.append({
            "id": "r1", "family_group_id": "g1", "member_id": "m1",
            "member_name": "Joyce", "owner_id": "owner", "title": "Aspirin",
            "category": "medication", "times": [{"time": "14:00"}],
            "status": "pending", "taken": False,
        })
        db.members.rows.append({
            "id": "m1", "family_group_id": "g1", "user_id": "senior",
        })
        monkeypatch.setattr(server, "db", db)
        monkeypatch.setattr(server, "_med_scheduler_ready", True)
        current = {"id": "senior", "family_group_id": "g1", "timezone": "UTC"}
        body = server.ReminderMark(
            status="taken", slot_time="14:00", local_date="2026-09-12",
            occurrence_id=_occurrence(),
        )
        assert await server.mark_reminder("r1", body, current) == {
            "ok": True, "status": "taken"
        }
        assert await server.mark_reminder("r1", body, current) == {
            "ok": True, "status": "taken"
        }
        assert len(db.medication_logs.rows) == 1
        assert db.medication_logs.rows[0]["occurrence_id"] == _occurrence()
        assert db.medication_logs.rows[0]["slot_time"] == "14:00"

    asyncio.run(scenario())


def test_only_target_member_can_mark_exact_occurrence(monkeypatch):
    async def scenario():
        db = DB()
        db.reminders.rows.append({
            "id": "r1", "family_group_id": "g1", "member_id": "m1",
            "member_name": "Joyce", "title": "Aspirin", "times": [{"time": "14:00"}],
        })
        db.members.rows.append({
            "id": "m1", "family_group_id": "g1", "user_id": "senior",
        })
        monkeypatch.setattr(server, "db", db)
        monkeypatch.setattr(server, "_med_scheduler_ready", True)
        with pytest.raises(HTTPException) as denied:
            await server.mark_reminder(
                "r1",
                server.ReminderMark(
                    status="taken", slot_time="14:00",
                    local_date="2026-09-12", occurrence_id=_occurrence(),
                ),
                {"id": "caregiver", "family_group_id": "g1", "timezone": "UTC"},
            )
        assert denied.value.status_code == 403
        assert not db.medication_logs.rows

    asyncio.run(scenario())


def test_t15_claim_and_acknowledgment_cannot_both_win(monkeypatch):
    async def scenario():
        db = DB()
        monkeypatch.setattr(server, "db", db)
        occurrence = {
            "occurrence_id": _occurrence(),
            "reminder_id": "r1", "member_id": "m1",
            "slot_time": "14:00", "local_date": "2026-09-12",
        }
        now = datetime.now(timezone.utc)
        family_result, ack_result = await asyncio.gather(
            med_scheduler._claim_occurrence_for_family(
                db, **occurrence, now_utc=now
            ),
            server._claim_medication_acknowledgment(occurrence, now),
        )
        assert not (family_result and ack_result == "claimed")
        assert family_result or ack_result == "claimed"

    asyncio.run(scenario())


def test_stale_takeover_keeps_family_claimed_while_ack_races(monkeypatch):
    async def scenario():
        db = DB()
        occurrence_id = _occurrence()
        old = datetime(2026, 9, 12, 14, 0, tzinfo=timezone.utc)
        now = datetime(2026, 9, 12, 14, 10, tzinfo=timezone.utc)
        db.medication_occurrences.rows.append({
            "occurrence_id": occurrence_id,
            "reminder_id": "r1",
            "member_id": "m1",
            "slot_time": "14:00",
            "local_date": "2026-09-12",
            "acknowledged": False,
            "family_claimed": True,
            "family_state": "sending",
            "family_claim_token": "old-token",
            "family_claimed_at": old,
            "family_recovery_deadline_at": datetime(
                2026, 9, 12, 16, 0, tzinfo=timezone.utc
            ),
        })
        db.alerts.rows.append({
            "id": med_scheduler.build_medication_escalation_alert_id(occurrence_id),
            "type": "medication_escalation",
            "occurrence_id": occurrence_id,
        })
        monkeypatch.setattr(server, "db", db)
        new_token, ack_result = await asyncio.gather(
            med_scheduler._claim_occurrence_for_family(
                db,
                occurrence_id=occurrence_id,
                reminder_id="r1",
                member_id="m1",
                slot_time="14:00",
                local_date="2026-09-12",
                now_utc=now,
            ),
            server._claim_medication_acknowledgment(
                {
                    "occurrence_id": occurrence_id,
                    "reminder_id": "r1",
                    "member_id": "m1",
                    "slot_time": "14:00",
                    "local_date": "2026-09-12",
                },
                now,
            ),
        )
        state = db.medication_occurrences.rows[0]
        assert new_token and new_token != "old-token"
        assert ack_result == "blocked"
        assert state["family_claimed"] is True
        assert state["family_claim_token"] == new_token
        assert state["family_recovery_deadline_at"] == datetime(
            2026, 9, 12, 16, 0, tzinfo=timezone.utc
        )

    asyncio.run(scenario())


def test_stale_stage_reserved_before_push_recovers_past_t75():
    async def scenario():
        db = DB([{
            "id": "r1", "owner_id": "owner", "family_group_id": "g1",
            "member_id": "m1", "member_name": "Joyce", "category": "medication",
            "title": "Aspirin", "times": [{"time": "14:00"}],
        }])
        occurrence_id = _occurrence()
        claimed_at = datetime(2026, 9, 12, 14, 15, tzinfo=timezone.utc)
        now = datetime(2026, 9, 12, 15, 20, tzinfo=timezone.utc)
        db.members.rows.append({
            "id": "m1", "owner_id": "owner", "family_group_id": "g1",
            "user_id": "senior", "name": "Joyce",
        })
        db.users.rows.append({"id": "owner", "timezone": "UTC"})
        db.medication_occurrences.rows.append({
            "occurrence_id": occurrence_id, "reminder_id": "r1",
            "member_id": "m1", "slot_time": "14:00",
            "local_date": "2026-09-12", "acknowledged": False,
            "family_claimed": True, "family_state": "sending",
            "family_claim_token": "crashed-worker",
            "family_claimed_at": claimed_at,
            "family_recovery_deadline_at": now + med_scheduler.timedelta(
                minutes=30
            ),
        })
        db.med_notifications.rows.append({
            "reminder_id": "r1", "family_group_id": "g1", "member_id": "m1",
            "slot_time": "14:00", "local_date": "2026-09-12",
            "stage": med_scheduler.STAGE_FAMILY,
            "delivery_state": "sending",
            "delivery_claimed_at": claimed_at,
            "delivery_recovery_deadline_at": now + med_scheduler.timedelta(
                minutes=30
            ),
        })
        db.alerts.rows.append({
            "id": med_scheduler.build_medication_escalation_alert_id(occurrence_id),
            "type": "medication_escalation", "occurrence_id": occurrence_id,
        })
        pushes = []

        async def family_push(*args, **kwargs):
            pushes.append(args)
            return 1

        result = await med_scheduler.process_pending_notifications(
            db,
            push_to_user=lambda *args: asyncio.sleep(0),
            push_to_family_group=family_push,
            now_utc=now,
        )
        stage = db.med_notifications.rows[0]
        assert result["fired_family_alert"] == 1
        assert len(pushes) == 1
        assert stage["delivery_state"] == "sent"
        assert "delivery_attempted_at" in stage
        assert db.medication_occurrences.rows[0]["family_state"] == "sent"

    asyncio.run(scenario())


def test_attempted_push_crash_finalizes_permanently_past_horizon(monkeypatch):
    async def scenario():
        db = DB([{
            "id": "r1", "owner_id": "owner", "family_group_id": "g1",
            "member_id": "m1", "member_name": "Joyce", "category": "medication",
            "title": "Aspirin", "times": [{"time": "14:00"}],
        }])
        occurrence_id = _occurrence()
        attempted_at = datetime(2026, 9, 12, 14, 20, tzinfo=timezone.utc)
        db.members.rows.append({
            "id": "m1", "owner_id": "owner", "family_group_id": "g1",
            "user_id": "senior", "name": "Joyce",
        })
        db.users.rows.append({"id": "owner", "timezone": "UTC"})
        db.medication_occurrences.rows.append({
            "occurrence_id": occurrence_id, "reminder_id": "r1",
            "member_id": "m1", "slot_time": "14:00",
            "local_date": "2026-09-12", "acknowledged": False,
            "family_claimed": True, "family_state": "sending",
            "family_claim_token": "crashed-worker",
            "family_claimed_at": attempted_at,
            "family_recovery_deadline_at": datetime(
                2026, 9, 12, 14, 30, tzinfo=timezone.utc
            ),
        })
        db.med_notifications.rows.append({
            "reminder_id": "r1", "family_group_id": "g1", "member_id": "m1",
            "slot_time": "14:00", "local_date": "2026-09-12",
            "stage": med_scheduler.STAGE_FAMILY,
            "delivery_state": "sending",
            "delivery_claimed_at": attempted_at,
            "delivery_attempted_at": attempted_at,
            "delivery_recovery_deadline_at": datetime(
                2026, 9, 12, 14, 30, tzinfo=timezone.utc
            ),
            "family_claim_token": "crashed-worker",
        })
        db.alerts.rows.append({
            "id": med_scheduler.build_medication_escalation_alert_id(occurrence_id),
            "type": "medication_escalation", "occurrence_id": occurrence_id,
        })
        pushes = []

        async def family_push(*args, **kwargs):
            pushes.append(args)
            return 1

        async def tick(now):
            return await med_scheduler.process_pending_notifications(
                db,
                push_to_user=lambda *args: asyncio.sleep(0),
                push_to_family_group=family_push,
                now_utc=now,
            )

        await tick(datetime(2026, 9, 12, 14, 26, tzinfo=timezone.utc))
        await tick(datetime(2026, 9, 12, 16, 0, tzinfo=timezone.utc))
        await tick(datetime(2026, 9, 12, 18, 0, tzinfo=timezone.utc))
        assert pushes == []
        assert db.med_notifications.rows[0]["delivery_state"] == "sent"
        assert db.medication_occurrences.rows[0]["family_state"] == "sent"
        assert db.medication_occurrences.rows[0]["family_claimed"] is True

        monkeypatch.setattr(server, "db", db)
        monkeypatch.setattr(server, "_med_scheduler_ready", True)
        with pytest.raises(HTTPException) as blocked:
            await server.mark_reminder(
                "r1",
                server.ReminderMark(
                    status="taken", slot_time="14:00",
                    local_date="2026-09-12", occurrence_id=occurrence_id,
                ),
                {"id": "senior", "family_group_id": "g1", "timezone": "UTC"},
            )
        assert blocked.value.status_code == 409
        assert db.medication_logs.rows == []

    asyncio.run(scenario())


def test_occurrence_state_operational_insert_failure_is_not_swallowed():
    class BrokenCollection(Collection):
        async def insert_one(self, row):
            raise RuntimeError("mongo unavailable")

    async def scenario():
        db = DB()
        db.medication_occurrences = BrokenCollection()
        with pytest.raises(RuntimeError, match="mongo unavailable"):
            await med_scheduler._ensure_occurrence_state(
                db,
                occurrence_id=_occurrence(),
                reminder_id="r1",
                member_id="m1",
                slot_time="14:00",
                local_date="2026-09-12",
            )

    asyncio.run(scenario())


def test_medication_unique_indexes_are_startup_prerequisites():
    class BrokenIndexes(Collection):
        async def create_index(self, *args, **kwargs):
            raise RuntimeError("index creation failed")

    class IndexDB:
        def __init__(self):
            self.med_notifications = BrokenIndexes()
            self.medication_logs = BrokenIndexes()
            self.medication_occurrences = BrokenIndexes()
            self.alerts = BrokenIndexes()

    async def scenario():
        with pytest.raises(RuntimeError, match="index creation failed"):
            await med_scheduler.ensure_indexes(IndexDB())

    asyncio.run(scenario())


def test_terminal_index_setup_ignores_legacy_duplicate_missed_rows():
    class IndexRecorder(Collection):
        def __init__(self, rows=()):
            super().__init__(rows)
            self.indexes = []

        async def create_index(self, keys, **kwargs):
            self.indexes.append((keys, kwargs))
            return kwargs.get("name")

    class IndexDB:
        def __init__(self):
            self.med_notifications = IndexRecorder()
            self.medication_logs = IndexRecorder([
                {"occurrence_id": _occurrence(), "status": "missed"},
                {"occurrence_id": _occurrence(), "status": "missed"},
            ])
            self.medication_occurrences = IndexRecorder()
            self.alerts = IndexRecorder()

    async def scenario():
        db = IndexDB()
        await med_scheduler.ensure_indexes(db)
        names = [kwargs["name"] for _, kwargs in db.medication_logs.indexes]
        assert names == [
            "uniq_taken_medication_occurrence",
            "uniq_medication_terminal_occurrence",
        ]
        terminal = db.medication_logs.indexes[1]
        assert terminal[0] == [("terminal_occurrence_key", 1)]
        assert terminal[1]["partialFilterExpression"] == {
            "terminal_occurrence_key": {"$exists": True}
        }

    asyncio.run(scenario())


def test_startup_resets_readiness_and_does_not_start_without_indexes(monkeypatch):
    async def scenario():
        async def fail_indexes(_db):
            raise RuntimeError("index unavailable")

        monkeypatch.setattr(server.med_scheduler, "ensure_indexes", fail_indexes)
        monkeypatch.setattr(server, "_med_scheduler", object())
        monkeypatch.setattr(server, "_med_scheduler_ready", True)
        await server._start_med_scheduler()
        assert server._med_scheduler is None
        assert server._med_scheduler_ready is False

    asyncio.run(scenario())


def test_acknowledgment_is_blocked_after_family_claim_finalization(monkeypatch):
    async def scenario():
        db = DB()
        occurrence_id = _occurrence()
        db.reminders.rows.append({
            "id": "r1", "family_group_id": "g1", "member_id": "m1",
            "member_name": "Joyce", "title": "Aspirin",
            "category": "medication", "times": [{"time": "14:00"}],
            "status": "pending", "taken": False,
        })
        db.members.rows.append({
            "id": "m1", "family_group_id": "g1", "user_id": "senior",
        })
        db.medication_occurrences.rows.append({
            "occurrence_id": occurrence_id, "family_claimed": True,
            "family_state": "sent", "acknowledged": False,
        })
        monkeypatch.setattr(server, "db", db)
        monkeypatch.setattr(server, "_med_scheduler_ready", True)
        with pytest.raises(HTTPException) as blocked:
            await server.mark_reminder(
                "r1",
                server.ReminderMark(
                    status="taken", slot_time="14:00",
                    local_date="2026-09-12", occurrence_id=occurrence_id,
                ),
                {"id": "senior", "family_group_id": "g1", "timezone": "UTC"},
            )
        assert blocked.value.status_code == 409
        assert not db.medication_logs.rows
        reminder = await db.reminders.find_one({"id": "r1"})
        assert reminder["taken"] is False
        assert reminder["status"] == "pending"

    asyncio.run(scenario())


def test_occurrence_mark_waits_for_verified_indexes(monkeypatch):
    async def scenario():
        db = DB()
        db.reminders.rows.append({
            "id": "r1", "family_group_id": "g1", "member_id": "m1",
            "member_name": "Joyce", "title": "Aspirin",
            "category": "medication", "times": [{"time": "14:00"}],
        })
        db.members.rows.append({
            "id": "m1", "family_group_id": "g1", "user_id": "senior",
        })
        monkeypatch.setattr(server, "db", db)
        monkeypatch.setattr(server, "_med_scheduler_ready", False)
        with pytest.raises(HTTPException) as unavailable:
            await server.mark_reminder(
                "r1",
                server.ReminderMark(
                    status="taken", slot_time="14:00",
                    local_date="2026-09-12", occurrence_id=_occurrence(),
                ),
                {"id": "senior", "family_group_id": "g1", "timezone": "UTC"},
            )
        assert unavailable.value.status_code == 503
        assert unavailable.value.headers["Retry-After"] == "5"
        assert not db.medication_logs.rows

    asyncio.run(scenario())


def test_alert_persistence_failure_leaves_retryable_claim_before_stage():
    class BrokenAlerts(Collection):
        async def insert_one(self, row):
            raise RuntimeError("alert persistence failed")

    async def scenario():
        db = DB([{
            "id": "r1", "owner_id": "owner", "family_group_id": "g1",
            "member_id": "m1", "member_name": "Joyce", "category": "medication",
            "title": "Aspirin", "times": [{"time": "14:00"}],
        }])
        db.alerts = BrokenAlerts()
        db.members.rows.append({
            "id": "m1", "owner_id": "owner", "family_group_id": "g1",
            "user_id": "senior", "name": "Joyce",
        })
        db.users.rows.append({"id": "owner", "timezone": "UTC"})
        pushes = []

        async def family_push(*args, **kwargs):
            pushes.append(args)
            return 1

        with pytest.raises(RuntimeError, match="alert persistence failed"):
            await med_scheduler.process_pending_notifications(
                db,
                push_to_user=lambda *args: asyncio.sleep(0),
                push_to_family_group=family_push,
                now_utc=datetime(2026, 9, 12, 14, 16, tzinfo=timezone.utc),
            )
        assert pushes == []
        assert db.med_notifications.rows == []
        assert len(db.medication_occurrences.rows) == 1
        assert db.medication_occurrences.rows[0]["family_state"] == "sending"

        # A stale pre-push claim is recoverable; the next successful insert
        # can reserve the stage and push exactly once.
        db.alerts = Collection()
        retry = await med_scheduler.process_pending_notifications(
            db,
            push_to_user=lambda *args: asyncio.sleep(0),
            push_to_family_group=family_push,
            now_utc=datetime(2026, 9, 12, 14, 22, tzinfo=timezone.utc),
        )
        assert retry["fired_family_alert"] == 1
        assert len(pushes) == 1

    asyncio.run(scenario())


def test_ambiguous_committed_alert_insert_reuses_one_alert_id():
    class AmbiguousAlerts(Collection):
        async def insert_one(self, row):
            self.rows.append(dict(row))
            raise RuntimeError("write result unknown")

    async def scenario():
        db = DB()
        db.alerts = AmbiguousAlerts()
        occurrence_id = _occurrence()
        kwargs = {
            "alert_id": med_scheduler.build_medication_escalation_alert_id(
                occurrence_id
            ),
            "owner_id": "owner",
            "family_group_id": "g1",
            "member_id": "m1",
            "member_name": "Joyce",
            "title": "💊 KINNSHIP ALERT: Joyce hasn't taken Aspirin",
            "message": "Joyce hasn't confirmed their Aspirin after 15 min. Please check on them.",
            "now_utc": datetime(2026, 9, 12, 14, 16, tzinfo=timezone.utc),
            "reminder_id": "r1",
            "medication_name": "Aspirin",
            "dosage": "81 mg",
            "scheduled_time": "14:00",
            "local_date": "2026-09-12",
            "occurrence_id": occurrence_id,
        }
        first = await med_scheduler._ensure_medication_escalation_alert(
            db, **kwargs
        )
        second = await med_scheduler._ensure_medication_escalation_alert(
            db, **kwargs
        )
        assert first == second == kwargs["alert_id"]
        assert len(db.alerts.rows) == 1

    asyncio.run(scenario())


def test_acknowledged_occurrence_has_no_family_stage_push_or_alert():
    async def scenario():
        db = DB([{
            "id": "r1", "owner_id": "owner", "family_group_id": "g1",
            "member_id": "m1", "member_name": "Joyce", "category": "medication",
            "title": "Aspirin", "times": [{"time": "14:00"}],
        }])
        db.members.rows.append({
            "id": "m1", "owner_id": "owner", "family_group_id": "g1",
            "user_id": "senior", "name": "Joyce",
        })
        db.users.rows.append({"id": "owner", "timezone": "UTC"})
        db.medication_logs.rows.append({
            "occurrence_id": _occurrence("r1", "m1", "14:00", "2026-09-12"),
            "status": "taken",
        })
        pushes = []

        async def family_push(*args, **kwargs):
            pushes.append(args)
            return 1

        result = await med_scheduler.process_pending_notifications(
            db,
            push_to_user=lambda *args: asyncio.sleep(0),
            push_to_family_group=family_push,
            now_utc=datetime(2026, 9, 12, 14, 16, tzinfo=timezone.utc),
        )
        assert result["skipped_taken"] == 1
        assert db.med_notifications.rows == []
        assert pushes == []
        assert db.alerts.rows == []

    asyncio.run(scenario())


def test_ignored_occurrence_still_escalates_once():
    async def scenario():
        db = DB([{
            "id": "r1", "owner_id": "owner", "family_group_id": "g1",
            "member_id": "m1", "member_name": "Joyce", "category": "medication",
            "title": "Aspirin", "times": [{"time": "14:00"}],
        }])
        db.members.rows.append({
            "id": "m1", "owner_id": "owner", "family_group_id": "g1",
            "user_id": "senior", "name": "Joyce",
        })
        db.users.rows.append({"id": "owner", "timezone": "UTC"})
        pushes = []

        async def self_push(*args):
            return 1

        async def family_push(*args, **kwargs):
            pushes.append(args)
            return 1

        now = datetime(2026, 9, 12, 14, 16, tzinfo=timezone.utc)
        first = await med_scheduler.process_pending_notifications(
            db, push_to_user=self_push, push_to_family_group=family_push,
            now_utc=now,
        )
        second = await med_scheduler.process_pending_notifications(
            db, push_to_user=self_push, push_to_family_group=family_push,
            now_utc=now,
        )
        assert first["fired_family_alert"] == 1
        assert second["fired_family_alert"] == 0
        assert len(pushes) == 1
        pushed_alert_id = pushes[0][3]["alert_id"]
        assert pushed_alert_id
        assert db.alerts.rows[0]["id"] == pushed_alert_id
        assert db.alerts.rows[0]["occurrence_id"] == _occurrence(
            "r1", "m1", "14:00", "2026-09-12"
        )

    asyncio.run(scenario())


def test_repeated_concurrent_t0_delivery_records_one_self_stage():
    async def scenario():
        db = DB([{
            "id": "r1", "owner_id": "owner", "family_group_id": "g1",
            "member_id": "m1", "member_name": "Joyce", "category": "medication",
            "title": "Aspirin", "times": [{"time": "14:00"}],
        }])
        db.members.rows.append({
            "id": "m1", "owner_id": "owner", "family_group_id": "g1",
            "user_id": "senior", "name": "Joyce",
        })
        db.users.rows.append({"id": "owner", "timezone": "UTC"})
        pushes = []
        entered = asyncio.Event()
        release = asyncio.Event()

        async def self_push(*args):
            pushes.append(args)
            if len(pushes) == 1:
                entered.set()
                await release.wait()
            return 1

        async def family_push(*args, **kwargs):
            return 1

        now = datetime(2026, 9, 12, 14, 0, tzinfo=timezone.utc)
        first = asyncio.create_task(med_scheduler.process_pending_notifications(
            db,
            push_to_user=self_push,
            push_to_family_group=family_push,
            now_utc=now,
        ))
        await entered.wait()
        competitors = [
            asyncio.create_task(med_scheduler.process_pending_notifications(
                db,
                push_to_user=self_push,
                push_to_family_group=family_push,
                now_utc=now,
            ))
            for _ in range(2)
        ]
        await asyncio.gather(*competitors)
        release.set()
        await first
        assert len(pushes) == 1
        assert len([
            row for row in db.med_notifications.rows
            if row["stage"] == med_scheduler.STAGE_DUE
        ]) == 1

    asyncio.run(scenario())


def test_repeated_concurrent_t15_delivery_records_one_family_push():
    async def scenario():
        db = DB([{
            "id": "r1", "owner_id": "owner", "family_group_id": "g1",
            "member_id": "m1", "member_name": "Joyce", "category": "medication",
            "title": "Aspirin", "times": [{"time": "14:00"}],
        }])
        db.members.rows.append({
            "id": "m1", "owner_id": "owner", "family_group_id": "g1",
            "user_id": "senior", "name": "Joyce",
        })
        db.users.rows.append({"id": "owner", "timezone": "UTC"})
        pushes = []
        entered = asyncio.Event()
        release = asyncio.Event()

        async def self_push(*args):
            return 1

        async def family_push(*args, **kwargs):
            pushes.append(args)
            if len(pushes) == 1:
                entered.set()
                await release.wait()
            return 1

        now = datetime(2026, 9, 12, 14, 15, tzinfo=timezone.utc)
        first = asyncio.create_task(med_scheduler.process_pending_notifications(
            db,
            push_to_user=self_push,
            push_to_family_group=family_push,
            now_utc=now,
        ))
        await entered.wait()
        competitors = [
            asyncio.create_task(med_scheduler.process_pending_notifications(
                db,
                push_to_user=self_push,
                push_to_family_group=family_push,
                now_utc=now,
            ))
            for _ in range(2)
        ]
        await asyncio.gather(*competitors)
        release.set()
        await first
        assert len(pushes) == 1
        assert len([
            row for row in db.alerts.rows
            if row["type"] == "medication_escalation"
        ]) == 1

    asyncio.run(scenario())


def test_exact_manual_miss_retries_create_one_escalation_and_push(monkeypatch):
    async def scenario():
        db = DB()
        db.reminders.rows.append({
            "id": "r1", "owner_id": "owner", "family_group_id": "g1",
            "member_id": "m1", "member_name": "Joyce", "category": "medication",
            "title": "Aspirin", "dosage": "81 mg",
            "times": [{"time": "14:00"}],
        })
        db.members.rows.append({
            "id": "m1", "owner_id": "owner", "family_group_id": "g1",
            "user_id": "senior", "name": "Joyce",
        })
        monkeypatch.setattr(server, "db", db)
        monkeypatch.setattr(server, "_med_scheduler_ready", True)
        pushes = []
        entered = asyncio.Event()
        release = asyncio.Event()

        async def family_push(*args, **kwargs):
            pushes.append(args)
            if len(pushes) == 1:
                entered.set()
                await release.wait()
            return 1

        monkeypatch.setattr(server, "push_to_family_group", family_push)
        body = server.ReminderMark(
            status="missed",
            slot_time="14:00",
            local_date="2026-09-12",
            occurrence_id=_occurrence(),
        )
        current = {"id": "senior", "family_group_id": "g1", "timezone": "UTC"}
        first = asyncio.create_task(server.mark_reminder("r1", body, current))
        await entered.wait()
        competitors = [
            asyncio.create_task(server.mark_reminder("r1", body, current))
            for _ in range(2)
        ]
        await asyncio.gather(*competitors)
        release.set()
        await first
        alerts = [
            row for row in db.alerts.rows
            if row["type"] == "medication_escalation"
        ]
        assert len(alerts) == 1
        assert len(pushes) == 1
        assert alerts[0]["occurrence_id"] == _occurrence()
        assert alerts[0]["medication_name"] == "Aspirin"
        assert alerts[0]["dosage"] == "81 mg"
        assert alerts[0]["scheduled_time"] == "14:00"
        assert alerts[0]["missed_local_date"] == "2026-09-12"
        assert len([
            row for row in db.medication_logs.rows
            if row.get("status") == "missed"
        ]) == 1
        assert len([
            row for row in db.med_notifications.rows
            if row.get("stage") == med_scheduler.STAGE_FAMILY
        ]) == 1
        reminder = await db.reminders.find_one({"id": "r1"})
        assert reminder["status"] == "missed"
        assert reminder["taken"] is False

    asyncio.run(scenario())


def test_acknowledged_then_manual_missed_is_rejected_without_mutation(monkeypatch):
    async def scenario():
        db = DB()
        db.reminders.rows.append({
            "id": "r1", "owner_id": "owner", "family_group_id": "g1",
            "member_id": "m1", "member_name": "Joyce", "category": "medication",
            "title": "Aspirin", "times": [{"time": "14:00"}],
            "status": "pending", "taken": False,
        })
        db.members.rows.append({
            "id": "m1", "owner_id": "owner", "family_group_id": "g1",
            "user_id": "senior", "name": "Joyce",
        })
        monkeypatch.setattr(server, "db", db)
        monkeypatch.setattr(server, "_med_scheduler_ready", True)
        pushes = []

        async def family_push(*args, **kwargs):
            pushes.append(args)
            return 1

        monkeypatch.setattr(server, "push_to_family_group", family_push)
        current = {"id": "senior", "family_group_id": "g1", "timezone": "UTC"}
        taken = server.ReminderMark(
            status="taken", slot_time="14:00", local_date="2026-09-12",
            occurrence_id=_occurrence(),
        )
        missed = server.ReminderMark(
            status="missed", slot_time="14:00", local_date="2026-09-12",
            occurrence_id=_occurrence(),
        )
        await server.mark_reminder("r1", taken, current)
        with pytest.raises(HTTPException) as rejected:
            await server.mark_reminder("r1", missed, current)
        assert rejected.value.status_code == 409
        assert "already acknowledged" in rejected.value.detail
        reminder = await db.reminders.find_one({"id": "r1"})
        assert reminder["status"] == "taken"
        assert reminder["taken"] is True
        assert [row["status"] for row in db.medication_logs.rows] == ["taken"]
        assert db.alerts.rows == []
        assert pushes == []

    asyncio.run(scenario())


def test_taken_log_blocks_manual_miss_even_without_occurrence_state(monkeypatch):
    async def scenario():
        db = DB()
        db.reminders.rows.append({
            "id": "r1", "owner_id": "owner", "family_group_id": "g1",
            "member_id": "m1", "member_name": "Joyce", "category": "medication",
            "title": "Aspirin", "times": [{"time": "14:00"}],
            "status": "pending", "taken": False,
        })
        db.members.rows.append({
            "id": "m1", "owner_id": "owner", "family_group_id": "g1",
            "user_id": "senior", "name": "Joyce",
        })
        db.medication_logs.rows.append({
            "occurrence_id": _occurrence(), "status": "taken",
        })
        monkeypatch.setattr(server, "db", db)
        monkeypatch.setattr(server, "_med_scheduler_ready", True)
        with pytest.raises(HTTPException) as rejected:
            await server.mark_reminder(
                "r1",
                server.ReminderMark(
                    status="missed", slot_time="14:00",
                    local_date="2026-09-12", occurrence_id=_occurrence(),
                ),
                {"id": "senior", "family_group_id": "g1", "timezone": "UTC"},
            )
        assert rejected.value.status_code == 409
        assert len(db.medication_occurrences.rows) == 0
        assert len(db.medication_logs.rows) == 1
        reminder = await db.reminders.find_one({"id": "r1"})
        assert reminder["status"] == "pending"

    asyncio.run(scenario())


def test_legacy_missed_log_blocks_taken_without_taken_mutation(monkeypatch):
    async def scenario():
        db = DB()
        db.reminders.rows.append({
            "id": "r1", "owner_id": "owner", "family_group_id": "g1",
            "member_id": "m1", "member_name": "Joyce", "category": "medication",
            "title": "Aspirin", "times": [{"time": "14:00"}],
            "status": "pending", "taken": False,
        })
        db.members.rows.append({
            "id": "m1", "owner_id": "owner", "family_group_id": "g1",
            "user_id": "senior", "name": "Joyce",
        })
        # Legacy missed rows predate terminal_occurrence_key.
        db.medication_logs.rows.append({
            "occurrence_id": _occurrence(), "status": "missed",
        })
        monkeypatch.setattr(server, "db", db)
        monkeypatch.setattr(server, "_med_scheduler_ready", True)
        with pytest.raises(HTTPException) as rejected:
            await server.mark_reminder(
                "r1",
                server.ReminderMark(
                    status="taken", slot_time="14:00",
                    local_date="2026-09-12", occurrence_id=_occurrence(),
                ),
                {"id": "senior", "family_group_id": "g1", "timezone": "UTC"},
            )
        assert rejected.value.status_code == 409
        assert len(db.medication_logs.rows) == 1
        assert db.medication_logs.rows[0]["status"] == "missed"
        assert db.medication_occurrences.rows == []
        reminder = await db.reminders.find_one({"id": "r1"})
        assert reminder["status"] == "pending"
        assert reminder["taken"] is False

    asyncio.run(scenario())


def test_manual_miss_replay_repairs_after_post_arbitration_write_failure(monkeypatch):
    async def scenario():
        db = DB()
        db.reminders.rows.append({
            "id": "r1", "owner_id": "owner", "family_group_id": "g1",
            "member_id": "m1", "member_name": "Joyce", "category": "medication",
            "title": "Aspirin", "dosage": "81 mg",
            "times": [{"time": "14:00"}],
            "status": "pending", "taken": False,
        })
        db.members.rows.append({
            "id": "m1", "owner_id": "owner", "family_group_id": "g1",
            "user_id": "senior", "name": "Joyce",
        })
        monkeypatch.setattr(server, "db", db)
        monkeypatch.setattr(server, "_med_scheduler_ready", True)
        pushes = []

        async def family_push(*args, **kwargs):
            pushes.append(args)
            return 1

        monkeypatch.setattr(server, "push_to_family_group", family_push)
        original_update = db.reminders.update_one
        failed = True

        async def fail_first_update(query, update, **kwargs):
            nonlocal failed
            if failed:
                failed = False
                raise RuntimeError("simulated post-arbitration crash")
            return await original_update(query, update, **kwargs)

        db.reminders.update_one = fail_first_update
        body = server.ReminderMark(
            status="missed", slot_time="14:00", local_date="2026-09-12",
            occurrence_id=_occurrence(),
        )
        current = {"id": "senior", "family_group_id": "g1", "timezone": "UTC"}
        with pytest.raises(RuntimeError, match="post-arbitration"):
            await server.mark_reminder("r1", body, current)
        state = await db.medication_occurrences.find_one(
            {"occurrence_id": _occurrence()}
        )
        assert state["family_purpose"] == "manual_miss"
        assert state["family_state"] == "sending"
        assert db.medication_logs.rows == []
        assert db.alerts.rows == []
        assert db.med_notifications.rows == []

        db.reminders.update_one = original_update
        await server.mark_reminder("r1", body, current)
        assert len([
            row for row in db.medication_logs.rows
            if row.get("status") == "missed"
        ]) == 1
        assert len([
            row for row in db.alerts.rows
            if row.get("type") == "medication_escalation"
        ]) == 1
        assert len([
            row for row in db.med_notifications.rows
            if row.get("stage") == med_scheduler.STAGE_FAMILY
        ]) == 1
        assert len(pushes) == 1
        reminder = await db.reminders.find_one({"id": "r1"})
        assert reminder["status"] == "missed"

    asyncio.run(scenario())


def test_scheduler_escalation_then_manual_miss_converges_without_second_push(
    monkeypatch,
):
    async def scenario():
        db = DB([{
            "id": "r1", "owner_id": "owner", "family_group_id": "g1",
            "member_id": "m1", "member_name": "Joyce", "category": "medication",
            "title": "Aspirin", "dosage": "81 mg",
            "times": [{"time": "14:00"}],
            "status": "pending", "taken": False,
        }])
        db.members.rows.append({
            "id": "m1", "owner_id": "owner", "family_group_id": "g1",
            "user_id": "senior", "name": "Joyce",
        })
        db.users.rows.append({"id": "owner", "timezone": "UTC"})
        pushes = []

        async def family_push(*args, **kwargs):
            pushes.append(args)
            return 1

        await med_scheduler.process_pending_notifications(
            db,
            push_to_user=lambda *args: asyncio.sleep(0),
            push_to_family_group=family_push,
            now_utc=datetime(2026, 9, 12, 14, 15, tzinfo=timezone.utc),
        )
        monkeypatch.setattr(server, "db", db)
        monkeypatch.setattr(server, "_med_scheduler_ready", True)
        monkeypatch.setattr(server, "push_to_family_group", family_push)
        await server.mark_reminder(
            "r1",
            server.ReminderMark(
                status="missed", slot_time="14:00", local_date="2026-09-12",
                occurrence_id=_occurrence(),
            ),
            {"id": "senior", "family_group_id": "g1", "timezone": "UTC"},
        )
        assert len(pushes) == 1
        assert len([
            row for row in db.alerts.rows
            if row.get("type") == "medication_escalation"
        ]) == 1
        assert len([
            row for row in db.med_notifications.rows
            if row.get("stage") == med_scheduler.STAGE_FAMILY
        ]) == 1
        assert len([
            row for row in db.medication_logs.rows
            if row.get("status") == "missed"
        ]) == 1
        reminder = await db.reminders.find_one({"id": "r1"})
        assert reminder["status"] == "missed"
        assert reminder["taken"] is False

    asyncio.run(scenario())


def test_collapse_ids_are_occurrence_scoped_and_bounded():
    base = {
        "type": "medication",
        "reminder_id": "r" * 500,
        "stage": "due",
        "slot_time": "14:00",
        "local_date": "2026-09-12",
    }
    same = _collapse_id(dict(base))
    other_slot = _collapse_id({**base, "slot_time": "20:00"})
    other_day = _collapse_id({**base, "local_date": "2026-09-13"})
    routine = _collapse_id({**base, "type": "routine"})
    assert same == _collapse_id(dict(base))
    assert same != other_slot
    assert same != other_day
    assert routine != same
    assert same is not None and len(same) <= 64
    assert _collapse_id({k: v for k, v in base.items() if k != "local_date"}) is None