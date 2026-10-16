"""Run every backend test without allowing legacy tests to mutate live services."""
import socket
import sys
import subprocess

import pytest
import pymongo.common


def denied_network(*_args, **_kwargs):
    raise RuntimeError("OFFLINE_VERIFICATION: live network access is prohibited")


# Install before test collection: some historic integration modules perform
# HTTP setup at import time. An autouse fixture would be too late.
socket.socket.connect = denied_network
socket.socket.connect_ex = denied_network
original_popen = subprocess.Popen


def guarded_popen(args, *positional, **kwargs):
    # JWT configuration tests only import the server with an explicit local
    # test environment. Legacy mongosh/shell children must not bypass sockets.
    if args == [sys.executable, "-c", "import server"]:
        return original_popen(args, *positional, **kwargs)
    raise RuntimeError("OFFLINE_VERIFICATION: external subprocess is prohibited")


subprocess.Popen = guarded_popen
# A network-forbidden fixture cannot recover by waiting Motor's default 30s.
# Fail those live-service fixtures promptly; do not simulate successful I/O.
pymongo.common.SERVER_SELECTION_TIMEOUT = 0.01

if __name__ == "__main__":
    args = sys.argv[1:]
    # These historical HTTP suites require a separately provisioned disposable
    # server/test database. Never redirect them to production to make them green.
    live_suites = [
        "test_build38_lazy_geocoding.py", "test_build50_sos_resolve.py",
        "test_build50_hotfix_migration.py", "test_build55_me_profile_prefs.py",
        "test_build56_privacy_propagation.py", "test_build57_privacy_indicator.py",
        "test_build58_refresh_pipeline.py", "test_build59_backend.py",
        "test_build59_http_invite_acceptance.py", "test_iter3_features.py",
        "test_iter4_features.py", "test_iter5_features.py", "test_iter9_v133.py",
        "test_kinnship.py",
        "test_build59_ensure_self_member_row.py", "test_build61_invite_ghost_heal.py",
    ]
    if "--local-only" in args:
        args.remove("--local-only")
        args += [f"--ignore=backend/tests/{name}" for name in live_suites]
        print(f"LOCAL SUBSET: excluding {len(live_suites)} live-service modules; not a full-suite PASS")
    sys.exit(pytest.main([
        "backend/tests", "-q", "--continue-on-collection-errors",
        "--disable-warnings", "--tb=short", *args,
    ]))
