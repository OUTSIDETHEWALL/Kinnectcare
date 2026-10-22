"""Bounded, opt-in startup request correlation; never reads bodies or credentials."""
import logging
import queue
import re
import threading
import time

logger = logging.getLogger("kinnship.startup_request_trace")
TRACE = re.compile(r"^[a-f0-9]{32}$")
EDGE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
PATHS = frozenset(("/api/auth/me", "/api/members", "/api/summary", "/api/alerts"))


class StartupRequestTraceMiddleware:
    def __init__(self, app):
        self.app = app
        self._window = 0
        self._claims = 0
        self._records = queue.Queue(maxsize=96)
        self._dropped = 0
        self._write_failures = 0
        self._budget_dropped = 0
        self._writer = threading.Thread(target=self._write_records, name="startup-trace-writer", daemon=True)
        self._writer.start()

    def _write_records(self):
        while True:
            record = self._records.get()
            try:
                if record is None:  # Local-test cleanup; process shutdown owns production lifetime.
                    return
                logger.info(
                    "startup_request_trace id=%s edge=%s endpoint=%s stage=%s elapsed_ms=%.3f status=%s observer_dropped=%s observer_write_failures=%s observer_budget_dropped=%s",
                    *record, self._dropped, self._write_failures, self._budget_dropped,
                )
            except Exception:
                self._write_failures += 1
            finally:
                self._records.task_done()

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("method") != "GET" or scope.get("path") not in PATHS:
            return await self.app(scope, receive, send)
        headers = dict(scope.get("headers", ()))
        trace_id = headers.get(b"x-kinnship-startup-trace", b"").decode("ascii", errors="replace")
        if not TRACE.fullmatch(trace_id):
            return await self.app(scope, receive, send)
        # Only bound the observer, never requests. No wait, retry or rejection.
        minute = time.monotonic_ns() // 60_000_000_000
        if minute != self._window:
            self._window, self._claims = minute, 0
        if self._claims >= 32:
            self._budget_dropped += 1
            return await self.app(scope, receive, send)
        self._claims += 1
        edge_id = headers.get(b"x-railway-request-id", b"").decode("ascii", errors="replace")
        if not EDGE.fullmatch(edge_id):
            edge_id = ""
        started = time.monotonic_ns()

        def record(stage, status=None):
            try:
                # Timestamp on the request path; formatting/handlers/IO never run there.
                self._records.put_nowait((trace_id, edge_id, scope["path"], stage,
                                         (time.monotonic_ns() - started) / 1_000_000, status))
            except queue.Full:
                self._dropped += 1

        async def observed_send(message):
            if message["type"] == "http.response.start":
                record("response_headers", message["status"])
            # Preserve object identity, streaming, backpressure and exception identity.
            await send(message)
            if message["type"] == "http.response.body" and not message.get("more_body", False):
                record("response_handed_to_server")

        record("backend_received")
        try:
            await self.app(scope, receive, observed_send)
        except BaseException:
            record("backend_failed")
            raise
