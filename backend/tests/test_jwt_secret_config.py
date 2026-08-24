"""Startup guard coverage for JWT signing configuration."""

import os
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
PROJECT_ROOT = BACKEND_DIR.parent
INSECURE_FALLBACK = "kinnship-dev-secret-change-in-prod"
VALID_SECRET = "a-secure-test-jwt-signing-secret-value"
SERVER_DIRS = (BACKEND_DIR, PROJECT_ROOT)


def _import_server(
    server_dir: Path,
    jwt_secret: str | None,
) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env.update({
        "MONGO_URL": "mongodb://localhost:27017",
        "DB_NAME": "kinnship_test",
    })
    if jwt_secret is None:
        env.pop("JWT_SECRET", None)
    else:
        env["JWT_SECRET"] = jwt_secret

    return subprocess.run(
        [sys.executable, "-c", "import server"],
        cwd=server_dir,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


@pytest.mark.parametrize("server_dir", SERVER_DIRS)
def test_server_refuses_to_start_without_jwt_secret(server_dir: Path):
    result = _import_server(server_dir, None)

    assert result.returncode != 0
    assert "JWT_SECRET must be an explicit" in result.stderr


@pytest.mark.parametrize("server_dir", SERVER_DIRS)
def test_server_refuses_to_start_with_blank_jwt_secret(server_dir: Path):
    result = _import_server(server_dir, "   ")

    assert result.returncode != 0
    assert "JWT_SECRET must be an explicit" in result.stderr


@pytest.mark.parametrize("server_dir", SERVER_DIRS)
def test_server_refuses_to_start_with_the_development_fallback(server_dir: Path):
    result = _import_server(server_dir, INSECURE_FALLBACK)

    assert result.returncode != 0
    assert "JWT_SECRET must be an explicit" in result.stderr


@pytest.mark.parametrize("server_dir", SERVER_DIRS)
def test_server_refuses_to_start_with_a_short_jwt_secret(server_dir: Path):
    result = _import_server(server_dir, "test-secret")

    assert result.returncode != 0
    assert "at least 32 characters" in result.stderr


@pytest.mark.parametrize("server_dir", SERVER_DIRS)
def test_server_starts_with_a_sufficiently_long_jwt_secret(server_dir: Path):
    result = _import_server(server_dir, VALID_SECRET)

    assert result.returncode == 0, result.stderr