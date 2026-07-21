#!/usr/bin/env bash
# ============================================================
# build-android.sh — safe Android native build + Play Store submit
#
# Usage (from frontend/ directory):
#   bash scripts/build-android.sh "Build 63 message"
#   yarn build:android "Build 63 message"
#
# Process (in order, aborts on first failure):
#   1. Verify git branch is main
#   2. Normalize yarn.lock (strip Replit proxy URLs)
#      If yarn.lock changed: commit it directly to main and
#      push.  This is the ONE permitted direct-to-main commit
#      because it is purely mechanical — only yarn.lock,
#      zero code change, always safe, always auditable.
#   3. Verify working tree is clean
#   4. Verify local main matches origin/main
#   5. Verify EXPO_TOKEN is set
#   6. Run EAS Android production build (--wait, blocks until done)
#   7. Submit the finished .aab to Google Play Closed Testing (Alpha)
#
# Prerequisite — one-time setup:
#   A Google Play service account key must be uploaded to the EAS
#   credentials store before step 7 will succeed.  Run:
#     EXPO_TOKEN=$EXPO_TOKEN npx eas-cli credentials
#   then: Android → app.kinnship.client → Google Service Account Key
#   → Add new key → paste the JSON.  The key is stored encrypted in
#   EAS; no file is committed to git.  See replit.md for full steps.
# ============================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✔${NC}  $*"; }
fail() { echo -e "\n${RED}✘  $*${NC}\n" >&2; exit 1; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }
info() { echo -e "${CYAN}ℹ${NC}  $*"; }
hdr()  { echo -e "\n${YELLOW}─── $* ───${NC}"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${FRONTEND_DIR}/.." && pwd)"

MESSAGE="${1:-}"
if [[ -z "$MESSAGE" ]]; then
  fail "Usage: $0 \"Build message\"\n\n   Example:\n     yarn build:android \"Build 62 — expo-battery native baseline\""
fi

# ═════════════════════════════════════════════════════════════
hdr "Step 1 — Git branch"
# ═════════════════════════════════════════════════════════════
CURRENT_BRANCH=$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  fail "Current branch is '${CURRENT_BRANCH}', not 'main'.\n\n   Native builds must be triggered from main.\n   Merge your PR first, then:\n     git checkout main && git pull origin main"
fi
ok "On branch: main"

# ═════════════════════════════════════════════════════════════
hdr "Step 2 — Normalize yarn.lock"
# ═════════════════════════════════════════════════════════════
# WHY: Replit injects its package-firewall proxy via four env
# vars (YARN_REGISTRY, YARN_NPM_REGISTRY_SERVER,
# npm_config_registry, NPM_CONFIG_REGISTRY).  Every yarn add /
# yarn install inside Replit writes the proxy URL into
# yarn.lock.  EAS cloud servers cannot reach that host.
# See scripts/normalize-lockfile.sh for full explanation.

LOCKFILE="${FRONTEND_DIR}/yarn.lock"
PROXY_URL="http://package-firewall.replit.local/npm/"
REAL_URL="https://registry.yarnpkg.com/"

BEFORE=$(grep -c "$PROXY_URL" "$LOCKFILE" 2>/dev/null || true)

if [[ "$BEFORE" -gt 0 ]]; then
  warn "${BEFORE} Replit proxy URL(s) found in yarn.lock — normalizing..."
  sed -i "s|${PROXY_URL}|${REAL_URL}|g" "$LOCKFILE"
  AFTER=$(grep -c "$PROXY_URL" "$LOCKFILE" 2>/dev/null || true)
  if [[ "$AFTER" -gt 0 ]]; then
    fail "Normalization incomplete — ${AFTER} proxy URL(s) remain in yarn.lock"
  fi
  ok "Normalized ${BEFORE} URL(s)"

  # ── Commit the normalized lockfile directly to main ────────
  # This is the ONE permitted direct-to-main commit in this
  # project.  Rationale:
  #   • Only yarn.lock changes — no source code, no logic.
  #   • The change is purely mechanical and always correct.
  #   • A PR would be redundant: there is nothing to review.
  #   • Blocking the build on a PR cycle would be worse than
  #     a clearly-labelled infrastructure commit.
  # The commit message is prefixed with "chore(lockfile):" so
  # it is unambiguously identifiable in git history.
  # ──────────────────────────────────────────────────────────
  warn "Committing normalized yarn.lock directly to main..."
  info "(chore commit — yarn.lock only, no code change)"

  git -C "$REPO_ROOT" add frontend/yarn.lock
  git -C "$REPO_ROOT" commit \
    -m "chore(lockfile): normalize Replit proxy URLs before EAS build

Replit injects package-firewall.replit.local as the npm registry
via shell env vars (YARN_REGISTRY etc.).  ${BEFORE} resolved: URL(s)
in yarn.lock pointed at the local proxy and were replaced with
https://registry.yarnpkg.com/ by scripts/build-android.sh.

Automated commit — yarn.lock only, no code change."

  git -C "$REPO_ROOT" push origin main \
    || fail "git push failed — check credentials and retry"

  ok "Normalized yarn.lock committed and pushed to main"
else
  ok "yarn.lock already clean — no proxy URLs found"
fi

# ═════════════════════════════════════════════════════════════
hdr "Step 3 — Clean working tree"
# ═════════════════════════════════════════════════════════════
GIT_STATUS=$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)
if [[ -n "$GIT_STATUS" ]]; then
  fail "Working tree is not clean:\n\n${GIT_STATUS}\n\n   Commit or stash all changes before building."
fi
ok "Working tree clean"

# ═════════════════════════════════════════════════════════════
hdr "Step 4 — main in sync with origin"
# ═════════════════════════════════════════════════════════════
git -C "$REPO_ROOT" fetch origin --quiet 2>/dev/null \
  || warn "Could not reach origin to verify sync — continuing with local state only"
LOCAL_SHA=$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo "local_unknown")
REMOTE_SHA=$(git -C "$REPO_ROOT" rev-parse origin/main 2>/dev/null || echo "remote_unknown")
if [[ "$LOCAL_SHA" != "$REMOTE_SHA" ]]; then
  fail "Local main (${LOCAL_SHA:0:7}) differs from origin/main (${REMOTE_SHA:0:7}).\n\n   Run: git pull origin main"
fi
ok "main is in sync with origin (${LOCAL_SHA:0:7})"

# ═════════════════════════════════════════════════════════════
hdr "Step 5 — EAS authentication"
# ═════════════════════════════════════════════════════════════
if [[ -z "${EXPO_TOKEN:-}" ]]; then
  fail "EXPO_TOKEN is not set.\n\n   Add it to Replit Secrets, or generate one at:\n   https://expo.dev/accounts/finalcut/settings/access-tokens"
fi
ok "EXPO_TOKEN present"

# ═════════════════════════════════════════════════════════════
hdr "Step 6 — EAS Android build (waiting for completion)"
# ═════════════════════════════════════════════════════════════
echo ""
echo "  Platform : Android"
echo "  Profile  : production"
echo "  Message  : ${MESSAGE}"
echo ""
warn "Starting build — native builds take 15–30 min. Do not interrupt."
echo ""

cd "$FRONTEND_DIR"
BUILD_OUTPUT=$(npx eas build \
  --platform android \
  --profile production \
  --non-interactive \
  --wait \
  --message "$MESSAGE" 2>&1) || fail "EAS build failed:\n\n${BUILD_OUTPUT}"

echo "$BUILD_OUTPUT"
echo ""

# Extract build ID and URL from output
BUILD_URL=$(echo "$BUILD_OUTPUT" | grep -oE 'https://expo\.dev/accounts/[^ ]+/builds/[a-f0-9-]+' | head -1 || true)
BUILD_ID=$(echo "$BUILD_URL" | grep -oE '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}' | head -1 || true)

ok "Build finished"
if [[ -n "$BUILD_URL" ]]; then
  echo "  ${BUILD_URL}"
fi
echo ""

# ═════════════════════════════════════════════════════════════
hdr "Step 7 — Submit to Google Play Closed Testing (Alpha)"
# ═════════════════════════════════════════════════════════════
# Requires: Google Play service account key uploaded to EAS credentials
# store (one-time setup — see replit.md). Track and releaseStatus are
# configured in eas.json submit.production.android.

if [[ -n "$BUILD_ID" ]]; then
  info "Submitting build ${BUILD_ID} to Play Store..."
  npx eas submit \
    --platform android \
    --id "$BUILD_ID" \
    --profile production \
    --non-interactive \
    --wait \
    || fail "EAS submit failed. If this is a credentials error, run:\n\n   EXPO_TOKEN=\$EXPO_TOKEN npx eas-cli credentials\n\n   then re-run this script."
else
  warn "Could not extract build ID from EAS output — submitting latest build instead"
  npx eas submit \
    --platform android \
    --latest \
    --profile production \
    --non-interactive \
    --wait \
    || fail "EAS submit failed. If this is a credentials error, run:\n\n   EXPO_TOKEN=\$EXPO_TOKEN npx eas-cli credentials\n\n   then re-run this script."
fi

# ═════════════════════════════════════════════════════════════
hdr "Done"
# ═════════════════════════════════════════════════════════════
echo ""
ok "Build compiled and submitted to Google Play Closed Testing (Alpha)"
ok "Google Play processing typically takes 2–60 min"
ok "Testers on the Closed Testing track will receive the update automatically"
echo ""
echo "  Play Console: https://play.google.com/console"
echo ""
ok "Next: verify on Play Console that the new versionCode appears on the Alpha track"
