"""Owned loopback Mongo tests: no patient/family apps or API polling exist."""
import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path
import subprocess
import sys
import uuid

import pytest
import pytest_asyncio
from motor.motor_asyncio import AsyncIOMotorClient

from test_email_links_mongo_integration import local_replica, pytestmark
import checkin_scheduler as scheduler
from test_medication_occurrence_reliability import server

NOW = datetime(2026, 11, 19, 9, 16, tzinfo=timezone.utc)


@pytest_asyncio.fixture
async def db(local_replica):
    assert local_replica.startswith("mongodb://127.0.0.1:")
    client = AsyncIOMotorClient(local_replica, tz_aware=True)
    database = client["disposable_checkin_" + uuid.uuid4().hex]
    try:
        await database.family_groups.insert_one({"id": "g1", "owner_user_id": "owner"})
        await database.users.insert_many([
            {"id": "owner", "family_group_id": "g1", "timezone": "UTC", "push_tokens": ["owner-token"]},
            {"id": "patient", "family_group_id": "g1", "timezone": "UTC", "push_tokens": ["patient-token"]},
            {"id": "outsider", "family_group_id": "g2", "push_tokens": ["outsider-token"]},
        ])
        await database.members.insert_one({
            "id": "m1", "family_group_id": "g1", "owner_id": "owner",
            "user_id": "patient", "name": "Synthetic Patient",
            "age": 70, "phone": "", "gender": "other", "role": "senior",
            "daily_checkin_time": "09:00", "created_at": NOW - timedelta(days=3),
        })
        await scheduler.ensure_indexes(database)
        yield database
    finally:
        await client.drop_database(database.name)
        client.close()


class Sender:
    def __init__(self, results=()):
        self.calls = []
        self.results = list(results)

    async def __call__(self, tokens, title, body, data):
        self.calls.append((tokens, title, body, data))
        if self.results:
            result = self.results.pop(0)
            if isinstance(result, Exception):
                raise result
            return result
        return {
            "transport_status": "response_received", "valid_token_count": 1,
            "tickets": [{"status": "ok", "ticket_id": "synthetic-ticket"}],
        }


async def tick(db, sender, now=NOW, quiet=lambda user: False):
    await scheduler.process_pending(db, send=sender, quiet=quiet, now=now)


@pytest.mark.asyncio
async def test_missed_checkin_detects_without_any_apps_or_read_requests(db):
    sender = Sender()
    await tick(db, sender)
    assert len(sender.calls) == 2
    assert {c[0][0] for c in sender.calls} == {"patient-token", "owner-token"}
    alert = await db.alerts.find_one({})
    assert alert["slot_key"] == "fixed_2026-11-19_09:00"
    assert alert["severity"] == "critical"
    assert not ({"latitude", "longitude", "location_name"} & set(alert))
    assert (await db.members.find_one({"id": "m1"}))["status"] == "warning"
    assert await db.checkin_deliveries.count_documents({"state": "accepted"}) == 2
    assert all("token" not in row for row in await db.checkin_deliveries.find({}).to_list(10))


@pytest.mark.asyncio
@pytest.mark.parametrize("completed_at", [
    NOW.replace(hour=8, minute=59), NOW.replace(hour=9, minute=0),
    NOW.replace(hour=9, minute=10), NOW.replace(hour=9, minute=15),
])
async def test_saved_on_time_or_late_completion_never_notifies(db, completed_at):
    await db.checkins.insert_one({
        "family_group_id": "g1", "member_id": "m1", "created_at": completed_at,
    })
    sender = Sender()
    await tick(db, sender)
    assert not sender.calls
    assert await db.alerts.count_documents({}) == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("mutation", ["disabled", "removed", "patient_left", "owner_left", "new_member"])
async def test_ineligible_members_never_generate_warning(db, mutation):
    if mutation == "disabled":
        await db.members.update_one({"id": "m1"}, {"$set": {"daily_checkin_time": None}})
    elif mutation == "removed":
        await db.members.delete_one({"id": "m1"})
    elif mutation in ("patient_left", "owner_left"):
        uid = "patient" if mutation == "patient_left" else "owner"
        await db.users.update_one({"id": uid}, {"$set": {"family_group_id": "other"}})
    else:
        await db.members.update_one({"id": "m1"}, {"$set": {"created_at": NOW - timedelta(hours=23)}})
    sender = Sender()
    await tick(db, sender)
    assert not sender.calls
    assert await db.alerts.count_documents({}) == 0


@pytest.mark.asyncio
async def test_concurrent_workers_and_read_discovery_share_one_alert_per_device(db):
    sender = Sender()
    await asyncio.gather(
        scheduler.process_family(db, "g1", now=NOW),
        *(tick(db, sender) for _ in range(3)),
    )
    await tick(db, sender)
    assert len(sender.calls) == 2
    assert await db.alerts.count_documents({}) == 1


@pytest.mark.asyncio
async def test_only_confirmed_rejection_retries_without_replaying_accepted_devices(db):
    sender = Sender([{"transport_status": "http_error", "http_status": 429}])
    await tick(db, sender)
    assert len(sender.calls) == 2
    assert await db.checkin_deliveries.count_documents({"state": "pending"}) == 1
    await tick(db, sender, NOW + timedelta(seconds=30))
    assert len(sender.calls) == 2
    await tick(db, sender, NOW + timedelta(minutes=1))
    assert len(sender.calls) == 3
    await tick(db, sender, NOW + timedelta(minutes=2))
    assert len(sender.calls) == 3
    assert await db.checkin_deliveries.count_documents({"state": "accepted"}) == 2
    assert await db.alerts.count_documents({}) == 1


@pytest.mark.asyncio
async def test_per_ticket_rate_rejection_retries(db):
    sender = Sender([{
        "transport_status": "response_received",
        "tickets": [{"status": "error", "error": "MessageRateExceeded"}],
    }])
    await tick(db, sender)
    await tick(db, sender, NOW + timedelta(minutes=1))
    assert len(sender.calls) == 3
    assert await db.checkin_deliveries.count_documents({"state": "accepted"}) == 2


@pytest.mark.asyncio
async def test_uncertain_send_and_crash_attempt_are_not_blindly_resent(db):
    sender = Sender([RuntimeError("provider result unknown")])
    await tick(db, sender)
    await tick(db, sender, NOW + timedelta(minutes=3))
    assert len(sender.calls) == 2
    assert await db.checkin_deliveries.count_documents({"state": "unknown"}) == 1
    # Simulate process death after reservation and before a saved completion.
    await db.checkin_deliveries.update_many({}, {"$set": {
        "state": "sending", "attempted_at": NOW, "attempt_id": "dead-worker",
    }})
    await tick(db, sender, NOW + timedelta(minutes=4))
    assert len(sender.calls) == 2
    assert await db.checkin_deliveries.count_documents({"state": "unknown"}) == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("change", [
    "completed", "disabled", "removed", "patient_left", "recipient_left",
    "quiet", "acknowledged", "settings_generation", "token_removed",
])
async def test_queued_delivery_revalidates_authority_settings_and_preferences(db, change):
    await scheduler.process_family(db, "g1", now=NOW)
    quiet = lambda user: change == "quiet"
    if change == "completed":
        await db.checkins.insert_one({"family_group_id": "g1", "member_id": "m1", "created_at": NOW})
    elif change == "disabled":
        await db.members.update_one({"id": "m1"}, {"$set": {"daily_checkin_time": None}})
    elif change == "removed":
        await db.members.delete_one({"id": "m1"})
    elif change == "patient_left":
        await db.users.update_one({"id": "patient"}, {"$set": {"family_group_id": "g2"}})
    elif change == "recipient_left":
        await db.users.update_one({"id": "owner"}, {"$set": {"family_group_id": "g2"}})
    elif change == "acknowledged":
        await db.alerts.update_many({}, {"$set": {"acknowledged": True}})
    elif change == "settings_generation":
        await db.members.update_one({"id": "m1"}, {"$inc": {"checkin_settings_generation": 2}})
    elif change == "token_removed":
        await db.users.update_many({}, {"$set": {"push_tokens": []}})
    sender = Sender()
    await tick(db, sender, NOW + timedelta(seconds=30), quiet=quiet)
    assert not sender.calls
    assert await db.checkin_deliveries.count_documents({"state": "suppressed"}) == 2


@pytest.mark.asyncio
async def test_patient_timezone_not_the_polling_caregivers_timezone(db):
    await db.users.update_one({"id": "owner"}, {"$set": {"timezone": "Asia/Tokyo"}})
    await db.users.update_one({"id": "patient"}, {"$set": {"timezone": "America/Phoenix"}})
    sender = Sender()
    await tick(db, sender, datetime(2026, 11, 19, 16, 15, tzinfo=timezone.utc))
    alert = await db.alerts.find_one({})
    assert alert["slot_key"] == "fixed_2026-11-19_09:00"
    assert "(America/Phoenix)" in alert["message"]
    assert len(sender.calls) == 2


@pytest.mark.asyncio
async def test_departed_caregiver_excluded_without_suppressing_authorized_family(db):
    await db.users.insert_one({
        "id": "caregiver", "family_group_id": "g1", "push_tokens": ["caregiver-token"],
    })
    await scheduler.process_family(db, "g1", now=NOW)
    await db.users.update_one({"id": "caregiver"}, {"$set": {"family_group_id": "g2"}})
    sender = Sender()
    await tick(db, sender)
    assert {c[0][0] for c in sender.calls} == {"patient-token", "owner-token"}
    assert await db.checkin_deliveries.count_documents({"state": "suppressed"}) == 1


@pytest.mark.asyncio
async def test_shared_registered_device_receives_one_notification(db):
    await db.users.update_one({"id": "patient"}, {"$push": {"push_tokens": "owner-token"}})
    sender = Sender()
    await tick(db, sender)
    assert len(sender.calls) == 2
    assert {c[0][0] for c in sender.calls} == {"patient-token", "owner-token"}


@pytest.mark.asyncio
async def test_deleted_family_cancels_queued_deliveries(db):
    await scheduler.process_family(db, "g1", now=NOW)
    await db.family_groups.delete_one({"id": "g1"})
    sender = Sender()
    await tick(db, sender)
    assert not sender.calls
    assert await db.checkin_deliveries.count_documents({"state": "suppressed"}) == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("route", ["generic", "settings"])
async def test_supported_routes_do_not_create_retroactive_schedule_alerts(db, monkeypatch, route):
    monkeypatch.setattr(server, "db", db)
    activation = NOW.replace(hour=8, minute=0)

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return activation if tz else activation.replace(tzinfo=None)

    monkeypatch.setattr(server, "datetime", Clock)
    current = {"id": "owner", "family_group_id": "g1"}
    await db.members.update_one({"id": "m1"}, {"$set": {"daily_checkin_time": None}})
    if route == "generic":
        await server.update_member("m1", server.FamilyMemberUpdate(daily_checkin_time="09:00"), current)
    else:
        await server.update_checkin_settings("m1", server.CheckinSettings(daily_checkin_time="09:00"), current)
    member = await db.members.find_one({"id": "m1"})
    assert member["checkin_settings_generation"] == 1
    assert member["checkin_settings_effective_at"] == activation
    sender = Sender()
    await tick(db, sender, activation + timedelta(minutes=1))
    assert not sender.calls
    assert await db.alerts.count_documents({}) == 0
    await tick(db, sender, NOW)
    assert len(sender.calls) == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("route", ["generic", "settings"])
async def test_both_routes_disable_reenable_invalidates_queued_delivery(db, monkeypatch, route):
    monkeypatch.setattr(server, "db", db)
    await scheduler.process_family(db, "g1", now=NOW)

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return NOW if tz else NOW.replace(tzinfo=None)

    monkeypatch.setattr(server, "datetime", Clock)
    current = {"id": "owner", "family_group_id": "g1"}
    if route == "generic":
        await server.update_member("m1", server.FamilyMemberUpdate(daily_checkin_time=None), current)
        await server.update_member("m1", server.FamilyMemberUpdate(daily_checkin_time="09:00"), current)
    else:
        await server.update_checkin_settings("m1", server.CheckinSettings(), current)
        await server.update_checkin_settings("m1", server.CheckinSettings(daily_checkin_time="09:00"), current)
    assert (await db.members.find_one({"id": "m1"}))["checkin_settings_generation"] == 2
    sender = Sender()
    await tick(db, sender)
    assert not sender.calls
    assert await db.checkin_deliveries.count_documents({"state": "suppressed"}) == 2


@pytest.mark.asyncio
async def test_disabling_settings_serializes_before_delivery_reservation(db, monkeypatch):
    await scheduler.process_family(db, "g1", now=NOW)
    entered, release = asyncio.Event(), asyncio.Event()
    real = scheduler.fw.actor_in_family
    paused = False

    async def pause_after_fence(*args, **kwargs):
        nonlocal paused
        result = await real(*args, **kwargs)
        if not paused:
            paused = True
            entered.set()
            await asyncio.wait_for(release.wait(), 5)
        return result

    monkeypatch.setattr(scheduler.fw, "actor_in_family", pause_after_fence)
    disable = asyncio.create_task(scheduler.update_settings(
        db, "m1", {"id": "owner", "family_group_id": "g1"},
        {"daily_checkin_time": None, "checkin_interval_hours": None}, NOW,
    ))
    await asyncio.wait_for(entered.wait(), 5)
    sender = Sender()
    row = await db.checkin_deliveries.find_one({})
    pending = asyncio.create_task(scheduler.deliver_one(
        db, row, now=NOW, send=sender, quiet=lambda user: False,
    ))
    await asyncio.sleep(0.05)
    assert not sender.calls
    release.set()
    await disable
    await pending
    assert not sender.calls
    await tick(db, sender)
    assert not sender.calls


@pytest.mark.asyncio
@pytest.mark.parametrize("now,slot,expected", [
    ("2026-02-01T00:05:00+00:00", "23:50", "fixed_2026-01-31_23:50"),
    ("2027-01-01T00:14:00+00:00", "23:59", "fixed_2026-12-31_23:59"),
    ("2026-03-08T07:05:00+00:00", "01:50", "fixed_2026-03-08_01:50"),
    ("2026-11-01T06:05:00+00:00", "01:50", "fixed_2026-11-01_01:50"),
])
async def test_fixed_calendar_and_dst_boundaries(db, now, slot, expected):
    now = datetime.fromisoformat(now)
    tz = "America/New_York" if slot == "01:50" else "UTC"
    await db.users.update_one({"id": "patient"}, {"$set": {"timezone": tz}})
    await db.members.update_one({"id": "m1"}, {"$set": {
        "daily_checkin_time": slot, "created_at": now - timedelta(days=3),
    }})
    sender = Sender()
    await tick(db, sender, now)
    assert (await db.alerts.find_one({}))["slot_key"] == expected
    assert len(sender.calls) == 2


@pytest.mark.asyncio
async def test_interval_grace_completion_and_restart_recovery(db):
    await db.members.update_one({"id": "m1"}, {"$set": {
        "daily_checkin_time": None, "checkin_interval_hours": 2,
        "checkin_interval_started_at": NOW - timedelta(hours=2, minutes=15),
    }})
    sender = Sender()
    await tick(db, sender, NOW - timedelta(seconds=1))
    assert not sender.calls
    await tick(db, sender, NOW)
    assert len(sender.calls) == 2
    await tick(db, sender, NOW)
    assert len(sender.calls) == 2


@pytest.mark.asyncio
async def test_existing_legacy_alert_never_replays_a_potentially_sent_push(db):
    await db.alerts.insert_one({
        "id": "legacy", "family_group_id": "g1", "member_id": "m1",
        "type": "missed_checkin", "slot_key": "fixed_2026-11-19_09:00",
    })
    sender = Sender()
    await tick(db, sender)
    assert not sender.calls
    assert await db.alerts.count_documents({}) == 1


@pytest.mark.asyncio
async def test_actual_worker_loop_detects_without_any_client_requests(db, monkeypatch):
    real = scheduler.process_pending
    sent = asyncio.Event()
    sender = Sender()

    async def send(*args):
        result = await sender(*args)
        sent.set()
        return result

    async def fixed_tick(database, **kwargs):
        return await real(database, now=NOW, **kwargs)

    monkeypatch.setattr(scheduler, "process_pending", fixed_tick)
    worker = scheduler.CheckinScheduler(db, send=send, quiet=lambda user: False)
    worker.start()
    try:
        await asyncio.wait_for(sent.wait(), 5)
    finally:
        # Allow the current two-recipient batch to settle before shutdown.
        await asyncio.wait_for(worker.stop(), 5)
    assert sender.calls
    assert await db.alerts.count_documents({}) == 1


@pytest.mark.asyncio
async def test_fresh_python_process_recovers_persisted_outbox(db, local_replica):
    await scheduler.process_family(db, "g1", now=NOW)
    code = """
import asyncio,socket,sys
sys.path.insert(0,sys.argv[3])
original=socket.socket.connect
def guarded(self,address):
    if isinstance(address,tuple) and address[0] not in ('127.0.0.1','::1'):
        raise RuntimeError('External network forbidden')
    return original(self,address)
socket.socket.connect=guarded
from motor.motor_asyncio import AsyncIOMotorClient
from datetime import datetime
import checkin_scheduler
async def main():
    client=AsyncIOMotorClient(sys.argv[1],tz_aware=True)
    count=0
    async def send(*args):
        nonlocal count
        count+=1
        return {'transport_status':'response_received','tickets':[{'status':'ok','ticket_id':'synthetic'}]}
    await checkin_scheduler.process_pending(client[sys.argv[2]],send=send,quiet=lambda u:False,now=datetime.fromisoformat(sys.argv[4]))
    print(count)
    client.close()
asyncio.run(main())
"""
    def child():
        return subprocess.run(
            [sys.executable, "-c", code, local_replica, db.name,
             str(Path(__file__).resolve().parents[1]), NOW.isoformat()],
            capture_output=True, text=True, check=True, timeout=15,
        ).stdout.strip()

    assert await asyncio.to_thread(child) == "2"
    assert await asyncio.to_thread(child) == "0"
