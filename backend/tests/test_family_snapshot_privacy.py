"""Actual snapshot model/write/preferences/family reader; offline, no services."""
import copy
import json
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest
from bson.int64 import Int64
from fastapi.testclient import TestClient

from test_location_pipeline_consent import PipelineHarness, LAT, LON, LABEL, MAP
from test_location_consent_write_race import run, server


# Fixed current locationEngine.ts publisher contract, not the backend allowlist.
HEALTH = {
    "at": "2026-10-15T18:00:00+00:00",
    "device_model": "Pixel test",
    "ota_update_id": "test-update",
    "ota_channel": "preview",
    "app_state": "background",
    "listeners_attached": True,
    "sdk_enabled": True,
    "sdk_is_moving": False,
    "sdk_tracking_mode": "1",
    "activity_age_ms": 1000,
    "motion_age_ms": 2000,
    "location_age_ms": 3000,
    "hb_js_age_ms": 4000,
    "hl_inv_age_ms": 5000,
    "hl_hb_age_ms": None,
    "http_att_age_ms": 6000,
    "http_ok_age_ms": 7000,
}
SAFE_FIELDS = set(HEALTH) | {"stored_at"}
PRIVATE = {
    "native_location": {
        "coords": {"latitude": LAT, "longitude": LON},
        "label": LABEL, "map_url": MAP,
    },
    "provider": {"native": {"position": [LAT, LON]}},
    "location_pipeline": {"stored_latitude": LAT, "address": LABEL},
    "unknown_future_field": {"current_location": {"lat": LAT, "lng": LON}},
    "location_name": LABEL,
    "map_url": MAP,
}


@pytest.fixture
def h():
    harness = PipelineHarness()
    with patch.object(server, "db", harness.db), \
            patch.object(server, "stamp_device_presence", AsyncMock()):
        yield harness


async def write(h, payload=None, current=None, member_id="member"):
    data = server.DeviceSnapshotUpdate(**(payload if payload is not None else HEALTH))
    return await server.put_device_snapshot(
        member_id, data, current=current or h.current,
    )


async def read(h, current=None):
    return await server.diagnostics_family_snapshot(current=current or h.family)


def assert_safe(response, expected=HEALTH):
    # Inspect the COMPLETE serialized family response, not selected GPS names.
    encoded = json.dumps(response, allow_nan=False)
    for secret in (str(LAT), str(LON), LABEL, MAP):
        assert secret not in encoded
    for row in response["members"]:
        ds = row["device_snapshot"]
        if ds is not None:
            assert set(ds) <= SAFE_FIELDS
            assert all(v is None or isinstance(v, (str, int, float, bool))
                       for v in ds.values())
            for key, value in expected.items():
                assert ds[key] == value


def test_real_own_snapshot_write_then_real_withdrawal_preserves_health_not_extras(h):
    async def scenario():
        assert h.member["location_sharing_enabled"] is True
        assert await write(h, {**HEALTH, **PRIVATE}) is None
        stored = copy.deepcopy(h.member["device_snapshot"])
        assert set(stored) == SAFE_FIELDS
        assert all(key not in stored for key in PRIVATE)
        server.stamp_device_presence.assert_awaited_once_with(h.current, "device-snapshot")
        await h.sharing(False)
        h.assert_cleared()
        assert h.member["location_consent_generation"] == 1
        assert_safe(await read(h))
        assert h.member["device_snapshot"] == stored
    run(scenario())


@pytest.mark.parametrize("state", ["on", "off", "off_on"])
@pytest.mark.parametrize("viewer", ["family", "self", "creator"])
def test_retained_legacy_bag_is_read_safe_without_mutation_in_every_state(h, state, viewer):
    async def scenario():
        # Explicit pre-correction persisted representation; independent of the
        # hardened new writer. Raw retention is intentional, not the fix.
        stored = {**HEALTH, **copy.deepcopy(PRIVATE), "stored_at": HEALTH["at"]}
        h.member["device_snapshot"] = stored
        original = copy.deepcopy(stored)
        if state != "on":
            await h.sharing(False)
        if state == "off_on":
            await h.sharing(True)
        if viewer == "creator":
            h.member["owner_id"] = h.family["id"]
        result = await read(h, h.current if viewer == "self" else h.family)
        assert_safe(result)
        assert h.member["device_snapshot"] == original
        # No new raw-self exception invented for this shared health endpoint.
        assert result["members"][0]["device_snapshot"] != original
    run(scenario())


@pytest.mark.parametrize("enabled", [True, False])
def test_actual_publisher_health_shape_stays_useful_without_location_authority(h, enabled):
    async def scenario():
        await h.sharing(enabled)
        await write(h)
        h.member.update(battery_level=0.7, is_charging=True, is_moving=False,
                        gps_accuracy=15.0, gps_speed=0.0)
        result = await read(h)
        assert_safe(result)
        row = result["members"][0]
        assert (row["battery_level"], row["is_charging"], row["is_moving"]) == (0.7, True, False)
        assert (row["gps_accuracy"], row["gps_speed"]) == (15.0, 0.0)
        assert row["last_seen"] and isinstance(row["last_seen_age_ms"], int)
    run(scenario())


@pytest.mark.parametrize("generation", ["missing", 0, Int64(7)])
def test_off_on_cannot_revive_old_bag_fresh_safe_replacement_works(h, generation):
    async def scenario():
        if generation == "missing":
            h.member.pop("location_consent_generation")
        else:
            h.member["location_consent_generation"] = generation
        h.member["device_snapshot"] = {**HEALTH, **copy.deepcopy(PRIVATE)}
        await h.sharing(False)
        await h.sharing(True)
        assert_safe(await read(h))
        fresh = {**HEALTH, "location_age_ms": 10}
        await write(h, fresh)
        assert_safe(await read(h), fresh)
        assert not set(PRIVATE) & h.member["device_snapshot"].keys()
    run(scenario())


@pytest.mark.parametrize("key", sorted(SAFE_FIELDS))
def test_legacy_nested_payload_cannot_hide_under_allowlisted_scalar_key(h, key):
    async def scenario():
        h.member["device_snapshot"] = {
            **HEALTH, "stored_at": HEALTH["at"], key: copy.deepcopy(PRIVATE),
        }
        before = copy.deepcopy(h.member["device_snapshot"])
        expected = {k: v for k, v in HEALTH.items() if k != key}
        result = await read(h)
        assert_safe(result, expected)
        assert key not in result["members"][0]["device_snapshot"]
        assert h.member["device_snapshot"] == before
    run(scenario())


@pytest.mark.parametrize("value", [None, [], [PRIVATE], LABEL, 42])
def test_non_object_legacy_snapshot_never_forwards_raw_data(h, value):
    async def scenario():
        h.member["device_snapshot"] = copy.deepcopy(value)
        result = await read(h)
        assert_safe(result, {})
        assert result["members"][0]["device_snapshot"] is None
        assert h.member["device_snapshot"] == value
    run(scenario())


@pytest.mark.parametrize("value", [float("inf"), float("-inf"), float("nan"), True, "1"])
def test_invalid_legacy_numeric_value_is_omitted_without_losing_other_health(h, value):
    async def scenario():
        h.member["device_snapshot"] = {**HEALTH, "location_age_ms": value}
        result = await read(h)
        assert_safe(result, {k: v for k, v in HEALTH.items() if k != "location_age_ms"})
        assert "location_age_ms" not in result["members"][0]["device_snapshot"]
    run(scenario())


def test_bson_naive_and_aware_timestamps_normalized_without_mutating_storage(h):
    async def scenario():
        naive = datetime(2026, 10, 15, 18)
        h.member["device_snapshot"] = {
            **HEALTH, "at": naive, "stored_at": naive.replace(tzinfo=timezone.utc),
        }
        before = copy.deepcopy(h.member["device_snapshot"])
        result = await read(h)
        assert_safe(result)
        assert result["members"][0]["device_snapshot"]["stored_at"] == HEALTH["at"]
        assert h.member["device_snapshot"] == before
    run(scenario())


def test_partial_old_client_and_explicit_nulls_keep_existing_shape(h):
    async def scenario():
        await write(h, {"at": HEALTH["at"], "sdk_enabled": None, "future": PRIVATE})
        result = await read(h)
        assert_safe(result, {"at": HEALTH["at"], "sdk_enabled": None})
        assert set(result["members"][0]["device_snapshot"]) == {"at", "sdk_enabled", "stored_at"}
    run(scenario())


def test_no_snapshot_yet_is_null_and_normal_family_metrics_remain(h):
    async def scenario():
        result = await read(h)
        assert result["members"][0]["device_snapshot"] is None
        assert result["members"][0]["id"] == "member"
    run(scenario())


def test_unrelated_family_cannot_read_target_snapshot(h):
    async def scenario():
        h.member["device_snapshot"] = {**HEALTH, **PRIVATE}
        result = await read(h, {"id": "other", "family_group_id": "other"})
        assert result["members"] == []
        assert_safe(result)
    run(scenario())


@pytest.mark.parametrize("current,status", [
    ({"id": "caregiver", "family_group_id": "family", "family_group_role": "owner"}, 403),
    ({"id": "user", "family_group_id": "other"}, 404),
])
def test_snapshot_writer_still_requires_linked_self_in_current_family(h, current, status):
    async def scenario():
        with pytest.raises(server.HTTPException) as exc:
            await write(h, current=current)
        assert exc.value.status_code == status
        h.db.members.update_one.assert_not_awaited()
    run(scenario())


@pytest.mark.parametrize("method,path", [
    ("get", "/api/diagnostics/family-snapshot"),
    ("put", "/api/members/member/device-snapshot"),
])
def test_snapshot_http_endpoints_require_authentication(h, method, path):
    response = getattr(TestClient(server.app), method)(path, json=HEALTH) if method == "put" else TestClient(server.app).get(path)
    assert response.status_code in (401, 403)
    h.db.members.find.assert_not_called()
    h.db.members.find_one.assert_not_awaited()
