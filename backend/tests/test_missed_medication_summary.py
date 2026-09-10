"""Focused tests for durable missed-medication summary details."""

import os
import sys
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "kinnship_test")
os.environ.setdefault("JWT_SECRET", "test-suite-only-signing-secret-that-is-long-enough")

with patch("motor.motor_asyncio.AsyncIOMotorClient", MagicMock()):
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
    import server


def _detail_alert(**overrides):
    alert = {
        "id": "alert-1",
        "member_id": "member-1",
        "member_name": "Joyce",
        "type": "medication",
        "title": "Medication missed: Aspirin",
        "reminder_id": "reminder-1",
        "medication_name": "Aspirin",
        "dosage": "81 mg",
        "scheduled_time": "14:00",
        "missed_at": datetime(2026, 9, 10, 21, 0, tzinfo=timezone.utc),
        "missed_local_date": "2026-09-10",
        "message": "Joyce missed Aspirin (81 mg).",
    }
    alert.update(overrides)
    return alert


def test_zero_missed_medications_has_zero_details():
    details = server.build_missed_medication_details([])
    assert details == []
    assert len(details) == 0


def test_one_missed_medication_has_structured_details():
    details = server.build_missed_medication_details([_detail_alert()])
    assert len(details) == 1
    assert details[0]["member_name"] == "Joyce"
    assert details[0]["medication_name"] == "Aspirin"
    assert details[0]["dosage"] == "81 mg"
    assert details[0]["scheduled_time"] == "14:00"
    assert details[0]["reminder_id"] == "reminder-1"


def test_multiple_members_count_matches_detail_length():
    details = server.build_missed_medication_details([
        _detail_alert(),
        _detail_alert(
            id="alert-2",
            member_id="member-2",
            member_name="Charles",
            reminder_id="reminder-2",
            medication_name="Lisinopril",
            dosage="10 mg",
            scheduled_time="08:00",
        ),
    ])
    assert len(details) == 2
    assert [detail["member_name"] for detail in details] == ["Joyce", "Charles"]


def test_normal_due_alert_is_not_counted_as_a_miss():
    details = server.build_missed_medication_details([{
        "id": "due-alert",
        "member_id": "member-1",
        "member_name": "Joyce",
        "type": "medication",
        "title": "💊 Time to take your Aspirin",
        "message": "Reminder sent at 14:00 local.",
    }])
    assert details == []


def test_scheduler_family_escalation_is_counted():
    details = server.build_missed_medication_details([_detail_alert(
        type="medication_escalation",
        title="💊 KINNSHIP ALERT: Joyce hasn't taken Aspirin",
    )])
    assert len(details) == 1
    assert details[0]["medication_name"] == "Aspirin"


def test_manual_and_scheduler_records_for_same_dose_count_once():
    details = server.build_missed_medication_details([
        _detail_alert(id="scheduler-alert", type="medication_escalation"),
        _detail_alert(id="manual-alert", type="medication"),
    ])
    assert len(details) == 1


def test_distinct_scheduled_slots_remain_distinct_occurrences():
    details = server.build_missed_medication_details([
        _detail_alert(
            id="morning-alert",
            type="medication_escalation",
            scheduled_time="08:00",
        ),
        _detail_alert(
            id="evening-alert",
            type="medication_escalation",
            scheduled_time="20:00",
        ),
    ])
    assert len(details) == 2
    assert [detail["scheduled_time"] for detail in details] == ["08:00", "20:00"]


def test_alert_occurrence_survives_reminder_daily_reset():
    # The summary builder consumes the durable alert only; it does not consult
    # the reminder's current status, which may already be reset to pending.
    details = server.build_missed_medication_details([_detail_alert()])
    simulated_reset_reminder = {"id": "reminder-1", "status": "pending"}
    assert simulated_reset_reminder["status"] == "pending"
    assert len(details) == 1
    assert details[0]["alert_id"] == "alert-1"


def test_historical_alert_does_not_fabricate_medication_metadata():
    details = server.build_missed_medication_details([{
        "id": "old-alert",
        "member_id": "member-1",
        "member_name": "Joyce",
        "type": "medication",
        "title": "Medication missed: older reminder",
        "message": "Joyce missed an older medication reminder.",
        "created_at": datetime(2026, 9, 9, 21, 0, tzinfo=timezone.utc),
    }])
    assert len(details) == 1
    assert details[0]["medication_name"] is None
    assert details[0]["dosage"] is None
    assert details[0]["scheduled_time"] is None
    assert details[0]["description"] == "Joyce missed an older medication reminder."