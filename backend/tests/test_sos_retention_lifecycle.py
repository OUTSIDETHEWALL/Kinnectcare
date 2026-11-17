"""SOS TTL eligibility on an owned loopback replica, never production.

Uses the production Mongo selector (resolved_at exists/date), without waiting
for the TTL monitor or changing any production indexes or records.
"""
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from test_email_links_mongo_integration import (
    local_replica, scenario, pytestmark,
)
import family_write_fence as fw


async def assert_active_without_expiry(db, alert_id, returned):
    stored = await db.alerts.find_one({"id": alert_id})
    assert stored["resolved"] is False
    assert "resolved_at" not in stored
    assert "resolved_at" not in returned
    assert await db.alerts.count_documents({
        "id": alert_id, "resolved_at": {"$exists": True, "$type": "date"},
    }) == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("old_date", [None, datetime(2020, 1, 1, tzinfo=timezone.utc)])
async def test_new_active_sos_cannot_inherit_expiration(scenario, old_date):
    s = scenario
    row, _ = await fw.persist_sos(s.db, {
        "id": "new-sos", "type": "sos", "resolved": False, "resolved_at": old_date,
        "message": "Synthetic emergency",
    }, "invitee")
    await assert_active_without_expiry(s.db, row["id"], row)
    assert row["message"] == "Synthetic emergency"


@pytest.mark.asyncio
@pytest.mark.parametrize("already_active", [False, True])
async def test_reopen_atomically_removes_old_ttl_date_and_retries(scenario, already_active):
    s = scenario
    original_date = datetime.now(timezone.utc) - timedelta(days=40)
    original = {
        "id": "incident", "type": "sos", "owner_id": "invitee",
        "member_id": "self", "family_group_id": "solo",
        "resolved": not already_active, "resolved_at": original_date,
        "message": "Keep history", "latitude": 12.34,
    }
    await s.db.alerts.insert_one(dict(original))
    updates = {"resolved": False, "resolved_at": original_date}
    reopened, changed = await fw.change_sos_resolution(
        s.db, "solo", "incident", "invitee", updates,
    )
    assert changed is True
    await assert_active_without_expiry(s.db, "incident", reopened)
    assert updates == {"resolved": False, "resolved_at": original_date}
    assert reopened["message"] == original["message"]
    assert reopened["latitude"] == original["latitude"]
    retry, changed = await fw.change_sos_resolution(
        s.db, "solo", "incident", "invitee", {"resolved": False},
    )
    assert changed is False
    await assert_active_without_expiry(s.db, "incident", retry)


@pytest.mark.asyncio
@pytest.mark.parametrize("explicit_timestamp", [False, True])
async def test_resolution_dates_then_reopening_and_reresolution_reset_retention(scenario, explicit_timestamp):
    s = scenario
    await fw.persist_sos(s.db, {
        "id": "incident", "type": "sos", "resolved": False,
    }, "invitee")
    before = datetime.now(timezone.utc)
    updates = {"resolved": True, "acknowledged": True}
    if explicit_timestamp:
        updates["resolved_at"] = before
    resolved, changed = await fw.change_sos_resolution(
        s.db, "solo", "incident", "invitee", updates,
    )
    assert changed is True
    assert before <= resolved["resolved_at"] <= datetime.now(timezone.utc)
    assert (resolved["resolved_at"] + timedelta(days=30)) >= before + timedelta(days=30)
    assert await s.db.alerts.count_documents({
        "id": "incident", "resolved_at": {"$exists": True, "$type": "date"},
    }) == 1
    stored = await s.db.alerts.find_one({"id": "incident"})
    first_date = stored["resolved_at"]
    retry, changed = await fw.change_sos_resolution(
        s.db, "solo", "incident", "invitee",
        {"resolved": True, "resolved_at": before + timedelta(minutes=1)},
    )
    assert changed is False
    assert retry["resolved_at"] == first_date
    reopened, _ = await fw.change_sos_resolution(
        s.db, "solo", "incident", "invitee", {"resolved": False},
    )
    await assert_active_without_expiry(s.db, "incident", reopened)
    next_date = datetime.now(timezone.utc) + timedelta(seconds=1)
    again, changed = await fw.change_sos_resolution(
        s.db, "solo", "incident", "invitee",
        {"resolved": True, "resolved_at": next_date},
    )
    assert changed is True and again["resolved_at"] == next_date
    assert again["acknowledged"] is True


@pytest.mark.asyncio
async def test_unauthorized_reopen_cannot_clear_retention(scenario):
    s = scenario
    old_date = datetime.now(timezone.utc) - timedelta(days=1)
    await s.db.alerts.insert_one({
        "id": "incident", "type": "sos", "owner_id": "owner", "member_id": "owner",
        "family_group_id": "target", "resolved": True, "resolved_at": old_date,
    })
    # Invitee is currently in solo, not the incident's family.
    original = await s.db.alerts.find_one({"id": "incident"})
    with pytest.raises(HTTPException) as error:
        await fw.change_sos_resolution(
            s.db, "target", "incident", "invitee", {"resolved": False},
        )
    assert error.value.status_code == 409
    assert await s.db.alerts.find_one({"id": "incident"}) == original
