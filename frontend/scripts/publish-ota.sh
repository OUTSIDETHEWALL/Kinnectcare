#!/usr/bin/env bash
# ============================================================
# publish-ota.sh — safe OTA publish with pre-flight checks
#
# Usage:
#   ./scripts/publish-ota.sh "Your update message here"
#
# Runs from the frontend/ directory (or via `yarn ota:publish`).
#
# What it checks before touching EAS:
#   1. EXPO_PUBLIC_BACKEND_URL is set and non-empty
#   2. EXPO_PUBLIC_BACKEND_URL points to the expected Railway domain
#   3. The production backend is reachable and healthy right now
#   4. EXPO_TOKEN is available for EAS authentication
#
# If any check fails the script exits with a non-zero code and
# prints a clear, actionable error. It never calls eas update
# when a check is missing — a broken OTA is worse than no OTA.
# ============================================================

set -euo pipefail

# ── colour helpers ──────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # no colour

ok()   { echo -e "${GREEN}✔${NC}  $*"; }
fail() { echo -e "${RED}✘  $*${NC}"; exit 1; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }
hdr()  { echo -e "\n${YELLOW}── $* ──${NC}"; }

# ── message argument ────────────────────────────────────────
MESSAGE="${1:-}"
if [[ -z "$MESSAGE" ]]; then
  fail "Usage: $0 \"Your update message\"\n   A descriptive message is required — it appears in the EAS dashboard and Git history."
fi

hdr "Pre-flight checks"

# ── 1. EXPO_PUBLIC_BACKEND_URL must be set ──────────────────
if [[ -z "${EXPO_PUBLIC_BACKEND_URL:-}" ]]; then
  fail "EXPO_PUBLIC_BACKEND_URL is not set.\n\n   Metro inlines this variable at bundle time. A missing value produces\n   baseURL = \"undefined/api\" and breaks every API call on every device.\n\n   Fix: ensure EXPO_PUBLIC_BACKEND_URL is set in the Replit environment\n   or export it before running this script:\n\n     export EXPO_PUBLIC_BACKEND_URL=https://kinnectcare-production.up.railway.app\n"
fi
ok "EXPO_PUBLIC_BACKEND_URL is set: ${EXPO_PUBLIC_BACKEND_URL}"

# ── 2. Must point to the expected Railway domain ────────────
EXPECTED_DOMAIN="kinnectcare-production.up.railway.app"
if [[ "${EXPO_PUBLIC_BACKEND_URL}" != https://* ]]; then
  fail "EXPO_PUBLIC_BACKEND_URL must start with https://\n   Got: ${EXPO_PUBLIC_BACKEND_URL}"
fi
if [[ "${EXPO_PUBLIC_BACKEND_URL}" != *"${EXPECTED_DOMAIN}"* ]]; then
  fail "EXPO_PUBLIC_BACKEND_URL does not contain the expected Railway domain.\n   Expected domain : ${EXPECTED_DOMAIN}\n   Got             : ${EXPO_PUBLIC_BACKEND_URL}\n\n   If the Railway URL has changed, update EXPECTED_DOMAIN in this script."
fi
ok "URL points to expected Railway domain"

# ── 3. Backend health check ─────────────────────────────────
HEALTH_URL="${EXPO_PUBLIC_BACKEND_URL}/api/health"
warn "Probing ${HEALTH_URL} ..."
HTTP_CODE=$(curl -s -o /tmp/ota_health_response.json -w "%{http_code}" --max-time 15 "${HEALTH_URL}" 2>/dev/null || echo "000")

if [[ "$HTTP_CODE" != "200" ]]; then
  fail "Backend health check failed (HTTP ${HTTP_CODE}).\n\n   URL probed : ${HEALTH_URL}\n   Response   : $(cat /tmp/ota_health_response.json 2>/dev/null || echo '(no response)')\n\n   Do not publish an OTA when the backend is unreachable — clients\n   running the new bundle will immediately get Network Errors.\n   Investigate the Railway deployment first."
fi

HEALTH_BODY=$(cat /tmp/ota_health_response.json 2>/dev/null || echo '')
if [[ "$HEALTH_BODY" != *'"ok":true'* ]]; then
  fail "Backend responded 200 but health payload looks wrong.\n   Got: ${HEALTH_BODY}\n   Expected JSON containing '\"ok\":true'."
fi
ok "Backend is healthy (${HTTP_CODE} ${HEALTH_BODY})"

# ── 4. EXPO_TOKEN must be available ────────────────────────
if [[ -z "${EXPO_TOKEN:-}" ]]; then
  fail "EXPO_TOKEN is not set.\n\n   EAS requires an access token to publish. Generate one at:\n   https://expo.dev/accounts/finalcut/settings/access-tokens\n\n   Then set it in the Replit Secrets panel as EXPO_TOKEN."
fi
ok "EXPO_TOKEN is present"

# ── All checks passed ───────────────────────────────────────
hdr "Publishing OTA"
echo "  Channel : production"
echo "  Backend : ${EXPO_PUBLIC_BACKEND_URL}"
echo "  Message : ${MESSAGE}"
echo ""

npx eas update \
  --channel production \
  --message "${MESSAGE}" \
  --non-interactive

echo ""
ok "OTA published. Force-kill and relaunch both test devices to apply."
ok "Verify: Me tab → Software → OTA Status: Installed + correct OTA ID."
