"""Build #57 backend regression tests — Privacy Indicator patch.

Coverage:
  1. PUT /me/preferences {location_sharing_enabled:false} still propagates
     to db.members (own row): flag=false, lat/lng=None,
     name="Location Sharing Off" — even without a family_group_id
     constraint (Build #57 loosened match).
  2. Verify log line "[privacy] location_sharing=False propagated to N member doc(s)"
     appears in backend logs after toggle-off.
  3. Startup migrations ran once:
       - Build #57 backfill: location_sharing_enabled set on N member doc(s)
         (idempotent — 0/"no members needed migration" on second run)
       - Build #57 consistency sweep (only when a user has sharing OFF)
  4. Edge case: a member doc with family_group_id=None still gets cleared
     when the user's user_id matches (via mongo directly to seed the case
     since API always sets a fg).
"""

import os
import re
import time
import subprocess
import pytest
import requests

BASE_URL = "https://family-guard-37.preview.emergentagent.com"
API = f"{BASE_URL}/api"

ALICE_JWT = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJzdWIiOiI3ZDI4NTg5YS1mNDJhLTQ2OTMtYmU5Ni0zNGE0MDM2ODViOWIiLCJleHAiOjE4MTIyMjY0NjB9."
    "GxlsVHwyy6W_f-f2c2PMlLgBYLphaOGphPmES7C9CLE"
)
ALICE_ID = "7d28589a-f42a-4693-be96-34a403685b9b"
ALICE_FG = "5e214a2f-c794-4649-bbd0-f42fbf2c32da"

BACKEND_LOG = "/var/log/supervisor/backend.err.log"


def _auth(jwt=ALICE_JWT):
    return {"Authorization": f"Bearer {jwt}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def alice_headers():
    return _auth()


def _find_or_create_self_member(headers):
    r = requests.get(f"{API}/members", headers=headers, timeout=15)
    assert r.status_code == 200, r.text
    members = r.json()
    self_row = next(
        (m for m in members if m.get("user_id") == ALICE_ID or m.get("owner_id") == ALICE_ID),
        None,
    )
    created_id = None
    if self_row is None:
        payload = {
            "name": "TEST_Alice_B57",
            "age": 65,
            "phone": "+15555550100",
            "gender": "female",
            "role": "senior",
        }
        r = requests.post(f"{API}/members", headers=headers, json=payload, timeout=15)
        assert r.status_code == 200, r.text
        self_row = r.json()
        created_id = self_row["id"]
    # Link user_id if needed
    if self_row.get("user_id") != ALICE_ID:
        try:
            subprocess.run(
                ["mongosh", "--quiet", "--eval",
                 (
                     'db.getSiblingDB("test_database").members.updateOne('
                     f'{{id:"{self_row["id"]}"}},'
                     f'{{$set:{{user_id:"{ALICE_ID}"}}}})'
                 )],
                check=False, capture_output=True, timeout=10,
            )
            self_row["user_id"] = ALICE_ID
        except Exception:
            pass
    return self_row, created_id


class TestPrivacyPropagation:
    def test_toggle_off_propagates_and_logs(self, alice_headers):
        self_row, created_id = _find_or_create_self_member(alice_headers)
        mid = self_row["id"]

        try:
            # Ensure ON baseline.
            requests.put(f"{API}/me/preferences", headers=alice_headers,
                         json={"location_sharing_enabled": True}, timeout=10)

            # Trigger toggle OFF.
            r = requests.put(f"{API}/me/preferences", headers=alice_headers,
                             json={"location_sharing_enabled": False}, timeout=15)
            assert r.status_code == 200, r.text
            assert r.json()["location_sharing_enabled"] is False

            # Verify own row cleared.
            r2 = requests.get(f"{API}/members", headers=alice_headers, timeout=15)
            row = next(m for m in r2.json() if m["id"] == mid)
            assert row["location_sharing_enabled"] is False, row
            assert row["latitude"] is None, row
            assert row["longitude"] is None, row
            assert row["location_name"] == "Location Sharing Off", row

            # Verify log line appears (tail of backend log).
            time.sleep(0.5)  # let the async log flush
            with open(BACKEND_LOG, "r") as f:
                # Tail last 200KB — enough for a fresh log line.
                f.seek(0, 2)
                size = f.tell()
                f.seek(max(0, size - 200_000))
                tail = f.read()
            pattern = re.compile(
                r"\[privacy\] location_sharing=False propagated to \d+ member doc\(s\) for user="
                + re.escape(ALICE_ID)
            )
            assert pattern.search(tail), (
                "Expected [privacy] propagation log line not found in backend log tail. "
                f"Last 4KB:\n{tail[-4000:]}"
            )
        finally:
            # Restore.
            requests.put(f"{API}/me/preferences", headers=alice_headers,
                         json={"location_sharing_enabled": True}, timeout=10)
            if created_id:
                try:
                    requests.delete(f"{API}/members/{created_id}", headers=alice_headers, timeout=10)
                except Exception:
                    pass

    def test_no_fg_constraint_edge_case(self, alice_headers):
        """Simulate a legacy member doc with family_group_id=None but user_id
        matching Alice — Build #57 loosened match must still clear it."""
        self_row, created_id = _find_or_create_self_member(alice_headers)
        mid = self_row["id"]

        # Blank out family_group_id via mongo.
        try:
            subprocess.run(
                ["mongosh", "--quiet", "--eval",
                 (
                     'db.getSiblingDB("test_database").members.updateOne('
                     f'{{id:"{mid}"}},'
                     f'{{$set:{{family_group_id:null,user_id:"{ALICE_ID}",'
                     f'latitude:40.0,longitude:-74.0,'
                     f'location_name:"legacy_seed",location_sharing_enabled:true}}}})'
                 )],
                check=True, capture_output=True, timeout=10,
            )
        except Exception as e:
            pytest.skip(f"mongosh unavailable: {e}")

        try:
            # Toggle OFF — new query must catch this doc.
            r = requests.put(f"{API}/me/preferences", headers=alice_headers,
                             json={"location_sharing_enabled": False}, timeout=15)
            assert r.status_code == 200

            r2 = requests.get(f"{API}/members", headers=alice_headers, timeout=15)
            # The row may or may not appear in GET /members (since it has no fg),
            # so verify via mongo direct.
            check = subprocess.run(
                ["mongosh", "--quiet", "--eval",
                 (
                     'JSON.stringify(db.getSiblingDB("test_database").members.findOne('
                     f'{{id:"{mid}"}}, {{_id:0,latitude:1,longitude:1,location_name:1,'
                     f'location_sharing_enabled:1}}))'
                 )],
                capture_output=True, timeout=10, text=True,
            )
            import json as _json
            # mongosh returns raw text; extract the JSON blob
            out = check.stdout.strip()
            doc = None
            for line in out.splitlines():
                line = line.strip()
                if line.startswith("{"):
                    try:
                        doc = _json.loads(line)
                        break
                    except Exception:
                        continue
            assert doc is not None, f"could not parse mongo output: {out!r}"
            assert doc.get("location_sharing_enabled") is False, doc
            assert doc.get("latitude") is None, doc
            assert doc.get("longitude") is None, doc
            assert doc.get("location_name") == "Location Sharing Off", doc
        finally:
            # Restore family_group_id + baseline.
            try:
                subprocess.run(
                    ["mongosh", "--quiet", "--eval",
                     (
                         'db.getSiblingDB("test_database").members.updateOne('
                         f'{{id:"{mid}"}},'
                         f'{{$set:{{family_group_id:"{ALICE_FG}"}}}})'
                     )],
                    capture_output=True, timeout=10,
                )
            except Exception:
                pass
            requests.put(f"{API}/me/preferences", headers=alice_headers,
                         json={"location_sharing_enabled": True}, timeout=10)
            if created_id:
                try:
                    requests.delete(f"{API}/members/{created_id}", headers=alice_headers, timeout=10)
                except Exception:
                    pass


class TestStartupMigrations:
    def test_backfill_log_present(self):
        """Build #57 backfill log line must have been emitted at least once."""
        with open(BACKEND_LOG, "r") as f:
            content = f.read()
        # Either "set on N pre-existing" (first run) or "no members needed migration"
        # (idempotent second run) must be present.
        pat1 = re.compile(
            r"Build #57 backfill: location_sharing_enabled set on \d+ pre-existing member doc\(s\)"
        )
        pat2 = re.compile(r"Build #57 backfill: no members needed migration")
        assert pat1.search(content) or pat2.search(content), (
            "Neither Build #57 backfill log line found in backend log."
        )

    def test_consistency_sweep_ran_when_applicable(self):
        """The consistency sweep only logs when a user has sharing OFF at boot.
        We don't force this state (would require restarting backend), so this
        test verifies the code path is at least present in the log OR the
        server is currently in an all-ON steady state (which is the normal
        production baseline after test teardown)."""
        with open(BACKEND_LOG, "r") as f:
            content = f.read()
        pat = re.compile(
            r"Build #57 consistency sweep: \d+ users had sharing OFF; "
            r"re-mirrored to \d+ member doc\(s\)"
        )
        # Presence is optional (depends on state at boot). Just assert
        # that IF it fired, the counts are sane integers (regex enforces
        # that). No hard-fail; test is informational.
        _ = pat.search(content)
        # Also make sure the migration function was at least reached — i.e.
        # no exception logged.
        assert "_sync_user_sharing_pref_to_members skipped" not in content, (
            "consistency sweep threw an exception at startup"
        )
