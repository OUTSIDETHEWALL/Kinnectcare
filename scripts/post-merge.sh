#!/bin/bash
# Post-merge setup script.
#
# Runs automatically after every task-agent merge.  Must be:
#   • Idempotent — safe to run multiple times.
#   • Non-interactive — stdin is closed.
#   • Fast — runs while the user waits (target < 60 s).
#
# Steps:
#   1. Install / sync frontend JS dependencies.
#   2. Install / sync backend Python dependencies.
#
# Add new steps here as the project grows (migrations, codegen, etc.).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "=== Post-merge setup ==="
echo "Repo root: ${REPO_ROOT}"

# ── 1. Frontend JS dependencies ───────────────────────────────────────
echo ""
echo "── Step 1: frontend dependencies (yarn install) ──"
cd "${REPO_ROOT}/frontend"
# --frozen-lockfile ensures the lockfile isn't silently updated; if a
# task agent forgot to commit a lockfile change this will fail loudly.
yarn install --frozen-lockfile --non-interactive
echo "✔  frontend dependencies ok"

# ── 2. Backend Python dependencies ────────────────────────────────────
echo ""
echo "── Step 2: backend dependencies (pip install) ──"
cd "${REPO_ROOT}/backend"
if [[ -f requirements.txt ]]; then
  pip install -q -r requirements.txt
  echo "✔  backend dependencies ok"
else
  echo "⚠  no requirements.txt found — skipping"
fi

echo ""
echo "=== Post-merge setup complete ==="
