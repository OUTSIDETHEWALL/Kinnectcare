#!/usr/bin/env bash
# ============================================================
# publish-ota.sh — safe OTA publish with pre-flight verification
#
# Usage (from frontend/ directory):
#   bash scripts/publish-ota.sh "Your update message here"
#   yarn ota:publish "Your update message here"
#
# Process (in order, aborts on first failure):
#   1. Verify .env.production exists and contains the backend URL
#   2. Verify @expo/env actually loads it from the file
#      (shell env vars are silently ignored by Metro — file is the
#      only valid input to babel-preset-expo's EXPO_PUBLIC_ inlining)
#   3. Verify the URL points to the expected Railway domain
#   4. Verify the production backend is live and healthy right now
#   5. Verify EXPO_TOKEN is available for EAS auth
#   6. Clear Metro cache unconditionally
#      (.metro-cache/ holds stale babel transforms that preserve
#      whatever was baked in at last transform time — always wipe it
#      so Metro re-runs babel with the current .env values)
#   7. Run eas update, capture and display the bundle hashes
#   8. Print the OTA group ID and next verification steps
#
# A broken OTA is worse than no OTA. Every step that can be
# verified before publishing IS verified before publishing.
# ============================================================

set -euo pipefail

# ── colour helpers ────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✔${NC}  $*"; }
fail() { echo -e "\n${RED}✘  $*${NC}\n"; exit 1; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }
info() { echo -e "${CYAN}ℹ${NC}  $*"; }
hdr()  { echo -e "\n${YELLOW}─── $* ───${NC}"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CACHE_DIR="${FRONTEND_DIR}/.metro-cache"
ENV_FILE="${FRONTEND_DIR}/.env.production"
EXPECTED_DOMAIN="kinnectcare-production.up.railway.app"

# ── Require a message ─────────────────────────────────────────
MESSAGE="${1:-}"
if [[ -z "$MESSAGE" ]]; then
  fail "Usage: $0 \"Your update message\"\n   A descriptive message is required."
fi

# ═════════════════════════════════════════════════════════════
hdr "Step 0 — Git state verification"
# ═════════════════════════════════════════════════════════════
# WHY: OTAs must always be published from a clean, up-to-date
# main branch so that repository history, production code, and
# the deployed OTA are perfectly synchronised. Publishing from
# a feature branch means unreviewed code reaches devices before
# it is merged — even if that code works, it severs the audit
# trail that lets us reason about what is actually running in
# production. All four checks must pass or the script aborts.

# Check 1 — must be on main
CURRENT_BRANCH=$(git -C "$FRONTEND_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  fail "Current branch is '${CURRENT_BRANCH}', not 'main'.\n\n   OTAs may only be published from main.\n   Merge your PR first, then:\n     git checkout main && git pull origin main"
fi
ok "On branch: main"

# Check 2 — working tree must be clean
GIT_STATUS=$(git -C "$FRONTEND_DIR" status --porcelain 2>/dev/null)
if [[ -n "$GIT_STATUS" ]]; then
  fail "Working tree is not clean. Commit or stash all changes before publishing.\n\n${GIT_STATUS}"
fi
ok "Working tree clean"

# Check 3 — local main must match origin/main
git -C "$FRONTEND_DIR" fetch origin --quiet 2>/dev/null \
  || warn "Could not reach origin to verify sync — continuing with local state only"
LOCAL_SHA=$(git -C "$FRONTEND_DIR" rev-parse HEAD 2>/dev/null || echo "local_unknown")
REMOTE_SHA=$(git -C "$FRONTEND_DIR" rev-parse origin/main 2>/dev/null || echo "remote_unknown")
if [[ "$LOCAL_SHA" != "$REMOTE_SHA" ]]; then
  fail "Local main (${LOCAL_SHA:0:7}) is not up to date with origin/main (${REMOTE_SHA:0:7}).\n\n   Run: git pull origin main\n   Then verify the PR is already merged before retrying."
fi
ok "main is up to date with origin/main (${LOCAL_SHA:0:7})"

# ═════════════════════════════════════════════════════════════
hdr "Step 1 — .env.production file"
# ═════════════════════════════════════════════════════════════
# WHY: @expo/env (Expo SDK 50+) reads EXPO_PUBLIC_* ONLY from
# .env files. Shell env vars are explicitly skipped at line
# 197-203 of @expo/env/build/index.js. A missing file means
# babel-preset-expo inlines `undefined` for every EXPO_PUBLIC_*
# reference in the bundle.

if [[ ! -f "$ENV_FILE" ]]; then
  fail ".env.production not found: ${ENV_FILE}\n\n   Create it:\n     echo 'EXPO_PUBLIC_BACKEND_URL=https://${EXPECTED_DOMAIN}' \\\n          > frontend/.env.production"
fi
ok ".env.production exists"

FILE_URL=$(grep -E '^EXPO_PUBLIC_BACKEND_URL=' "$ENV_FILE" \
           | head -1 | cut -d'=' -f2- | tr -d '[:space:]')

if [[ -z "$FILE_URL" ]]; then
  fail "EXPO_PUBLIC_BACKEND_URL not found in ${ENV_FILE}\n\n   Add:\n     EXPO_PUBLIC_BACKEND_URL=https://${EXPECTED_DOMAIN}"
fi
ok "EXPO_PUBLIC_BACKEND_URL = ${FILE_URL}"

# ═════════════════════════════════════════════════════════════
hdr "Step 2 — @expo/env file-load verification"
# ═════════════════════════════════════════════════════════════
# WHY: The file existing is necessary but not sufficient.
# @expo/env must successfully parse it with NODE_ENV=production
# so it loads .env.production. We call parseProjectEnv() which
# returns ONLY file-sourced values (never shell env), giving us
# the same input that babel-preset-expo will receive at bundle
# time. If this check passes, the URL WILL be inlined correctly.

warn "Calling @expo/env parseProjectEnv (NODE_ENV=production) ..."
PARSED_URL=$(cd "$FRONTEND_DIR" && NODE_ENV=production node -e "
  try {
    const { parseProjectEnv } = require('@expo/env');
    const result = parseProjectEnv(process.cwd());
    const url = result.env['EXPO_PUBLIC_BACKEND_URL'];
    process.stdout.write(url || '');
  } catch(e) {
    process.stderr.write('parseProjectEnv error: ' + e.message + '\n');
    process.exit(1);
  }
" 2>/tmp/ota_env_check_err)

ENV_ERR=$(cat /tmp/ota_env_check_err 2>/dev/null || echo '')
if [[ -n "$ENV_ERR" ]]; then
  fail "@expo/env threw an error:\n   ${ENV_ERR}"
fi
if [[ -z "$PARSED_URL" ]]; then
  fail "@expo/env loaded an empty EXPO_PUBLIC_BACKEND_URL from .env files.\n\n   The file exists but @expo/env cannot read the value. This means\n   babel-preset-expo will inline 'undefined' into the bundle.\n\n   Check .env.production syntax — lines must be KEY=VALUE with no\n   spaces around '=' and no shell quoting:\n     EXPO_PUBLIC_BACKEND_URL=https://${EXPECTED_DOMAIN}"
fi
ok "@expo/env confirms URL will be inlined: ${PARSED_URL}"

# ═════════════════════════════════════════════════════════════
hdr "Step 3 — URL domain validation"
# ═════════════════════════════════════════════════════════════
if [[ "$PARSED_URL" != https://* ]]; then
  fail "URL must start with https://\n   Got: ${PARSED_URL}"
fi
if [[ "$PARSED_URL" != *"${EXPECTED_DOMAIN}"* ]]; then
  fail "URL does not contain the expected Railway domain.\n   Expected : ${EXPECTED_DOMAIN}\n   Got      : ${PARSED_URL}\n\n   If Railway URL changed, update EXPECTED_DOMAIN in this script."
fi
ok "URL points to expected Railway domain"

# ═════════════════════════════════════════════════════════════
hdr "Step 4 — Backend health check"
# ═════════════════════════════════════════════════════════════
# WHY: Never publish an OTA that points at a downed backend.
# Devices on the new bundle will fail every API call immediately.

HEALTH_URL="${PARSED_URL}/api/health"
warn "Probing ${HEALTH_URL} ..."
HTTP_CODE=$(curl -s -o /tmp/ota_health_body.json -w "%{http_code}" \
            --max-time 15 "$HEALTH_URL" 2>/dev/null || echo "000")
HEALTH_BODY=$(cat /tmp/ota_health_body.json 2>/dev/null || echo '')

if [[ "$HTTP_CODE" != "200" ]]; then
  fail "Backend health check failed (HTTP ${HTTP_CODE}).\n   URL      : ${HEALTH_URL}\n   Response : ${HEALTH_BODY}\n\n   Investigate the Railway deployment before publishing."
fi
if [[ "$HEALTH_BODY" != *'"ok":true'* ]]; then
  fail "Backend returned 200 but payload is unexpected.\n   Got: ${HEALTH_BODY}\n   Expected JSON with '\"ok\":true'"
fi
ok "Backend healthy — ${HTTP_CODE} ${HEALTH_BODY}"

# ═════════════════════════════════════════════════════════════
hdr "Step 5 — EAS authentication"
# ═════════════════════════════════════════════════════════════
if [[ -z "${EXPO_TOKEN:-}" ]]; then
  fail "EXPO_TOKEN is not set.\n\n   Add it to Replit Secrets, or generate one at:\n   https://expo.dev/accounts/finalcut/settings/access-tokens"
fi
ok "EXPO_TOKEN present"

# ═════════════════════════════════════════════════════════════
hdr "Step 6 — Clear Metro cache"
# ═════════════════════════════════════════════════════════════
# WHY: metro.config.js uses a FileStore cache (.metro-cache/).
# Metro skips re-transforming unchanged source files, serving
# cached babel output instead. If the cache was built before
# .env.production existed, those cached modules contain
# 'undefined' baked in — even if .env.production is now correct.
# We always wipe the cache so every publish gets a fresh
# babel transform with the current .env values.
# Cost: ~40s extra build time. Worth it for correctness.

if [[ -d "$CACHE_DIR" ]]; then
  CACHE_SIZE=$(du -sh "$CACHE_DIR" 2>/dev/null | cut -f1 || echo "?")
  warn "Clearing Metro cache (${CACHE_SIZE}): ${CACHE_DIR}"
  rm -rf "$CACHE_DIR"
  ok "Metro cache cleared"
else
  ok "Metro cache already empty"
fi

# ═════════════════════════════════════════════════════════════
hdr "Step 7 — Publish OTA"
# ═════════════════════════════════════════════════════════════
echo ""
echo "  Channel : production"
echo "  URL     : ${PARSED_URL}"
echo "  Message : ${MESSAGE}"
echo ""

# Capture output so we can extract bundle hashes and OTA group ID
EAS_OUT_FILE=/tmp/ota_publish_output.txt
cd "$FRONTEND_DIR"
npx eas update \
  --channel production \
  --message "$MESSAGE" \
  --non-interactive 2>&1 | tee "$EAS_OUT_FILE"

# ═════════════════════════════════════════════════════════════
hdr "Step 8 — Post-publish summary"
# ═════════════════════════════════════════════════════════════
# Extract key identifiers from eas output for verification log.
GROUP_ID=$(grep -o 'Update group ID.*' "$EAS_OUT_FILE" \
           | head -1 | awk '{print $NF}' || echo "unknown")
ANDROID_HASH=$(grep -o 'entry-[a-f0-9]*\.hbc' "$EAS_OUT_FILE" \
               | grep android || grep -o 'entry-[a-f0-9]*\.hbc' "$EAS_OUT_FILE" \
               | head -1 || echo "unknown")
IOS_HASH=$(grep -o 'entry-[a-f0-9]*\.hbc' "$EAS_OUT_FILE" \
           | grep ios || grep -o 'entry-[a-f0-9]*\.hbc' "$EAS_OUT_FILE" \
           | tail -1 || echo "unknown")

echo ""
ok "OTA published"
echo ""
echo "  OTA group ID    : ${GROUP_ID}"
echo "  Android bundle  : ${ANDROID_HASH}"
echo "  iOS bundle      : ${IOS_HASH}"
echo ""
info "If this bundle hash matches any previous OTA, Metro may have"
info "served a stale cache despite step 6. Re-run the script to confirm."
echo ""
ok "Next: force-kill both apps, relaunch twice to download + apply."
ok "Verify on device: Me → Software → OTA ID shows ${GROUP_ID:0:8}…"
ok "Verify connectivity: tap 'Email me a code' — must succeed."
