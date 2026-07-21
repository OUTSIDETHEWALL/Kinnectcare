#!/usr/bin/env bash
# ============================================================
# normalize-lockfile.sh — strip Replit's internal proxy URLs
# from yarn.lock so EAS cloud builds can resolve packages.
#
# WHY THIS EXISTS
# ───────────────
# Replit injects its package-firewall proxy through four shell
# environment variables that are set at the container level
# (not in any config file you can edit):
#
#   YARN_REGISTRY            = http://package-firewall.replit.local/npm/
#   YARN_NPM_REGISTRY_SERVER = http://package-firewall.replit.local/npm/
#   npm_config_registry      = http://package-firewall.replit.local/npm/
#   NPM_CONFIG_REGISTRY      = http://package-firewall.replit.local/npm/
#
# Every `yarn add` or `yarn install` inside Replit resolves
# packages through the local proxy and writes the proxy URL
# into yarn.lock's `resolved:` fields.  The proxy is invisible
# to developers because it faithfully serves the same bytes as
# the real registry — but EAS cloud build servers have no
# route to `package-firewall.replit.local`, so
# `yarn install --frozen-lockfile` fails before a single line
# of native code compiles.
#
# THE FIX
# ───────
# Replace all proxy resolved: URLs with the canonical Yarn
# registry.  This is safe because:
#   • The SHA1 fragment after # in the resolved URL is a cache
#     key computed from the tarball content — same bytes, same
#     hash, regardless of which host served them.
#   • The `integrity sha512-…` field is also content-based and
#     remains valid after the URL replacement.
#   • `yarn install --frozen-lockfile` verifies integrity, not
#     the source URL, so the build proceeds cleanly.
#
# USAGE
# ─────
#   bash scripts/normalize-lockfile.sh    # run directly
#   yarn normalize-lockfile               # via npm script
#
# EXIT CODES
#   0 — already clean (no proxy URLs found)
#   0 — normalized successfully
#   1 — sed or file not found error
# ============================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✔${NC}  $*"; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }
info() { echo -e "${CYAN}ℹ${NC}  $*"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOCKFILE="${FRONTEND_DIR}/yarn.lock"

PROXY_URL="http://package-firewall.replit.local/npm/"
REAL_URL="https://registry.yarnpkg.com/"

if [[ ! -f "$LOCKFILE" ]]; then
  echo -e "${RED}✘${NC}  yarn.lock not found: ${LOCKFILE}" >&2
  exit 1
fi

# Count proxy URLs before replacement
BEFORE=$(grep -c "$PROXY_URL" "$LOCKFILE" 2>/dev/null || true)

if [[ "$BEFORE" -eq 0 ]]; then
  ok "yarn.lock is already clean — no Replit proxy URLs found"
  exit 0
fi

warn "Found ${BEFORE} Replit proxy URL(s) in yarn.lock — normalizing..."
info "  ${PROXY_URL}"
info "→ ${REAL_URL}"

# Replace all occurrences in place
sed -i "s|${PROXY_URL}|${REAL_URL}|g" "$LOCKFILE"

# Verify
AFTER=$(grep -c "$PROXY_URL" "$LOCKFILE" 2>/dev/null || true)
if [[ "$AFTER" -gt 0 ]]; then
  echo -e "${RED}✘${NC}  Normalization incomplete — ${AFTER} proxy URL(s) remain" >&2
  exit 1
fi

ok "Normalized ${BEFORE} URL(s) → yarn.lock is clean"
