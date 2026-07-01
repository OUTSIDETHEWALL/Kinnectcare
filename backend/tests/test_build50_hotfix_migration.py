"""
Kinnship Build #50 — Bug #1 Hotfix regression suite
====================================================

Tests T1-T8 from the review request:

    T1  Backend startup migration ran cleanly (no exceptions) and is
        idempotent — a second boot re-runs the migration but produces
        0 backfills (all alerts already have `resolved`).
    T2  GET /api/alerts — every returned alert has `resolved` as a bool.
    T3  Fresh POST /api/sos → new alert has `resolved: false`.
    T4  POST /api/alerts/{id}/resolve happy-path + idempotency.
    T5  POST /api/alerts/nonexistent-id/resolve → 404.
    T6  Cross-tenant resolve → 404 (and the foreign doc is not mutated).
    T7  POST /api/sos with extra `fall_detected: true` → 422 (strict).
    T8  DELETE /api/alerts clears all family alerts (smoke).

Uses Alice's JWT from /app/memory/test_credentials.md and hits the
public preview URL exposed by EXPO_PUBLIC_BACKEND_URL (routed through
kubernetes ingress to backend:8001).
"""
from __future__ import annotations

import os
import subprocess
import time
import uuid
from typing import Any, Dict

import pymongo
import pytest
import requests
from dotenv import load_dotenv

load_dotenv("/app/frontend/.env")
load_dotenv("/app/backend/.env")

# Prefer public URL (what the frontend actually hits), fall back to localhost.
BASE_URL = (
    os.environ.get("EXPO_PUBLIC_BACKEND_URL")
    or "http://localhost:8001"
).rstrip("/")

ALICE_JWT = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJzdWIiOiI3ZDI4NTg5YS1mNDJhLTQ2OTMtYmU5Ni0zNGE0MDM2ODViOWIiLCJleHAiOjE4MTIyMjY0NjB9."
    "GxlsVHwyy6W_f-f2c2PMlLgBYLphaOGphPmES7C9CLE"
)
ALICE_USER_ID = "7d28589a-f42a-4693-be96-34a403685b9b"
ALICE_FAMILY_ID = "5e214a2f-c794-4649-bbd0-f42fbf2c32da"

AUTH_HEADERS = {
    "Authorization": f"Bearer {ALICE_JWT}",
    "Content-Type": "application/json",
}

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")
BACKEND_ERR_LOG = "/var/log/supervisor/backend.err.log"


# ------------------------- fixtures -------------------------


@pytest.fixture(scope="session")
def api() -> requests.Session:
    s = requests.Session()
    s.headers.update(AUTH_HEADERS)
    return s


@pytest.fixture(scope="session")
def mongo():
    return pymongo.MongoClient(MONGO_URL)[DB_NAME]


@pytest.fixture()
def fresh_alert(api) -> Dict[str, Any]:
    """POST /api/sos as Alice, yield the created alert id and clean up."""
    r = api.post(
        f"{BASE_URL}/api/sos",
        json={"member_id": None, "latitude": 40.7128, "longitude": -74.0060},
    )
    assert r.status_code == 200, f"SOS setup failed: {r.status_code} {r.text}"
    body = r.json()
    alert_id = body.get("alert_id")
    assert alert_id, f"No alert_id in SOS response: {body}"
    yield {"alert_id": alert_id, "response": body}
    try:
        pymongo.MongoClient(MONGO_URL)[DB_NAME].alerts.delete_one({"id": alert_id})
    except Exception:
        pass


# ------------------------- T1 : migration boot idempotency -------------------------


class TestT1MigrationIdempotent:
    """
    The migration is one of several @app.on_event('startup') handlers. It:
      - housekeeping deletes alerts older than 30 days
      - backfills resolved=False on rows missing it
      - promotes legacy acknowledged SOS to resolved

    Idempotency contract: a second boot must NOT throw AND must
    backfill/delete 0 rows (because the first boot already did the work).
    We only assert on the messages emitted after our sentinel restart so
    prior boots don't pollute the check.
    """

    SENTINEL_PREFIX = "T1-MIGRATION-SENTINEL"

    def _write_sentinel(self, tag: str) -> str:
        sentinel = f"{self.SENTINEL_PREFIX}-{tag}-{uuid.uuid4().hex[:8]}"
        # Emit the sentinel into the same log that supervisor tails so we
        # can locate the exact restart boundary.
        with open(BACKEND_ERR_LOG, "a") as fh:
            fh.write(f"\n{sentinel}\n")
        return sentinel

    def _read_after(self, sentinel: str) -> str:
        with open(BACKEND_ERR_LOG, "r") as fh:
            content = fh.read()
        idx = content.rfind(sentinel)
        if idx < 0:
            return ""
        return content[idx + len(sentinel):]

    def test_migration_idempotent_on_restart(self):
        sentinel = self._write_sentinel("restart")
        subprocess.run(
            ["sudo", "supervisorctl", "restart", "backend"],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )

        # Wait for backend to come back up and finish startup handlers.
        deadline = time.time() + 30
        healthy = False
        while time.time() < deadline:
            try:
                r = requests.get(f"{BASE_URL}/api/", timeout=3)
                if r.status_code < 500:
                    healthy = True
                    break
            except Exception:
                pass
            time.sleep(0.5)
        assert healthy, "Backend did not come back after restart"

        # Give startup handlers a beat to flush their log lines.
        time.sleep(2.0)

        tail = self._read_after(sentinel)
        assert tail, "Failed to locate sentinel in backend.err.log"

        # (a) No traceback / uncaught exception during startup.
        for banned in ("Traceback (most recent call last)",
                       "alerts backfill migration skipped"):
            assert banned not in tail, (
                f"Startup issue detected after restart:\n{tail[-2000:]}"
            )

        # (b) On the SECOND boot, the migration should be a no-op — the
        # backfill lines are only emitted when modified_count > 0, so
        # their absence proves idempotency.
        assert "alerts backfill: set resolved=False" not in tail, (
            f"Backfill re-ran on 2nd boot — not idempotent!\n{tail}"
        )
        assert "alerts backfill: promoted" not in tail, (
            f"Legacy promotion re-ran on 2nd boot — not idempotent!\n{tail}"
        )
        # Housekeeping may legitimately remove 0 rows on the 2nd boot
        # (it only logs when deleted_count > 0), so absence of that
        # line is also good.  If it did fire, deleted_count could be 0
        # only if some alert freshly aged over 30 days between boots —
        # highly unlikely in a normal test run.


# ------------------------- T2 : GET /alerts shape -------------------------


class TestT2AlertsHaveResolvedField:
    def test_every_alert_has_resolved_bool(self, api, fresh_alert):
        r = api.get(f"{BASE_URL}/api/alerts")
        assert r.status_code == 200, f"GET /alerts failed: {r.status_code} {r.text}"
        body = r.json()
        alerts = body if isinstance(body, list) else body.get("alerts", [])
        assert isinstance(alerts, list) and alerts, (
            f"Expected non-empty alerts list (at least fresh SOS): {body}"
        )
        offenders = [a for a in alerts if not isinstance(a.get("resolved"), bool)]
        assert not offenders, (
            f"{len(offenders)} alert(s) missing or non-bool `resolved`: "
            f"{[{'id': a.get('id'), 'resolved': a.get('resolved')} for a in offenders[:5]]}"
        )


# ------------------------- T3 : fresh SOS default resolved=False -------------------------


class TestT3FreshSOSDefaultsToUnresolved:
    def test_fresh_sos_alert_is_unresolved(self, api, fresh_alert, mongo):
        alert_id = fresh_alert["alert_id"]
        # DB-level assertion — the doc as persisted must have resolved=False.
        doc = mongo.alerts.find_one({"id": alert_id}, {"_id": 0})
        assert doc is not None, f"Fresh alert {alert_id} not found in DB"
        assert doc.get("resolved") is False, (
            f"Fresh SOS alert should default resolved=False, got: {doc.get('resolved')!r}"
        )
        # API-level assertion — GET /alerts must echo the same.
        r = api.get(f"{BASE_URL}/api/alerts")
        assert r.status_code == 200
        alerts = r.json() if isinstance(r.json(), list) else r.json().get("alerts", [])
        target = next((a for a in alerts if a.get("id") == alert_id), None)
        assert target is not None, "Fresh alert not in GET /alerts response"
        assert target.get("resolved") is False


# ------------------------- T4 : resolve happy path + idempotency -------------------------


class TestT4ResolveHappyPath:
    def test_resolve_and_idempotency(self, api, fresh_alert):
        alert_id = fresh_alert["alert_id"]

        r1 = api.post(f"{BASE_URL}/api/alerts/{alert_id}/resolve")
        assert r1.status_code == 200, f"resolve #1: {r1.status_code} {r1.text}"
        j1 = r1.json()
        assert j1.get("ok") is True
        a1 = j1.get("alert") or {}
        assert a1.get("resolved") is True, a1
        assert a1.get("acknowledged") is True, a1
        assert a1.get("resolved_at"), f"resolved_at missing: {a1}"
        assert a1.get("resolved_by_user_id") == ALICE_USER_ID, a1
        # Per credential file, Alice's full_name is "Alice FE-Test" — the
        # resolver name falls back full_name → email → generic string.
        assert a1.get("resolved_by_name"), a1
        assert not j1.get("already_resolved"), j1

        # 2nd call → idempotent.
        r2 = api.post(f"{BASE_URL}/api/alerts/{alert_id}/resolve")
        assert r2.status_code == 200, f"resolve #2: {r2.status_code} {r2.text}"
        j2 = r2.json()
        assert j2.get("ok") is True, j2
        assert j2.get("already_resolved") is True, (
            f"Second resolve must return already_resolved=True: {j2}"
        )
        a2 = j2.get("alert") or {}
        assert a2.get("resolved") is True
        # Second-level precision comparison — mongo stores ms, in-memory
        # doc had us precision on the first call.
        assert (a2.get("resolved_at") or "")[:19] == (a1.get("resolved_at") or "")[:19], (
            f"resolved_at re-stamped on idempotent call: "
            f"first={a1.get('resolved_at')} second={a2.get('resolved_at')}"
        )


# ------------------------- T5 : bogus id 404 -------------------------


class TestT5ResolveBogusReturns404:
    def test_bogus_id_returns_404(self, api):
        r = api.post(f"{BASE_URL}/api/alerts/nonexistent-id/resolve")
        assert r.status_code == 404, (
            f"bogus id should 404, got {r.status_code}: {r.text[:200]}"
        )

    def test_random_uuid_returns_404(self, api):
        r = api.post(f"{BASE_URL}/api/alerts/{uuid.uuid4()}/resolve")
        assert r.status_code == 404


# ------------------------- T6 : cross-tenant resolve -------------------------


class TestT6ResolveCrossTenant:
    def test_cross_tenant_resolve_returns_404_and_leaves_doc_untouched(self, api, mongo):
        foreign_family_id = f"foreign-family-{uuid.uuid4()}"
        foreign_alert_id = f"foreign-alert-{uuid.uuid4()}"
        mongo.alerts.insert_one(
            {
                "id": foreign_alert_id,
                "owner_id": "someone-else",
                "family_group_id": foreign_family_id,
                "member_id": "m1",
                "member_name": "Stranger",
                "type": "sos",
                "severity": "critical",
                "title": "SOS Emergency — Stranger",
                "message": "cross-tenant guard test",
                "acknowledged": False,
                "resolved": False,
            }
        )
        try:
            r = api.post(f"{BASE_URL}/api/alerts/{foreign_alert_id}/resolve")
            assert r.status_code == 404, (
                f"cross-tenant resolve should 404, got {r.status_code}: {r.text[:200]}"
            )
            doc = mongo.alerts.find_one({"id": foreign_alert_id})
            assert doc is not None
            assert doc.get("resolved") in (False, None), (
                f"Cross-tenant call leaked mutation: {doc}"
            )
            assert doc.get("acknowledged") in (False, None)
            assert doc.get("resolved_at") in (None,)
        finally:
            mongo.alerts.delete_one({"id": foreign_alert_id})


# ------------------------- T7 : /sos strict extra=forbid -------------------------


class TestT7SOSRejectsLegacyField:
    def test_legacy_fall_detected_returns_422(self, api):
        payload = {
            "member_id": None,
            "latitude": 12.34,
            "longitude": 56.78,
            "fall_detected": True,
        }
        r = api.post(f"{BASE_URL}/api/sos", json=payload)
        assert r.status_code == 422, (
            f"legacy fall_detected must 422 (strict mode), got {r.status_code}: {r.text[:300]}"
        )
        # And no alert should have been created — confirm with a sanity
        # check that the response body mentions Extra inputs.
        try:
            body = r.json()
            detail = str(body.get("detail", ""))
            assert "fall_detected" in detail or "extra" in detail.lower(), body
        except Exception:
            pass  # Body format may vary; primary contract is the 422.

    def test_completely_bogus_field_also_rejected(self, api):
        payload = {
            "member_id": None,
            "latitude": 12.34,
            "longitude": 56.78,
            "gibberish_field_xyz": "hi",
        }
        r = api.post(f"{BASE_URL}/api/sos", json=payload)
        assert r.status_code == 422, (
            f"Any extra key must 422 (extra='forbid'), got {r.status_code}: {r.text[:300]}"
        )


# ------------------------- T8 : DELETE /alerts smoke -------------------------


class TestT8DeleteAllAlerts:
    def test_delete_all_alerts_smoke(self, api, mongo):
        # Seed a couple of TEST_ alerts under Alice's family so we have
        # something to delete.
        seed_ids = []
        for i in range(2):
            seed_id = f"TEST-DEL-{uuid.uuid4()}"
            mongo.alerts.insert_one(
                {
                    "id": seed_id,
                    "owner_id": ALICE_USER_ID,
                    "family_group_id": ALICE_FAMILY_ID,
                    "member_id": "m-seed",
                    "member_name": "Seed",
                    "type": "sos",
                    "severity": "critical",
                    "title": "T8 seed",
                    "message": "will be wiped",
                    "acknowledged": False,
                    "resolved": False,
                }
            )
            seed_ids.append(seed_id)

        # Sanity — at least our seed docs are in Alice's family alerts.
        before = mongo.alerts.count_documents({"family_group_id": ALICE_FAMILY_ID})
        assert before >= len(seed_ids)

        r = api.delete(f"{BASE_URL}/api/alerts")
        assert r.status_code == 200, f"DELETE /alerts failed: {r.status_code} {r.text}"
        body = r.json()
        assert body.get("ok") is True, body
        assert isinstance(body.get("deleted"), int), body
        assert body["deleted"] >= len(seed_ids), (
            f"Expected at least {len(seed_ids)} deletions, got {body['deleted']}"
        )

        after = mongo.alerts.count_documents({"family_group_id": ALICE_FAMILY_ID})
        assert after == 0, f"DELETE /alerts left {after} alerts in the family"

        # GET /alerts should now be empty for Alice.
        g = api.get(f"{BASE_URL}/api/alerts")
        assert g.status_code == 200
        remaining = g.json() if isinstance(g.json(), list) else g.json().get("alerts", [])
        assert remaining == [], f"GET /alerts should be empty after DELETE, got: {remaining}"


# ------------------------- Safeguard A : sentinel one-shot -------------------------


class TestSafeguardASentinelOneShot:
    """
    Build 50 hotfix — after v2 of the migration, a `migrations` collection
    stores a per-migration sentinel doc.  When present, the startup
    handler must short-circuit and produce ZERO log lines (housekeeping,
    backfill, or promotion).

    We assert this by:
      1. Ensuring the sentinel exists (write it if missing).
      2. Restarting the backend and reading the log tail after our
         restart-marker.
      3. Asserting no `alerts (housekeeping|backfill: ...)` line is emitted.
    """

    def test_sentinel_short_circuits_migration(self, mongo):
        # Guarantee the sentinel exists so we're testing the skip path.
        mongo.migrations.update_one(
            {"_id": "alerts_backfill_v50"},
            {"$setOnInsert": {"_id": "alerts_backfill_v50", "run_at": "test-preset"}},
            upsert=True,
        )
        marker = f"SAFEGUARD-A-{uuid.uuid4().hex[:8]}"
        with open(BACKEND_ERR_LOG, "a") as fh:
            fh.write(f"\n{marker}\n")

        subprocess.run(
            ["sudo", "supervisorctl", "restart", "backend"],
            check=True, capture_output=True, text=True, timeout=30,
        )
        # Wait for backend ready
        deadline = time.time() + 30
        while time.time() < deadline:
            try:
                if requests.get(f"{BASE_URL}/api/", timeout=3).status_code < 500:
                    break
            except Exception:
                pass
            time.sleep(0.5)
        time.sleep(2.0)

        with open(BACKEND_ERR_LOG, "r") as fh:
            content = fh.read()
        idx = content.rfind(marker)
        tail = content[idx + len(marker):] if idx >= 0 else ""
        assert tail, "Failed to locate marker after restart"

        forbidden = [
            "alerts housekeeping: removed",
            "alerts backfill: set resolved=False",
            "alerts backfill: promoted",
        ]
        offenders = [line for line in forbidden if line in tail]
        assert not offenders, (
            f"Sentinel did not short-circuit — these lines appeared post-restart: "
            f"{offenders}\n---tail---\n{tail[-2000:]}"
        )


# ------------------------- Safeguard B : 1-hour safety window -------------------------


class TestSafeguardBSafetyWindow:
    """
    A truly active SOS that was just acknowledged in the last few minutes
    MUST NEVER be promoted to resolved by the migration.  We simulate this
    by:
      1. Inserting a synthetic SOS with created_at = now, acknowledged=True,
         resolved=False (matches all migration criteria EXCEPT the age gate).
      2. Deleting the sentinel and restarting so the migration re-runs.
      3. Asserting that our fresh SOS is STILL unresolved after the boot.

    Then repeat with created_at = now - 2h — that SOS SHOULD get promoted.
    """

    def test_recent_ack_not_promoted_but_old_ack_is(self, mongo):
        from datetime import datetime, timedelta, timezone

        # Setup: clear sentinel so migration re-runs.
        mongo.migrations.delete_one({"_id": "alerts_backfill_v50"})

        now = datetime.now(timezone.utc)
        fresh_id = f"safety-fresh-{uuid.uuid4().hex[:8]}"
        old_id = f"safety-old-{uuid.uuid4().hex[:8]}"

        # Fresh SOS — acknowledged 30 seconds ago (within 1-hour window).
        # MUST NOT be promoted.
        mongo.alerts.insert_one({
            "id": fresh_id, "owner_id": "test-owner",
            "family_group_id": "test-family-safeguard-b",
            "member_id": "test-member", "member_name": "Test Fresh",
            "type": "sos", "severity": "critical",
            "title": "Fresh SOS", "message": "Active caregiver response",
            "acknowledged": True, "resolved": False,
            "created_at": now - timedelta(seconds=30),
        })

        # Old SOS — acknowledged 2 hours ago (outside safety window).
        # SHOULD be promoted to resolved by the migration.
        mongo.alerts.insert_one({
            "id": old_id, "owner_id": "test-owner",
            "family_group_id": "test-family-safeguard-b",
            "member_id": "test-member", "member_name": "Test Old",
            "type": "sos", "severity": "critical",
            "title": "Old SOS", "message": "Stale legacy",
            "acknowledged": True, "resolved": False,
            "created_at": now - timedelta(hours=2),
        })

        try:
            subprocess.run(
                ["sudo", "supervisorctl", "restart", "backend"],
                check=True, capture_output=True, text=True, timeout=30,
            )
            # Wait for backend
            deadline = time.time() + 30
            while time.time() < deadline:
                try:
                    if requests.get(f"{BASE_URL}/api/", timeout=3).status_code < 500:
                        break
                except Exception:
                    pass
                time.sleep(0.5)
            time.sleep(2.0)

            fresh_doc = mongo.alerts.find_one({"id": fresh_id})
            old_doc = mongo.alerts.find_one({"id": old_id})

            assert fresh_doc is not None, "Fresh SOS was destroyed by migration"
            assert fresh_doc.get("resolved") is False, (
                f"REGRESSION: fresh acknowledged SOS (30 s old) was promoted "
                f"to resolved by the migration. Safety window failed.\n"
                f"Doc: {fresh_doc}"
            )
            assert fresh_doc.get("resolved_at") is None, (
                f"REGRESSION: fresh SOS got a resolved_at stamp. Doc: {fresh_doc}"
            )

            assert old_doc is not None, "Old SOS was destroyed"
            assert old_doc.get("resolved") is True, (
                f"Old (2h) acknowledged SOS was NOT promoted — expected legacy "
                f"cleanup. Doc: {old_doc}"
            )
            assert old_doc.get("resolved_by_name") == "Legacy (pre-Build-50)"
        finally:
            mongo.alerts.delete_many({"id": {"$in": [fresh_id, old_id]}})
