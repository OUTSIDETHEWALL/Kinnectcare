"""Late completion must preserve escalation history and the exact-dose mutex."""
import asyncio
from copy import deepcopy
from datetime import datetime, timezone

import pytest
import httpx
from fastapi import HTTPException

from test_medication_occurrence_reliability import DB, med_scheduler, server


def setup_occurrence(monkeypatch, *, state="sent", purpose=None):
    reminder = {
        "id": "r1", "owner_id": "owner", "family_group_id": "g1",
        "member_id": "m1", "member_name": "Test Member", "title": "Test Medication",
        "category": "medication", "times": [{"time": "14:00"}],
        "status": "pending", "taken": False,
    }
    db = DB([reminder])
    db.members.rows.append({"id": "m1", "family_group_id": "g1", "user_id": "senior"})
    oid = med_scheduler.build_occurrence_id("r1", "m1", "14:00", "2026-09-12")
    sent_at = datetime(2026, 9, 12, 14, 15, tzinfo=timezone.utc)
    db.medication_occurrences.rows.append({
        "occurrence_id": oid, "reminder_id": "r1", "member_id": "m1",
        "slot_time": "14:00", "local_date": "2026-09-12",
        "acknowledged": False, "family_claimed": True, "family_state": state,
        "family_send_completed": state == "sent",
        "family_claim_token": "durable-token", "family_claimed_at": sent_at,
        "escalation_sent_at": sent_at,
    })
    if purpose:
        db.medication_occurrences.rows[0]["family_purpose"] = purpose
    db.med_notifications.rows.append({
        "reminder_id": "r1", "member_id": "m1", "slot_time": "14:00",
        "local_date": "2026-09-12", "stage": "family_alert",
        "delivery_state": "sent", "delivery_sent_at": sent_at,
    })
    db.alerts.rows.extend([
        {
            "id": "due", "family_group_id": "g1", "member_id": "m1",
            "type": "medication", "self_due": True, "reminder_id": "r1",
            "scheduled_time": "14:00", "local_date": "2026-09-12",
            "occurrence_id": oid, "acknowledged": False,
        },
        {
            "id": "escalated", "family_group_id": "g1", "member_id": "m1",
            "type": "medication_escalation", "occurrence_id": oid,
            "acknowledged": False,
        },
    ])
    monkeypatch.setattr(server, "db", db)
    monkeypatch.setattr(server, "_med_scheduler_ready", True)
    return db, server.ReminderMark(
        status="taken", member_id="m1", slot_time="14:00",
        local_date="2026-09-12", occurrence_id=oid,
    )


def actor(user="senior", family="g1"):
    return {"id": user, "family_group_id": family, "timezone": "UTC"}


@pytest.mark.parametrize("path", ["recipient", "owner_alert"])
def test_late_acknowledgment_is_idempotent_preserves_history_and_cannot_resend(monkeypatch, path):
    async def scenario():
        db, body = setup_occurrence(monkeypatch)
        before = deepcopy(db.medication_occurrences.rows[0])
        delivery = deepcopy(db.med_notifications.rows)
        for _ in range(2):
            if path == "recipient":
                result = await server.mark_reminder("r1", body, actor())
            else:
                result = await server.acknowledge_alert("due", actor("owner"))
            assert result["status"] == "taken"
        state = db.medication_occurrences.rows[0]
        assert state["acknowledged"] is True
        for key, value in before.items():
            if key != "acknowledged":
                assert state[key] == value
        assert len(db.medication_logs.rows) == 1
        assert db.medication_logs.rows[0]["occurrence_id"] == body.occurrence_id
        assert db.reminders.rows[0]["taken"] is True
        assert db.med_notifications.rows == delivery
        assert db.alerts.rows[1]["acknowledged"] is False
        token = await med_scheduler._claim_occurrence_for_family(
            db, occurrence_id=body.occurrence_id, reminder_id="r1",
            member_id="m1", slot_time="14:00", local_date="2026-09-12",
            now_utc=datetime(2026, 9, 12, 14, 30, tzinfo=timezone.utc),
        )
        assert token is None
    asyncio.run(scenario())


@pytest.mark.parametrize("state", ["sending", None, "unknown"])
@pytest.mark.parametrize("path", ["recipient", "owner_alert"])
def test_nonfinal_escalation_remains_blocked_without_any_taken_mutation(monkeypatch, state, path):
    async def scenario():
        db, body = setup_occurrence(monkeypatch, state=state)
        before = deepcopy(db.medication_occurrences.rows)
        with pytest.raises(HTTPException) as blocked:
            if path == "recipient":
                await server.mark_reminder("r1", body, actor())
            else:
                await server.acknowledge_alert("due", actor("owner"))
        assert blocked.value.status_code == 409
        assert db.medication_occurrences.rows == before
        assert not db.medication_logs.rows
        assert db.reminders.rows[0]["taken"] is False
        assert db.alerts.rows[0]["acknowledged"] is False
    asyncio.run(scenario())


@pytest.mark.parametrize("terminal_log", [False, True])
def test_manual_miss_ownership_or_terminal_log_blocks_late_taken(monkeypatch, terminal_log):
    async def scenario():
        db, body = setup_occurrence(
            monkeypatch, purpose=None if terminal_log else "manual_miss",
        )
        if terminal_log:
            # Also covers historic misses without the terminal uniqueness key.
            db.medication_logs.rows.append({"occurrence_id": body.occurrence_id, "status": "missed"})
        before = deepcopy(db.medication_logs.rows)
        with pytest.raises(HTTPException) as blocked:
            await server.mark_reminder("r1", body, actor())
        assert blocked.value.status_code == 409
        assert db.medication_logs.rows == before
        assert db.medication_occurrences.rows[0]["acknowledged"] is False
    asyncio.run(scenario())


@pytest.mark.parametrize("winner", ["taken", "missed"])
def test_manual_miss_and_late_taken_compete_for_one_atomic_owner(monkeypatch, winner):
    async def scenario():
        db, body = setup_occurrence(monkeypatch)
        occurrence = await server._resolve_mark_occurrence(
            db.reminders.rows[0], body, actor(), datetime.now(timezone.utc),
        )
        if winner == "taken":
            await server.mark_reminder("r1", body, actor())
            result, _ = await server._arbitrate_manual_missed_occurrence(
                occurrence, datetime.now(timezone.utc),
            )
            assert result == "acknowledged"
            assert [log["status"] for log in db.medication_logs.rows] == ["taken"]
        else:
            result, _ = await server._arbitrate_manual_missed_occurrence(
                occurrence, datetime.now(timezone.utc),
            )
            assert result == "resume"
            # The miss owns the mutex but has not written its terminal log yet.
            with pytest.raises(HTTPException) as blocked:
                await server.mark_reminder("r1", body, actor())
            assert blocked.value.status_code == 409
            assert not db.medication_logs.rows
    asyncio.run(scenario())


@pytest.mark.parametrize("case,expected", [
    ("wrong_family", 404), ("wrong_user", 403), ("wrong_member", 400),
    ("wrong_occurrence", 400), ("owner_direct_mark", 403),
    ("ordinary_member_alert", 403), ("wrong_family_alert", 404),
])
def test_late_acknowledgment_does_not_broaden_permissions_or_matching(monkeypatch, case, expected):
    async def scenario():
        db, body = setup_occurrence(monkeypatch)
        current = actor()
        if case == "wrong_family":
            current = actor(family="other")
        elif case in ("wrong_user", "ordinary_member_alert"):
            current = actor("other")
        elif case == "owner_direct_mark":
            current = actor("owner")
        elif case == "wrong_member":
            body.member_id = "other"
        elif case == "wrong_occurrence":
            body.occurrence_id = "other"
        elif case == "wrong_family_alert":
            current = actor("owner", "other")
        with pytest.raises(HTTPException) as rejected:
            if case.endswith("_alert"):
                await server.acknowledge_alert("due", current)
            else:
                await server.mark_reminder("r1", body, current)
        assert rejected.value.status_code == expected
        assert not db.medication_logs.rows
        assert db.medication_occurrences.rows[0]["acknowledged"] is False
    asyncio.run(scenario())


def test_escalation_receipt_is_not_a_taken_assertion(monkeypatch):
    async def scenario():
        db, _ = setup_occurrence(monkeypatch)
        assert await server.acknowledge_alert("escalated", actor("owner")) == {"ok": True}
        assert not db.medication_logs.rows
        assert db.reminders.rows[0]["taken"] is False
        assert db.medication_occurrences.rows[0]["acknowledged"] is False
        assert db.alerts.rows[1]["acknowledged"] is True
    asyncio.run(scenario())


@pytest.mark.parametrize("path", ["/api/reminders/r1/mark", "/api/alerts/due/ack"])
def test_http_authentication_is_still_required_after_escalation(monkeypatch, path):
    async def scenario():
        db, body = setup_occurrence(monkeypatch)
        monkeypatch.setattr(server.app, "dependency_overrides", {})
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=server.app), base_url="http://test",
        ) as client:
            response = await client.post(
                path, json=body.model_dump(),
                headers={"Authorization": "Bearer not-a-jwt"},
            )
        assert response.status_code == 401
        assert not db.medication_logs.rows
        assert db.medication_occurrences.rows[0]["acknowledged"] is False
    asyncio.run(scenario())


def test_sos_trigger_resolve_and_acknowledge_remain_independent_of_medication(monkeypatch):
    async def scenario():
        db, _ = setup_occurrence(monkeypatch)
        db.members.rows[0]["name"] = "Test Member"
        pushes = []

        async def push(*args, **kwargs):
            pushes.append(args[3])
            return 1

        async def sms(*args, **kwargs):
            return []

        monkeypatch.setattr(server, "push_to_family_group", push)
        monkeypatch.setattr(server.sms, "send_sms_to_many", sms)
        before_tasks = set(server._BG_TASKS)
        response = await server.trigger_sos(
            server.SOSRequest(member_id="m1", latitude=33.0, longitude=-112.0),
            actor(),
        )
        assert response["ok"] is True
        await asyncio.gather(*(set(server._BG_TASKS) - before_tasks))
        assert [data["type"] for data in pushes] == ["request_location_refresh", "sos"]
        sos_id = response["alert_id"]
        assert (await server.resolve_alert(sos_id, actor("owner")))["ok"] is True
        assert (await server.resolve_alert(sos_id, actor("owner")))["already_resolved"] is True
        assert await server.acknowledge_alert(sos_id, actor("owner")) == {"ok": True}
        assert len([data for data in pushes if data["type"] == "alert_resolved"]) == 1
        assert not db.medication_logs.rows
        assert db.medication_occurrences.rows[0]["acknowledged"] is False
    asyncio.run(scenario())
