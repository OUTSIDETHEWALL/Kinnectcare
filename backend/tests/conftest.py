"""Shared test-only environment defaults."""

import os
import asyncio
import pytest


os.environ.setdefault(
    "JWT_SECRET",
    "test-suite-only-signing-secret-that-is-long-enough",
)


@pytest.fixture(autouse=True)
def legacy_ambient_event_loop():
    """asyncio.run() in historic tests must not poison later sync test loops."""
    created = False
    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        loop = None
    if loop is None or loop.is_closed():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        created = True
    yield
    if created and not loop.is_closed():
        loop.close()
        try:
            if asyncio.get_event_loop() is loop:
                asyncio.set_event_loop(None)
        except RuntimeError:
            pass