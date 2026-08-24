"""Shared test-only environment defaults."""

import os


os.environ.setdefault(
    "JWT_SECRET",
    "test-suite-only-signing-secret-that-is-long-enough",
)