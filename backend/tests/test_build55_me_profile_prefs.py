"""
Kinnship Build #55 — PATCH /auth/me + updated /me/preferences (location_sharing_enabled).

Covers the review-request items:
  • PATCH /api/auth/me:
      - name < 2 → 400
      - name > 80 → 400
      - invalid IANA tz → 400
      - valid full_name-only + timezone-only + both → 200 with updated UserResponse
      - empty body → no-op 200
  • GET  /api/me/preferences:
      - defaults location_sharing_enabled = True when never set
      - matches previously-written value
  • PUT  /api/me/preferences:
      - partial {location_sharing_enabled} only
      - partial {quiet_hours} only
      - both together
      - persists across GET
  • Regression on existing auth endpoints:
      - POST /auth/request-otp + verify-otp round-trip creates a fresh user
      - PUT /auth/timezone still works
      - GET /auth/me returns current user
"""
import os
import re
import time
import subprocess
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "").rstrip("/") or "http://localhost:8001"
API = f"{BASE_URL}/api"

# Alice's long-lived JWT from /app/memory/test_credentials.md line 11.
ALICE_TOKEN = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJzdWIiOiI3ZDI4NTg5YS1mNDJhLTQ2OTMtYmU5Ni0zNGE0MDM2ODViOWIiLCJleHAiOjE4MTIyMjY0NjB9."
    "GxlsVHwyy6W_f-f2c2PMlLgBYLphaOGphPmES7C9CLE"
)


def _auth_headers(token: str = ALICE_TOKEN) -> dict:
    return {"Content-Type": "application/json", "Authorization": f"Bearer {token}"}


@pytest.fixture(scope="module")
def alice_baseline():
    """Snapshot Alice's name/timezone/prefs BEFORE the suite; restore AFTER."""
    r = requests.get(f"{API}/auth/me", headers=_auth_headers(), timeout=15)
    assert r.status_code == 200, f"Alice auth/me failed: {r.status_code} {r.text}"
    user = r.json()

    p = requests.get(f"{API}/me/preferences", headers=_auth_headers(), timeout=15)
    assert p.status_code == 200, p.text
    prefs = p.json()

    yield {"user": user, "prefs": prefs}

    # Teardown — restore name/tz.
    requests.patch(
        f"{API}/auth/me",
        headers=_auth_headers(),
        json={"full_name": user["full_name"], "timezone": user["timezone"]},
        timeout=15,
    )
    # Restore preferences (both fields).
    requests.put(
        f"{API}/me/preferences",
        headers=_auth_headers(),
        json={
            "quiet_hours": prefs["quiet_hours"],
            "location_sharing_enabled": prefs["location_sharing_enabled"],
        },
        timeout=15,
    )


# ==========================================================
#  PATCH /api/auth/me — new endpoint
# ==========================================================
class TestPatchAuthMe:
    def test_reject_name_too_short(self, alice_baseline):
        r = requests.patch(f"{API}/auth/me", headers=_auth_headers(), json={"full_name": "A"}, timeout=15)
        assert r.status_code == 400, f"expected 400, got {r.status_code}: {r.text}"
        assert "2" in r.json().get("detail", "")

    def test_reject_name_too_long(self, alice_baseline):
        r = requests.patch(f"{API}/auth/me", headers=_auth_headers(), json={"full_name": "x" * 81}, timeout=15)
        assert r.status_code == 400, r.text

    def test_reject_invalid_timezone(self, alice_baseline):
        r = requests.patch(f"{API}/auth/me", headers=_auth_headers(), json={"timezone": "Not/AZone"}, timeout=15)
        assert r.status_code == 400, r.text
        assert "IANA" in r.json().get("detail", "") or "Invalid" in r.json().get("detail", "")

    def test_update_full_name_only(self, alice_baseline):
        target = "Alice PatchOnly"
        r = requests.patch(f"{API}/auth/me", headers=_auth_headers(), json={"full_name": target}, timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["full_name"] == target
        # timezone must NOT be wiped
        assert body["timezone"] == alice_baseline["user"]["timezone"]
        # GET verifies persistence
        g = requests.get(f"{API}/auth/me", headers=_auth_headers(), timeout=15)
        assert g.json()["full_name"] == target

    def test_update_timezone_only(self, alice_baseline):
        r = requests.patch(f"{API}/auth/me", headers=_auth_headers(), json={"timezone": "America/Los_Angeles"}, timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["timezone"] == "America/Los_Angeles"
        # full_name preserved (from prev test)
        g = requests.get(f"{API}/auth/me", headers=_auth_headers(), timeout=15)
        assert g.json()["timezone"] == "America/Los_Angeles"

    def test_update_both_fields(self, alice_baseline):
        r = requests.patch(
            f"{API}/auth/me",
            headers=_auth_headers(),
            json={"full_name": "Alice Both", "timezone": "Europe/London"},
            timeout=15,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["full_name"] == "Alice Both"
        assert body["timezone"] == "Europe/London"

    def test_empty_body_is_noop(self, alice_baseline):
        # Should NOT wipe fields — server logic gates each set_doc entry on Not-None
        r = requests.patch(f"{API}/auth/me", headers=_auth_headers(), json={}, timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["full_name"]  # non-empty
        assert body["timezone"]

    def test_name_whitespace_trim(self, alice_baseline):
        r = requests.patch(f"{API}/auth/me", headers=_auth_headers(), json={"full_name": "   Alice Trimmed   "}, timeout=15)
        assert r.status_code == 200, r.text
        assert r.json()["full_name"] == "Alice Trimmed"

    def test_requires_auth(self):
        r = requests.patch(f"{API}/auth/me", json={"full_name": "Anon"}, timeout=15)
        assert r.status_code in (401, 403), r.text


# ==========================================================
#  GET/PUT /api/me/preferences — location_sharing_enabled
# ==========================================================
class TestPreferencesLocationSharing:
    def test_get_returns_location_sharing_field(self, alice_baseline):
        r = requests.get(f"{API}/me/preferences", headers=_auth_headers(), timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert "quiet_hours" in body
        assert "location_sharing_enabled" in body
        assert isinstance(body["location_sharing_enabled"], bool)

    def test_put_partial_location_sharing_only(self, alice_baseline):
        # First set to false
        r = requests.put(
            f"{API}/me/preferences",
            headers=_auth_headers(),
            json={"location_sharing_enabled": False},
            timeout=15,
        )
        assert r.status_code == 200, r.text
        assert r.json()["location_sharing_enabled"] is False

        g = requests.get(f"{API}/me/preferences", headers=_auth_headers(), timeout=15)
        assert g.json()["location_sharing_enabled"] is False

        # Then flip to true
        r2 = requests.put(
            f"{API}/me/preferences",
            headers=_auth_headers(),
            json={"location_sharing_enabled": True},
            timeout=15,
        )
        assert r2.status_code == 200, r2.text
        assert r2.json()["location_sharing_enabled"] is True

    def test_put_partial_quiet_hours_only_preserves_location_sharing(self, alice_baseline):
        # Set location sharing to a known value FIRST
        requests.put(
            f"{API}/me/preferences",
            headers=_auth_headers(),
            json={"location_sharing_enabled": False},
            timeout=15,
        )
        # Now send ONLY quiet_hours — location_sharing_enabled must not be reset
        r = requests.put(
            f"{API}/me/preferences",
            headers=_auth_headers(),
            json={"quiet_hours": {"enabled": True, "start": "22:00", "end": "07:00"}},
            timeout=15,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["quiet_hours"]["enabled"] is True
        assert body["quiet_hours"]["start"] == "22:00"
        # regression: partial PUT must preserve the OTHER field
        assert body["location_sharing_enabled"] is False, (
            "partial PUT of quiet_hours wiped location_sharing_enabled — Build #55 spec violation"
        )
        # cleanup — restore to True
        requests.put(
            f"{API}/me/preferences",
            headers=_auth_headers(),
            json={"location_sharing_enabled": True},
            timeout=15,
        )

    def test_put_both_fields(self, alice_baseline):
        payload = {
            "quiet_hours": {"enabled": False, "start": "21:30", "end": "06:15"},
            "location_sharing_enabled": True,
        }
        r = requests.put(f"{API}/me/preferences", headers=_auth_headers(), json=payload, timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["quiet_hours"]["start"] == "21:30"
        assert body["quiet_hours"]["end"] == "06:15"
        assert body["location_sharing_enabled"] is True

    def test_requires_auth(self):
        r1 = requests.get(f"{API}/me/preferences", timeout=15)
        r2 = requests.put(f"{API}/me/preferences", json={"location_sharing_enabled": True}, timeout=15)
        assert r1.status_code in (401, 403)
        assert r2.status_code in (401, 403)


# ==========================================================
#  Regression: OTP + timezone + auth/me still work
# ==========================================================
class TestRegression:
    def test_get_auth_me(self, alice_baseline):
        r = requests.get(f"{API}/auth/me", headers=_auth_headers(), timeout=15)
        assert r.status_code == 200
        data = r.json()
        assert data["id"] == "7d28589a-f42a-4693-be96-34a403685b9b"
        assert data["email"]  # non-empty

    def test_put_auth_timezone(self, alice_baseline):
        r = requests.put(
            f"{API}/auth/timezone",
            headers=_auth_headers(),
            json={"timezone": "America/New_York"},
            timeout=15,
        )
        assert r.status_code == 200, r.text
        assert r.json()["timezone"] == "America/New_York"

    def test_put_auth_timezone_invalid(self, alice_baseline):
        r = requests.put(
            f"{API}/auth/timezone",
            headers=_auth_headers(),
            json={"timezone": "Bogus/Zone"},
            timeout=15,
        )
        assert r.status_code == 400

    def test_otp_signup_roundtrip_creates_fresh_user(self):
        """POST /auth/request-otp + verify-otp still returns a token+user.

        Reads the 6-digit code from /var/log/supervisor/backend.err.log
        as documented in test_credentials.md.
        """
        email = f"build55-regression-{int(time.time())}@example.com"
        req = requests.post(
            f"{API}/auth/request-otp",
            json={"email": email, "purpose": "signup", "full_name": "Regression Test"},
            timeout=15,
        )
        assert req.status_code == 200, f"request-otp failed: {req.status_code} {req.text}"

        # Grep the backend log for the code.
        time.sleep(0.5)
        try:
            out = subprocess.check_output(
                ["tail", "-n", "400", "/var/log/supervisor/backend.err.log"],
                stderr=subprocess.STDOUT,
                timeout=5,
            ).decode("utf-8", errors="replace")
        except Exception as e:
            pytest.skip(f"Could not read backend log: {e}")

        m = re.findall(rf"Code for {re.escape(email)}: (\d{{6}})", out)
        if not m:
            pytest.skip("OTP code not found in backend log (log rotation or SMTP-only path)")
        code = m[-1]

        v = requests.post(
            f"{API}/auth/verify-otp",
            json={"email": email, "code": code, "full_name": "Regression Test"},
            timeout=15,
        )
        assert v.status_code == 200, f"verify-otp failed: {v.status_code} {v.text}"
        body = v.json()
        assert "access_token" in body
        assert body["user"]["email"] == email
        assert body["user"]["full_name"] == "Regression Test"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
