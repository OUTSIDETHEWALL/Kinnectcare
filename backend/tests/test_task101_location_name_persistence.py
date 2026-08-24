"""Task 101 — lazy geocoding persists the resolved member location name.

The dashboard should resolve a missing location name once, write it back to
the member document, and then skip geocoding on subsequent reads.  A later
location upload clears the stored name, so the next dashboard read must
resolve the new coordinates again.
"""

import asyncio
import copy
import os
import sys
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# server.py reads these at import time.  Keep this test independent from a
# configured MongoDB or deployment environment.
for _key, _value in {
    "MONGO_URL": "mongodb://localhost:27017",
    "DB_NAME": "kinnship_test",
    "JWT_SECRET": "test-secret",
}.items():
    os.environ.setdefault(_key, _value)

with patch("motor.motor_asyncio.AsyncIOMotorClient", MagicMock()):
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
    import server  # noqa: E402


class _Cursor:
    def __init__(self, collection):
        self._collection = collection

    async def to_list(self, _limit):
        return [copy.deepcopy(self._collection.document)]


class _MembersCollection:
    def __init__(self, document):
        self.document = document
        self.find = MagicMock(side_effect=lambda *_args, **_kwargs: _Cursor(self))
        self.find_one = AsyncMock(side_effect=self._find_one)
        self.update_one = AsyncMock(side_effect=self._update_one)

    @staticmethod
    def _matches(document, filter_doc):
        return all(document.get(key) == value for key, value in filter_doc.items())

    async def _find_one(self, filter_doc, *_args, **_kwargs):
        if self._matches(self.document, filter_doc):
            return copy.deepcopy(self.document)
        return None

    async def _update_one(self, filter_doc, update_doc):
        # Mirror the conditional write-back guard used by list_members.
        matches = self._matches(self.document, filter_doc)
        if matches:
            self.document.update(update_doc.get("$set", {}))
        result = MagicMock()
        result.matched_count = 1 if matches else 0
        result.modified_count = 1 if matches else 0
        return result


class _TrackingCollection:
    """Collection spy used to prove the endpoint never reads geocode_cache."""

    def __init__(self):
        self.find_one = AsyncMock()
        self.update_one = AsyncMock()


class _Database:
    def __init__(self, document):
        self.members = _MembersCollection(document)
        self.geocode_cache = _TrackingCollection()


def _member_document():
    return {
        "id": "task-101-member",
        "owner_id": "task-101-owner",
        "family_group_id": "task-101-family",
        "name": "Joyce",
        "age": 78,
        "phone": "+15550001234",
        "gender": "female",
        "role": "senior",
        "status": "healthy",
        "last_seen": datetime.now(timezone.utc),
        "created_at": datetime.now(timezone.utc),
        "location_name": None,
        "latitude": 35.0248,
        "longitude": -114.5742,
    }


@pytest.mark.asyncio
async def test_location_name_is_persisted_and_re_geocoded_after_upload():
    """One resolve on the first read, none on the second, one after reset."""
    database = _Database(_member_document())
    resolve_location_name = AsyncMock(
        side_effect=[
            ("Fort Mohave, AZ", True),
            ("Bullhead City, AZ", True),
        ]
    )
    current_user = {
        "id": "task-101-owner",
        "family_group_id": "task-101-family",
        "family_group_role": "owner",
    }

    with patch.object(server, "db", database), patch.object(
        server.geocoding,
        "resolve_location_name",
        resolve_location_name,
    ), patch.object(
        server.geocoding,
        "GEOCODE_BACKEND_ENABLED",
        True,
    ):
        first = await server.list_members(current=current_user)
        await asyncio.sleep(0)

        assert first[0].location_name == "Fort Mohave, AZ"
        assert resolve_location_name.await_count == 1
        assert database.members.document["location_name"] == "Fort Mohave, AZ"

        second = await server.list_members(current=current_user)

        assert second[0].location_name == "Fort Mohave, AZ"
        assert resolve_location_name.await_count == 1, (
            "A persisted location_name should skip reverse geocoding on the "
            "next dashboard load"
        )
        database.geocode_cache.find_one.assert_not_called()
        database.geocode_cache.update_one.assert_not_called()

        # The real upload path clears the persisted label before the following
        # dashboard refresh, so a coordinate change gets a fresh location name.
        upload = await server.update_member_location(
            "task-101-member",
            server.LocationUpdate(latitude=35.1171, longitude=-114.5977),
            current=current_user,
        )
        assert upload.location_name is None
        assert database.members.document["location_name"] is None

        third = await server.list_members(current=current_user)
        await asyncio.sleep(0)

        assert third[0].location_name == "Bullhead City, AZ"
        assert resolve_location_name.await_count == 2, (
            "Clearing location_name for a new coordinate must trigger one "
            "fresh resolve on the following dashboard load"
        )
        assert database.members.document["location_name"] == "Bullhead City, AZ"