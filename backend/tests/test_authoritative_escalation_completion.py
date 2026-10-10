"""Deterministic send/recovery interleavings; never uses network or Mongo."""
import asyncio
from copy import deepcopy
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from test_medication_occurrence_reliability import DB, med_scheduler, server
from medication_delivery import send_verified_escalation

NOW = datetime(2026, 9, 12, 14, 15, tzinfo=timezone.utc)
PROOF = {"outcome": "accepted", "accepted_ticket_ids": ["ticket-1"]}


def _run(coro):
    # asyncio.run() clears the ambient loop used by older synchronous tests.
    # An explicit loop factory lets these tests own/close only their own loop.
    with asyncio.Runner(loop_factory=asyncio.new_event_loop) as runner:
        return runner.run(coro)


def setup(monkeypatch):
    db = DB([{
        "id": "r1", "owner_id": "owner", "family_group_id": "g1",
        "member_id": "m1", "member_name": "Test Member", "title": "Test Medication",
        "category": "medication", "times": [{"time": "14:00"}],
        "status": "pending", "taken": False,
    }])
    db.members.rows.append({
        "id": "m1", "owner_id": "owner", "family_group_id": "g1",
        "user_id": "senior", "name": "Test Member",
    })
    db.users.rows.append({"id": "owner", "timezone": "UTC"})
    monkeypatch.setattr(server, "db", db)
    monkeypatch.setattr(server, "_med_scheduler_ready", True)
    oid = med_scheduler.build_occurrence_id("r1", "m1", "14:00", "2026-09-12")
    body = server.ReminderMark(
        status="taken", member_id="m1", slot_time="14:00",
        local_date="2026-09-12", occurrence_id=oid,
    )
    db.alerts.rows.append({
        "id": "due", "family_group_id": "g1", "member_id": "m1",
        "type": "medication", "self_due": True, "reminder_id": "r1",
        "scheduled_time": "14:00", "local_date": "2026-09-12",
        "occurrence_id": oid, "acknowledged": False,
    })
    return db, body


async def tick(db, push, now=NOW):
    return await med_scheduler.process_pending_notifications(
        db, push_to_user=lambda *a: asyncio.sleep(0),
        push_to_family_group=push, now_utc=now,
    )


async def acknowledge(body, path):
    current = {"id": "senior" if path == "recipient" else "owner",
               "family_group_id": "g1", "timezone": "UTC"}
    if path == "recipient":
        return await server.mark_reminder("r1", body, current)
    return await server.acknowledge_alert("due", current)


@pytest.mark.parametrize("path", ["recipient", "owner_alert"])
@pytest.mark.parametrize("age_minutes", [0, 6])
def test_live_sender_remains_exclusive_then_late_taken_succeeds(monkeypatch, path, age_minutes):
    async def scenario():
        db, body = setup(monkeypatch)
        entered, release = asyncio.Event(), asyncio.Event()
        calls = []

        async def push(*args, **kwargs):
            calls.append(args)
            entered.set()
            await release.wait()
            return deepcopy(PROOF)

        first = asyncio.create_task(tick(db, push))
        try:
            await asyncio.wait_for(entered.wait(), 2)
            original_token = db.medication_occurrences.rows[0]["family_claim_token"]
            await tick(db, push, NOW + timedelta(minutes=age_minutes))
            state = db.medication_occurrences.rows[0]
            assert state["family_state"] == "sending"
            assert state["family_claim_token"] == original_token
            assert not state.get("family_send_completed")
            assert db.med_notifications.rows[0]["delivery_state"] == "sending"
            with pytest.raises(HTTPException) as blocked:
                await acknowledge(body, path)
            assert blocked.value.status_code == 409
            assert not db.medication_logs.rows
        finally:
            release.set()
            await first
        assert db.medication_occurrences.rows[0]["family_state"] == "sent"
        assert db.medication_occurrences.rows[0]["family_send_completed"] is True
        history = deepcopy(db.med_notifications.rows)
        for _ in range(2):
            assert (await acknowledge(body, path))["status"] == "taken"
        await tick(db, push, NOW + timedelta(minutes=10))
        assert len(calls) == len(db.med_notifications.rows) == 1
        assert db.med_notifications.rows == history
        assert [log["status"] for log in db.medication_logs.rows] == ["taken"]
    _run(scenario())


def test_cancelled_sender_recovers_to_unknown_and_never_resends(monkeypatch):
    async def scenario():
        db, body = setup(monkeypatch)
        entered = asyncio.Event()
        calls = []

        async def push(*args, **kwargs):
            calls.append(args)
            entered.set()
            await asyncio.Event().wait()

        first = asyncio.create_task(tick(db, push))
        await asyncio.wait_for(entered.wait(), 2)
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        await tick(db, push, NOW + timedelta(minutes=6))
        assert db.medication_occurrences.rows[0]["family_state"] == "unknown"
        assert db.medication_occurrences.rows[0]["family_claimed"] is True
        await tick(db, push, NOW + timedelta(hours=2))
        assert len(calls) == 1
        for path in ("recipient", "owner_alert"):
            with pytest.raises(HTTPException):
                await acknowledge(body, path)
        assert not db.medication_logs.rows
    _run(scenario())


def test_cross_process_stale_uncertainty_fences_late_original_completion(monkeypatch):
    async def scenario():
        db, body = setup(monkeypatch)
        entered, release = asyncio.Event(), asyncio.Event()

        async def push(*args):
            entered.set()
            await release.wait()
            return deepcopy(PROOF)

        first = asyncio.create_task(tick(db, push))
        try:
            await asyncio.wait_for(entered.wait(), 2)
            token = db.medication_occurrences.rows[0]["family_claim_token"]
            # A separate process cannot consult this process's live registry.
            med_scheduler._active_family_sends.discard((id(db), token))
            await tick(db, push, NOW + timedelta(minutes=6))
            assert db.medication_occurrences.rows[0]["family_state"] == "unknown"
            history = deepcopy(db.med_notifications.rows)
        finally:
            release.set()
            await first
        assert db.med_notifications.rows == history
        assert db.medication_occurrences.rows[0]["family_state"] == "unknown"
        with pytest.raises(HTTPException):
            await acknowledge(body, "recipient")
    _run(scenario())


def test_saved_success_repairs_occurrence_after_finalization_crash(monkeypatch):
    async def scenario():
        db, body = setup(monkeypatch)
        finish = med_scheduler._finish_occurrence_family_claim

        async def crash(*args, **kwargs):
            raise RuntimeError("crash after durable delivery proof")

        async def push(*args, **kwargs):
            return deepcopy(PROOF)

        monkeypatch.setattr(med_scheduler, "_finish_occurrence_family_claim", crash)
        with pytest.raises(RuntimeError):
            await tick(db, push)
        assert db.med_notifications.rows[0]["delivery_state"] == "sent"
        assert db.medication_occurrences.rows[0]["family_state"] == "sending"
        monkeypatch.setattr(med_scheduler, "_finish_occurrence_family_claim", finish)
        await tick(db, push)
        assert (await acknowledge(body, "recipient"))["status"] == "taken"
        assert len(db.med_notifications.rows) == len(db.medication_logs.rows) == 1
    _run(scenario())


@pytest.mark.parametrize("result", [1, None, {"outcome": "failed", "accepted_ticket_ids": []}])
def test_attempt_counts_or_failed_sends_cannot_expose_sent(monkeypatch, result):
    async def scenario():
        db, body = setup(monkeypatch)

        async def push(*args, **kwargs):
            return result

        await tick(db, push)
        assert db.medication_occurrences.rows[0]["family_state"] in ("unknown", "failed")
        with pytest.raises(HTTPException):
            await acknowledge(body, "recipient")
        assert not db.medication_logs.rows
    _run(scenario())


def test_obsolete_sender_cannot_finalize_new_stage_or_occurrence(monkeypatch):
    async def scenario():
        db, body = setup(monkeypatch)
        await med_scheduler._claim_occurrence_for_family(
            db, occurrence_id=body.occurrence_id, reminder_id="r1", member_id="m1",
            slot_time="14:00", local_date="2026-09-12", now_utc=NOW,
        )
        db.medication_occurrences.rows[0]["family_claim_token"] = "new-owner"
        db.med_notifications.rows.append({
            "reminder_id": "r1", "member_id": "m1", "slot_time": "14:00",
            "local_date": "2026-09-12", "stage": med_scheduler.STAGE_FAMILY,
            "family_claim_token": "new-owner", "delivery_state": "sending",
        })
        before = deepcopy(db.med_notifications.rows)
        await med_scheduler._finish_family_stage(
            db, reminder_id="r1", member_id="m1", slot_time="14:00",
            local_date="2026-09-12", claim_token="obsolete", now_utc=NOW, completion=PROOF,
        )
        await med_scheduler._finish_occurrence_family_claim(db, body.occurrence_id, NOW, "obsolete")
        assert db.med_notifications.rows == before
        assert db.medication_occurrences.rows[0]["family_state"] == "sending"
    _run(scenario())


def test_legacy_sent_without_completion_evidence_remains_blocked(monkeypatch):
    async def scenario():
        db, body = setup(monkeypatch)
        db.medication_occurrences.rows.append({
            "occurrence_id": body.occurrence_id, "family_claimed": True,
            "family_state": "sent", "acknowledged": False,
        })
        with pytest.raises(HTTPException):
            await acknowledge(body, "recipient")
        assert not db.medication_logs.rows
    _run(scenario())


@pytest.mark.parametrize("transport,tickets,expected", [
    ("response_received", [{"status": "ok", "ticket_id": "accepted-id"}], "accepted"),
    ("response_received", [{"status": "error", "error": "DeviceNotRegistered"}], "failed"),
    ("response_received", [], "unknown"),
    ("exception", [], "unknown"),
])
def test_provider_evidence_not_attempt_count(monkeypatch, transport, tickets, expected):
    async def scenario():
        db, _ = setup(monkeypatch)
        db.users.rows[0]["push_tokens"] = ["synthetic-test-token"]

        async def send(*args):
            return {"valid_token_count": 1, "transport_status": transport,
                    "tickets": tickets, "dead_tokens": []}

        result = await send_verified_escalation(
            db, ["owner"], "title", "body", {}, send_with_tickets=send,
            in_quiet_hours=lambda u: False,
        )
        assert result["outcome"] == expected
        assert "synthetic-test-token" not in str(result)
    _run(scenario())


def test_real_family_dispatch_waits_for_all_recipients_and_preserves_other_pushes(monkeypatch):
    async def scenario():
        db, body = setup(monkeypatch)
        db.users.rows[0]["push_tokens"] = ["synthetic-owner"]
        db.users.rows.append({"id": "caregiver", "push_tokens": ["synthetic-caregiver"]})
        entered, release = asyncio.Event(), asyncio.Event()
        calls = []

        async def ids(*args):
            return ["owner", "caregiver"]

        async def provider(tokens, *args):
            calls.append(tokens)
            if tokens == ["synthetic-caregiver"]:
                entered.set()
                await release.wait()
            return {"transport_status": "response_received", "valid_token_count": 1,
                    "dead_tokens": [], "tickets": [{"status": "ok", "ticket_id": str(len(calls))}]}

        async def ordinary_push(*args):
            return 1

        monkeypatch.setattr(server.fg, "list_group_user_ids", ids)
        monkeypatch.setattr(server, "send_expo_push_with_tickets", provider)
        monkeypatch.setattr(server, "_is_in_quiet_hours", lambda u: False)
        monkeypatch.setattr(server, "push_to_user", ordinary_push)
        first = asyncio.create_task(tick(db, server.push_to_family_group))
        try:
            await asyncio.wait_for(entered.wait(), 2)
            await tick(db, server.push_to_family_group)
            assert db.medication_occurrences.rows[0]["family_state"] == "sending"
            with pytest.raises(HTTPException):
                await acknowledge(body, "recipient")
        finally:
            release.set()
            await first
        assert (await acknowledge(body, "recipient"))["status"] == "taken"
        assert len(calls) == 2
        assert await server.push_to_family_group("g1", "SOS", "help", {"type": "sos"}) == 2
        assert len(calls) == 2
    _run(scenario())


def test_manual_miss_after_success_retains_terminal_ownership_through_recovery(monkeypatch):
    async def scenario():
        db, body = setup(monkeypatch)

        async def push(*args):
            return deepcopy(PROOF)

        await tick(db, push)
        occurrence = await server._resolve_mark_occurrence(
            db.reminders.rows[0], body, {"timezone": "UTC"}, NOW,
        )
        result, _ = await server._arbitrate_manual_missed_occurrence(occurrence, NOW)
        assert result == "resume"
        await tick(db, push, NOW + timedelta(hours=2))
        state = db.medication_occurrences.rows[0]
        assert state["family_claimed"] is True
        assert state["family_purpose"] == "manual_miss"
        with pytest.raises(HTTPException):
            await acknowledge(body, "recipient")
        assert not db.medication_logs.rows
    _run(scenario())
