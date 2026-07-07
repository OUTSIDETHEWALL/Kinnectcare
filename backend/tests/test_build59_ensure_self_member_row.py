"""Build #59 hotfix regression — `ensure_self_member_row`.

Covers the five scenarios explicitly requested for the invitation
acceptance transaction fix:
  1. Existing placeholder member (preserve caregiver-filled fields).
  2. No placeholder member (helper must create one).
  3. Existing user joining via /family-group/join (Path A).
  4. Brand-new user joining via verify-otp with invite_token (Path B).
  5. Duplicate acceptance — idempotency.

Also asserts the "second-bug hidden behind the first" concern the
user raised: after acceptance, the caregiver's /members query and
the joiner's /members query BOTH return the new member on the very
next request — no sign-out / restart / cache-purge required.
"""
import os
import sys
import asyncio
import uuid
from datetime import datetime, timezone, timedelta

import pytest
import pytest_asyncio
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

# Repo import path — tests live alongside server.py inside /app/backend
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

import family_group as fg  # noqa: E402


# ---------- Fixture: isolated test database ----------

@pytest_asyncio.fixture
async def db():
    """Ephemeral database — dropped after each test.  Uses the same
    MONGO_URL as the running backend but under a `test_build59_*`
    database name so we can't accidentally clobber real data."""
    mongo_url = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
    client = AsyncIOMotorClient(mongo_url)
    db_name = f"test_build59_{uuid.uuid4().hex[:8]}"
    database = client[db_name]
    yield database
    await client.drop_database(db_name)
    client.close()


# ---------- Helpers ----------

def _mk_user(email="joiner@example.com", full_name="Joyce Miller"):
    return {
        "id": str(uuid.uuid4()),
        "email": email,
        "full_name": full_name,
        "created_at": datetime.now(timezone.utc),
    }


def _mk_invite(inviter_id, group_id, relationship=None, role=None,
               invitee_email="joiner@example.com"):
    return {
        "id": str(uuid.uuid4()),
        "token": f"INV-{uuid.uuid4().hex[:8].upper()}",
        "family_group_id": group_id,
        "invited_by_user_id": inviter_id,
        "inviter_name": "Charles",
        "invitee_name": "Joyce Miller",
        "invitee_email": invitee_email,
        "relationship": relationship,
        "role": role,
        "status": "pending",
        "created_at": datetime.now(timezone.utc),
        "expires_at": datetime.now(timezone.utc) + timedelta(days=7),
        "accepted_by_user_id": None,
        "accepted_at": None,
    }


# ---------- Scenario 1: existing placeholder member ----------

@pytest.mark.asyncio
async def test_existing_placeholder_is_preserved_not_clobbered(db):
    """Caregiver pre-created a placeholder member row, then invited.
    On acceptance, the pre-filled fields (age, phone, custom name)
    must be preserved — the helper must NOT overwrite them."""
    caregiver_id = str(uuid.uuid4())
    group_id = str(uuid.uuid4())
    user = _mk_user()

    placeholder = {
        "id": str(uuid.uuid4()),
        "user_id": user["id"],  # already bound by auto-bind heuristic
        "owner_id": caregiver_id,
        "family_group_id": group_id,
        "name": "Joyce M.",  # caregiver typed a custom short name
        "age": 78,            # caregiver filled in age
        "phone": "+15551234", # caregiver added phone
        "gender": "female",
        "role": "senior",
        "status": "healthy",
    }
    await db.members.insert_one(placeholder)

    result = await fg.ensure_self_member_row(db, user, group_id, invite_doc=None)

    # Same doc returned — helper detected the existing bound row.
    assert result["id"] == placeholder["id"]
    # None of the pre-filled fields were clobbered.
    assert result["name"] == "Joyce M."
    assert result["age"] == 78
    assert result["phone"] == "+15551234"
    assert result["gender"] == "female"
    assert result["role"] == "senior"

    # Only ONE row exists for this (group, user) pair.
    count = await db.members.count_documents(
        {"family_group_id": group_id, "user_id": user["id"]}
    )
    assert count == 1


# ---------- Scenario 2: no placeholder ----------

@pytest.mark.asyncio
async def test_no_placeholder_creates_fresh_row_with_invite_metadata(db):
    """Build #59 default case: no pre-created row exists.  Helper
    must insert a new row keyed to the joiner, pulling relationship
    and role from the invite so caregiver intent is preserved."""
    group_id = str(uuid.uuid4())
    user = _mk_user(full_name="Joyce Miller")
    invite = _mk_invite(str(uuid.uuid4()), group_id,
                        relationship="Mom", role="senior")

    result = await fg.ensure_self_member_row(db, user, group_id, invite_doc=invite)

    assert result["user_id"] == user["id"]
    assert result["owner_id"] == user["id"]  # joiner owns their own row
    assert result["family_group_id"] == group_id
    assert result["name"] == "Joyce Miller"
    assert result["role"] == "senior"           # from invite
    assert result["relationship"] == "Mom"      # from invite
    assert result["location_sharing_enabled"] is True
    # Placeholder demographics — safe defaults for later editing.
    assert result["age"] == 0
    assert result["phone"] == ""
    assert result["gender"] == ""

    # Row is persisted.
    saved = await db.members.find_one(
        {"family_group_id": group_id, "user_id": user["id"]}, {"_id": 0}
    )
    assert saved is not None
    assert saved["id"] == result["id"]


# ---------- Scenario 3: existing user joining via /family-group/join ----------

@pytest.mark.asyncio
async def test_existing_user_joining_gets_self_member_row(db):
    """Simulates the /family-group/join path (Path A).  Existing user
    had a solo group with no members; joins a new family group via
    an INV- token; must appear as a member of the new group."""
    caregiver_id = str(uuid.uuid4())
    target_group_id = str(uuid.uuid4())
    joiner = _mk_user(full_name="Bob Anderson")
    invite = _mk_invite(caregiver_id, target_group_id, relationship="Spouse",
                        role="family")

    # Baseline: joiner has ZERO member rows anywhere.
    assert await db.members.count_documents({"user_id": joiner["id"]}) == 0

    await fg.ensure_self_member_row(db, joiner, target_group_id, invite)

    # Exactly one row now — in the target group, bound to joiner.
    rows = await db.members.find(
        {"user_id": joiner["id"]}, {"_id": 0}
    ).to_list(10)
    assert len(rows) == 1
    assert rows[0]["family_group_id"] == target_group_id
    assert rows[0]["role"] == "family"
    assert rows[0]["relationship"] == "Spouse"
    assert rows[0]["name"] == "Bob Anderson"


# ---------- Scenario 4: brand-new user joining via verify-otp ----------

@pytest.mark.asyncio
async def test_brand_new_user_via_signup_gets_self_member_row(db):
    """Simulates the verify-otp signup path (Path B) for a fresh
    account that didn't exist before the invite acceptance.  The
    joiner has NO history whatsoever; the helper must be the sole
    thing that puts them on the caregiver's dashboard."""
    caregiver_id = str(uuid.uuid4())
    group_id = str(uuid.uuid4())
    # Brand-new user doc — just inserted into db.users a millisecond ago.
    fresh_user = _mk_user(email="new-signup@example.com",
                          full_name="Priya Patel")
    invite = _mk_invite(caregiver_id, group_id,
                        relationship="Sister", role="family",
                        invitee_email="new-signup@example.com")

    # No auto-bind happened (caregiver didn't pre-create a row).
    assert await db.members.count_documents({"family_group_id": group_id}) == 0

    result = await fg.ensure_self_member_row(db, fresh_user, group_id, invite)

    assert result["user_id"] == fresh_user["id"]
    assert result["family_group_id"] == group_id
    assert result["relationship"] == "Sister"

    # Verify caregiver's /members query would return this row.
    # (Simulate what the /members endpoint does: filter by group_id.)
    group_members = await db.members.find(
        {"family_group_id": group_id}, {"_id": 0}
    ).to_list(10)
    assert len(group_members) == 1
    assert group_members[0]["user_id"] == fresh_user["id"]


# ---------- Scenario 5: duplicate acceptance — idempotency ----------

@pytest.mark.asyncio
async def test_duplicate_acceptance_is_idempotent(db):
    """If accept-invite is called twice (deep link tapped twice, user
    force-quits and re-taps, race between join push and dashboard
    refresh, etc.) the helper must NOT insert two rows or clobber
    the first row's metadata."""
    group_id = str(uuid.uuid4())
    user = _mk_user()
    invite = _mk_invite(str(uuid.uuid4()), group_id,
                        relationship="Dad", role="senior")

    first = await fg.ensure_self_member_row(db, user, group_id, invite)
    second = await fg.ensure_self_member_row(db, user, group_id, invite)
    third = await fg.ensure_self_member_row(db, user, group_id, None)

    # All three calls return the SAME row (same id).
    assert first["id"] == second["id"] == third["id"]

    # Only ONE row was ever inserted.
    count = await db.members.count_documents(
        {"family_group_id": group_id, "user_id": user["id"]}
    )
    assert count == 1


# ---------- Bonus (user's follow-up concern): dashboard reads freshly ----------

@pytest.mark.asyncio
async def test_caregiver_and_invitee_members_query_returns_new_row(db):
    """After acceptance, BOTH the caregiver's dashboard query AND the
    invitee's dashboard query must return the new member on the very
    next /members request — no sign-out / restart / cache purge.

    Simulated by:
      1. Insert caregiver + fresh invitee users.
      2. Insert the caregiver's own self-member row.
      3. Run ensure_self_member_row for the invitee.
      4. Query `db.members.find({family_group_id: G})` — mirrors what
         GET /api/members does server-side (auth guards apply
         separately; this test is about the data plane).
      5. Assert BOTH members show up in the same result set.
    """
    group_id = str(uuid.uuid4())
    caregiver = _mk_user(email="care@example.com", full_name="Charles Smith")
    invitee = _mk_user(email="joyce@example.com", full_name="Joyce Miller")
    invite = _mk_invite(caregiver["id"], group_id, role="senior")

    # Caregiver's own self-member row (as if they'd been in the app already).
    await db.members.insert_one({
        "id": str(uuid.uuid4()),
        "user_id": caregiver["id"],
        "owner_id": caregiver["id"],
        "family_group_id": group_id,
        "name": caregiver["full_name"],
        "age": 45, "phone": "+15550001", "gender": "male",
        "role": "family", "status": "healthy",
    })

    await fg.ensure_self_member_row(db, invitee, group_id, invite)

    rows = await db.members.find(
        {"family_group_id": group_id}, {"_id": 0}
    ).to_list(10)
    ids_seen = {r["user_id"] for r in rows}
    assert caregiver["id"] in ids_seen, "caregiver missing from dashboard"
    assert invitee["id"] in ids_seen, "invitee missing from dashboard"
    assert len(rows) == 2
