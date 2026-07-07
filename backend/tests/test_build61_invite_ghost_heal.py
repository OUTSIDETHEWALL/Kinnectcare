"""Build #61 regression — self-heal ghost-pending invites in GET /invites.

Covers the exact user-reported scenario:
  1. Caregiver sends invite (status=pending).
  2. Invitee joins the family via ANY path (join, verify-otp signup).
  3. But because of some historical bug (pre-Build-#59 hotfix, race, etc.),
     accept_invite() was never called → invite stays "pending" forever.
  4. Caregiver's dashboard shows "🟡 Invitation Pending" for a person
     who's clearly already in the family.

Fix under test: `list_invites` self-heals — for every pending invite
whose invitee_email matches a user already in the target family group,
it auto-transitions the invite to "accepted" and reflects the corrected
state in the response.  Idempotent, non-destructive.
"""
import os
import sys
import uuid
from datetime import datetime, timezone, timedelta

import pytest
import httpx
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

BASE_URL = "http://localhost:8001/api"


@pytest.fixture
async def db():
    client = AsyncIOMotorClient(os.environ.get("MONGO_URL", "mongodb://localhost:27017"))
    database = client[os.environ["DB_NAME"]]
    yield database
    client.close()


async def _grab_code(email: str) -> str:
    """Read the OTP code from the running backend log."""
    import asyncio
    await asyncio.sleep(0.5)
    with open("/var/log/supervisor/backend.err.log") as f:
        lines = f.readlines()
    for line in reversed(lines[-500:]):
        if f"Code for {email}:" in line:
            return line.split(":")[-1].strip()
    raise AssertionError(f"No OTP code found in log for {email}")


async def _signup_via_otp(client, email, full_name):
    r = await client.post(f"{BASE_URL}/auth/request-otp",
                          json={"email": email, "purpose": "signup",
                                "full_name": full_name})
    r.raise_for_status()
    code = await _grab_code(email)
    v = await client.post(f"{BASE_URL}/auth/verify-otp",
                          json={"email": email, "code": code,
                                "purpose": "signup", "full_name": full_name})
    v.raise_for_status()
    return v.json()["access_token"]


@pytest.mark.asyncio
async def test_ghost_pending_is_auto_healed_on_read(db):
    """The exact user-reported bug: pending invite for someone who is
    already a member.  list_invites must auto-mark it accepted."""
    uid = uuid.uuid4().hex[:8]
    cg_email = f"b61-cg-{uid}@example.com"
    iv_email = f"b61-iv-{uid}@example.com"

    async with httpx.AsyncClient(timeout=30.0) as h:
        # 1. Sign up caregiver
        cg_token = await _signup_via_otp(h, cg_email, "Cg61")
        cg_hdr = {"Authorization": f"Bearer {cg_token}"}

        # 2. Sign up invitee (initially in solo group)
        iv_token = await _signup_via_otp(h, iv_email, "Iv61")

        # 3. Caregiver sends invite to invitee's email
        r = await h.post(f"{BASE_URL}/family-group/invite", headers=cg_hdr,
                         json={"name": "Iv61", "email": iv_email,
                               "relationship": "Sibling", "role": "family"})
        r.raise_for_status()
        invite = r.json()["invite"]
        invite_id = invite["id"]
        token = invite["token"]

        # 4. Simulate the OLD bug: invitee joins the family group
        # via the join endpoint, but we then MANUALLY force the
        # invite back to "pending" (as if accept_invite had failed).
        iv_hdr = {"Authorization": f"Bearer {iv_token}"}
        r = await h.post(f"{BASE_URL}/family-group/join", headers=iv_hdr,
                         json={"invite_code": token})
        r.raise_for_status()
        # Yank the invite back to pending — this is the ghost state.
        await db.family_invites.update_one(
            {"id": invite_id},
            {"$set": {"status": "pending", "accepted_at": None,
                      "accepted_by_user_id": None}},
        )
        stuck = await db.family_invites.find_one({"id": invite_id}, {"_id": 0})
        assert stuck["status"] == "pending", "test setup: ghost pending not set"

        # 5. Caregiver fetches invites — the heal should kick in.
        r = await h.get(f"{BASE_URL}/family-group/invites", headers=cg_hdr)
        r.raise_for_status()
        invites = r.json()["invites"]

        # Response reflects the healed status.
        assert len(invites) == 1
        assert invites[0]["status"] == "accepted", (
            f"expected accepted, got {invites[0]['status']}"
        )

        # DB is also permanently healed (not just the response).
        healed = await db.family_invites.find_one({"id": invite_id}, {"_id": 0})
        assert healed["status"] == "accepted"
        assert healed["accepted_at"] is not None


@pytest.mark.asyncio
async def test_pending_for_non_member_is_left_alone(db):
    """Sanity: don't over-reach.  Real pending invites (invitee has NOT
    joined the family) must remain pending."""
    uid = uuid.uuid4().hex[:8]
    cg_email = f"b61-cg2-{uid}@example.com"
    stranger_email = f"b61-nobody-{uid}@example.com"

    async with httpx.AsyncClient(timeout=30.0) as h:
        cg_token = await _signup_via_otp(h, cg_email, "Cg61b")
        cg_hdr = {"Authorization": f"Bearer {cg_token}"}

        r = await h.post(f"{BASE_URL}/family-group/invite", headers=cg_hdr,
                         json={"name": "Stranger", "email": stranger_email})
        r.raise_for_status()

        r = await h.get(f"{BASE_URL}/family-group/invites", headers=cg_hdr)
        r.raise_for_status()
        invites = r.json()["invites"]
        assert len(invites) == 1
        assert invites[0]["status"] == "pending"  # untouched


@pytest.mark.asyncio
async def test_landing_page_returns_html_and_bakes_in_token():
    """Build #60 landing page — sanity that it serves and includes the
    correct scheme URL + Play Store fallback."""
    async with httpx.AsyncClient(timeout=10.0) as h:
        r = await h.get("http://localhost:8001/invite/INV-B61TEST")
        assert r.status_code == 200
        assert "text/html" in r.headers.get("content-type", "")
        body = r.text
        assert "kinnship://invite/INV-B61TEST" in body
        assert "referrer=invite_token%3DINV-B61TEST" in body
        assert "Google Play" in body or "play.google.com" in body
