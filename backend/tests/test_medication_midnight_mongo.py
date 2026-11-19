"""Real loopback-only Mongo coordination for the midnight scheduler path."""
import asyncio
import uuid
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from motor.motor_asyncio import AsyncIOMotorClient

from test_email_links_mongo_integration import local_replica, pytestmark
import med_scheduler as scheduler


@pytest_asyncio.fixture
async def midnight_db(local_replica):
    assert local_replica.startswith("mongodb://127.0.0.1:")
    client = AsyncIOMotorClient(local_replica, tz_aware=True)
    db = client["disposable_midnight_" + uuid.uuid4().hex]
    try:
        await db.family_groups.insert_one({"id": "g1", "owner_user_id": "owner"})
        await db.users.insert_one({"id": "owner", "family_group_id": "g1", "timezone": "UTC"})
        await db.members.insert_one({
            "id": "m1", "owner_id": "owner", "family_group_id": "g1",
            "user_id": "owner", "name": "Synthetic Patient",
        })
        await db.reminders.insert_one({
            "id": "r1", "member_id": "m1", "owner_id": "owner", "family_group_id": "g1",
            "category": "medication", "title": "Synthetic dose", "times": [{"time": "23:50"}],
        })
        await scheduler.ensure_indexes(db)
        yield db
    finally:
        await client.drop_database(db.name)
        client.close()


@pytest.mark.asyncio
async def test_real_concurrent_midnight_workers_and_restart(midnight_db):
    db = midnight_db
    pushes = []
    now = datetime(2026, 12, 1, 0, 5, tzinfo=timezone.utc)

    async def push(*args):
        pushes.append(args)
        await asyncio.sleep(0.02)
        return {"outcome": "accepted", "accepted_ticket_ids": ["synthetic-ticket"]}

    async def tick(when):
        return await scheduler.process_pending_notifications(
            db, now_utc=when, push_to_user=push, push_to_family_group=push,
        )

    await asyncio.gather(*(tick(now) for _ in range(4)))
    # A new scan relies on database evidence, not process-local sent state.
    await tick(now + timedelta(minutes=6))
    assert len(pushes) == 1
    assert pushes[0][3]["local_date"] == "2026-11-30"
    assert await db.alerts.count_documents({"type": "medication_escalation"}) == 1
    assert await db.med_notifications.count_documents({"stage": scheduler.STAGE_FAMILY}) == 1
    state = await db.medication_occurrences.find_one({})
    assert state["family_state"] == "sent"


@pytest.mark.asyncio
async def test_real_acknowledged_previous_date_blocks_midnight_claim(midnight_db):
    db = midnight_db
    occurrence = scheduler.build_occurrence_id("r1", "m1", "23:50", "2026-11-30")
    await db.medication_occurrences.insert_one({
        "occurrence_id": occurrence, "reminder_id": "r1", "member_id": "m1",
        "slot_time": "23:50", "local_date": "2026-11-30", "family_group_id": "g1",
        "acknowledged": True, "family_claimed": False,
    })

    async def forbidden(*args):
        pytest.fail("An acknowledged midnight dose must not notify")

    await scheduler.process_pending_notifications(
        db, now_utc=datetime(2026, 12, 1, 0, 5, tzinfo=timezone.utc),
        push_to_user=forbidden, push_to_family_group=forbidden,
    )
    assert await db.alerts.count_documents({}) == 0
