"""Deletion/storage/access regressions: real disposable Mongo; never live sends."""
import copy
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from test_email_links_mongo_integration import local_replica, scenario, pytestmark
from test_family_code_rotation import loopback_only
from account_deletion_support import (
    account_client, bearer, cleanup, delete, execute, records, seed_care, sh,
)


@pytest.mark.asyncio
async def test_care_heavy_account_deletes_complete_owned_scope_without_other_person_data(scenario):
    s = scenario
    await seed_care(s)
    before = await records(s.db)
    async with account_client(s) as client:
        response = await delete(client.http)
        assert response.status_code == 200, response.text
        assert response.json()["deleted"]["users"] == 1
        assert response.json()["stripe_subscription_canceled"] is True
        assert client.billing == [("subscription", "synthetic-sub"), ("customer", "synthetic-customer")]
        # A retained JWT cannot reach the actual family-information route.
        denied = await client.http.get("/api/family-group")
        assert denied.status_code == 401, denied.text
        repeated = await delete(client.http)
        assert repeated.status_code == 401
        assert len(client.billing) == 2
    after = await records(s.db)
    for name, rows in before.items():
        other_rows = [row for row in rows if row.get("family_group_id") in ("target", "unrelated")
                      and row.get("invitee_email") != "invitee@example.com"]
        for row in other_rows:
            assert row in after.get(name, []), (name, row)
    for name in ("med_notifications", "medication_occurrences", "checkin_requests",
                 "checkin_deliveries", "location_history", "location_ingest_log",
                 "recovery_push_evidence", "family_members", "otp_codes", "email_links",
                 "deletion_deliveries"):
        assert await s.db[name].count_documents({}) == 0, name
    identity = await s.db.email_link_identities.find_one({})
    assert identity == {"_id": cleanup.hashlib.sha256(b"invitee@example.com").hexdigest(),
                        "generation": 2, "deletion_generation": 1}
    assert not await s.db.users.find_one({"id": "invitee"})
    assert not await s.db.members.find_one({"user_id": "invitee"})
    assert not await s.db.family_groups.find_one({"id": "solo"})


@pytest.mark.asyncio
async def test_billing_failure_preserves_existing_best_effort_contract(scenario):
    await seed_care(scenario)
    async with account_client(scenario, billing_failure=True) as client:
        response = await delete(client.http)
        assert response.status_code == 200, response.text
        assert response.json()["stripe_subscription_canceled"] is False
        assert response.json()["stripe_customer_deleted"] is False
        assert len(client.billing) == 2
    assert not await scenario.db.users.find_one({"id": "invitee"})


@pytest.mark.parametrize("confirmation", ["", "NO", None])
@pytest.mark.asyncio
async def test_confirmation_is_required_before_any_mutation(scenario, confirmation):
    before = await records(scenario.db)
    async with account_client(scenario) as client:
        response = await delete(client.http, confirmation)
        assert response.status_code == 400
        assert client.billing == []
    assert await records(scenario.db) == before


@pytest.mark.parametrize("token", ["", "invalid", "deleted"])
@pytest.mark.asyncio
async def test_real_authentication_cannot_delete_with_missing_or_stale_identity(scenario, token):
    before = await records(scenario.db)
    async with account_client(scenario, token=bearer("gone") if token == "deleted" else token) as client:
        response = await delete(client.http)
        assert response.status_code in (401, 403), response.text
    assert await records(scenario.db) == before


@pytest.mark.parametrize("resolved", [False, None, 1, "true"])
@pytest.mark.asyncio
async def test_active_or_ambiguous_sos_blocks_deletion_without_partial_cleanup(scenario, resolved):
    await seed_care(scenario)
    await scenario.db.alerts.insert_one({
        "id": "active-sos", "owner_id": "invitee", "member_id": "self",
        "family_group_id": "solo", "type": "sos", "resolved": resolved,
    })
    before = await records(scenario.db)
    async with account_client(scenario) as client:
        response = await delete(client.http)
        assert response.status_code == 409, response.text
        assert client.billing == []
    assert await records(scenario.db) == before


@pytest.mark.parametrize("subject", ["invitee", "self"])
@pytest.mark.asyncio
async def test_resolved_sos_is_unchanged_in_original_scope_and_no_longer_accessible(scenario, subject):
    await seed_care(scenario)
    now = datetime.now(timezone.utc)
    row = {"id": "retained-sos", "owner_id": "invitee", "member_id": subject,
           "family_group_id": "solo", "type": "sos", "resolved": True,
           "created_at": now - timedelta(days=2), "resolved_at": now - timedelta(days=1)}
    await scenario.db.alerts.insert_one(copy.deepcopy(row))
    original = await scenario.db.alerts.find_one({"id": "retained-sos"})
    async with account_client(scenario) as client:
        response = await delete(client.http)
        assert response.status_code == 200, response.text
    assert await scenario.db.alerts.find_one({"id": "retained-sos"}) == original
    archived = await scenario.db.family_groups.find_one({"id": "solo"})
    assert archived["owner_user_id"] is None and archived["name"] == "Archived family"
    assert "invite_code" not in archived
    with pytest.raises(HTTPException) as denied:
        await sh.own_history(scenario.db, "invitee")
    assert denied.value.status_code == 401


@pytest.mark.parametrize("obstacle", [
    "another-member", "dependent", "other-owner-reminder", "other-subject-log",
    "ambiguous-subject", "ambiguous-reminder", "foreign-med-family",
    "unproven-legacy-med", "foreign-welfare", "other-patient-welfare",
])
@pytest.mark.asyncio
async def test_unresolved_authority_is_not_mistaken_for_owned_history(scenario, obstacle):
    db = scenario.db
    await seed_care(scenario)
    if obstacle == "another-member":
        await db.users.insert_one({"id": "another", "family_group_id": "solo"})
    elif obstacle == "dependent":
        await db.members.insert_one({"id": "dependent", "owner_id": "invitee", "family_group_id": "solo"})
    elif obstacle == "other-owner-reminder":
        await db.reminders.update_one({"id": "reminders"}, {"$set": {"owner_id": "other"}})
    elif obstacle == "other-subject-log":
        await db.medication_logs.update_one({"id": "medication_logs"}, {"$set": {"member_id": "someone-else"}})
    elif obstacle == "ambiguous-subject":
        await db.members.insert_one({"id": "self", "user_id": "other", "family_group_id": "target"})
    elif obstacle == "ambiguous-reminder":
        await db.reminders.insert_one({"id": "reminders", "member_id": "other", "family_group_id": "target"})
    elif obstacle == "foreign-med-family":
        await db.med_notifications.update_one({}, {"$set": {"family_group_id": "target"}})
    elif obstacle == "unproven-legacy-med":
        await db.med_notifications.update_one({}, {"$set": {"reminder_id": "missing"}, "$unset": {"family_group_id": ""}})
    elif obstacle == "foreign-welfare":
        await db.checkin_requests.update_one({}, {"$set": {"family_group_id": "target"}})
    elif obstacle == "other-patient-welfare":
        await db.checkin_requests.update_one({}, {"$set": {"member_id": "someone-else", "target_user_id": "other"}})
    before = await records(db)
    async with account_client(scenario) as client:
        response = await delete(client.http)
        assert response.status_code == 409, (obstacle, response.text)
        assert client.billing == []
    assert await records(db) == before


@pytest.mark.parametrize("collection,field", [
    ("medication_occurrences", "family_state"), ("med_notifications", "delivery_state"),
    ("checkin_deliveries", "state"), ("checkin_requests", "response_notification_status"),
])
@pytest.mark.asyncio
async def test_reserved_send_must_settle_before_deletion(scenario, collection, field):
    await seed_care(scenario)
    await scenario.db[collection].update_one({}, {"$set": {field: "sending"}})
    before = await records(scenario.db)
    async with account_client(scenario) as client:
        denied = await delete(client.http)
        assert denied.status_code == 409, denied.text
        assert await records(scenario.db) == before
        await scenario.db[collection].update_one({}, {"$set": {field: "unknown"}})
        completed = await delete(client.http)
        assert completed.status_code == 200, completed.text


@pytest.mark.parametrize("family", [None, "missing-family"])
@pytest.mark.asyncio
async def test_empty_incomplete_account_deletes_without_provisioning_a_family(scenario, family):
    db = scenario.db
    for name in ("members", "reminders", "checkins", "alerts", "medication_logs"):
        await db[name].delete_many({"owner_id": "invitee"})
    await db.users.update_one({"id": "invitee"}, {"$set": {"family_group_id": family}})
    before = await db.family_groups.find({}).to_list(20)
    async with account_client(scenario) as client:
        response = await delete(client.http)
        assert response.status_code == 200, response.text
    assert await db.family_groups.find({}).to_list(20) == before


@pytest.mark.asyncio
async def test_nonowner_deletion_preserves_other_members_and_current_owner(scenario):
    await seed_care(scenario)
    await scenario.db.family_groups.update_one({"id": "solo"}, {"$set": {"owner_user_id": "owner"}})
    await scenario.db.users.update_one({"id": "owner"}, {"$set": {"family_group_id": "solo"}})
    before = await scenario.db.users.find_one({"id": "owner"})
    async with account_client(scenario) as client:
        response = await delete(client.http)
        assert response.status_code == 200, response.text
    assert await scenario.db.users.find_one({"id": "owner"}) == before
    assert (await scenario.db.family_groups.find_one({"id": "solo"}))["owner_user_id"] == "owner"


@pytest.mark.asyncio
async def test_old_email_link_cannot_authenticate_even_after_same_mailbox_recreates(scenario):
    await seed_care(scenario)
    token = "2" * 64
    await scenario.db.email_links.delete_one({"_id": "3" * 64})
    await scenario.db.email_links.insert_one({
        "_id": __import__("email_links").digest(token), "email": "invitee@example.com",
        "issued_user_id": "invitee", "challenge": __import__("email_links").digest("1" * 64),
        "expires_at": datetime.now(timezone.utc) + timedelta(minutes=10), "used": False,
    })
    async with account_client(scenario) as client:
        assert (await delete(client.http)).status_code == 200
        await scenario.db.users.insert_one({"id": "replacement", "email": "invitee@example.com",
                                           "family_group_id": "target"})
        response = await client.http.post("/api/auth/email-link/verify", json={
            "token": token, "verifier": "1" * 64,
        })
        assert response.status_code == 410, response.text
        assert (await client.http.get("/api/family-group")).status_code == 401
