import asyncio
import importlib.util
import functools
import pathlib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "startup_request_trace", pathlib.Path(__file__).parents[1] / "backend/startup_request_trace.py"
)
trace = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trace)


def isolated_test(function):
    @functools.wraps(function)
    def run(self):
        # Never set/clear the ambient loop used by legacy synchronous tests.
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(function(self))
        finally:
            loop.close()
    return run


class StartupRequestTraceTests(unittest.TestCase):
    async def exercise(self, headers=(), path="/api/members", error=None):
        body = {"type": "http.response.body", "body": b"unchanged", "more_body": False}
        messages = [{"type": "http.response.start", "status": 200, "headers": []}, body]
        sent = []
        received = object()
        async def receive():
            return received
        async def app(scope, incoming, send):
            self.assertIs(await incoming(), received)
            if error is not None:
                raise error
            for message in messages:
                await send(message)
        async def send(message):
            sent.append(message)
        middleware = trace.StartupRequestTraceMiddleware(app)
        with patch.object(trace.logger, "info") as log:
            try:
                await middleware({"type": "http", "method": "GET", "path": path, "headers": headers}, receive, send)
            except BaseException as caught:
                self.assertIs(caught, error)
                return log
        for actual, original in zip(sent, messages):
            self.assertIs(actual, original)
        self.assertEqual(sent, messages)
        return log

    @isolated_test
    async def test_unmarked_and_invalid_requests_are_not_logged(self):
        for header in ([], [(b"x-kinnship-startup-trace", b"bad\nsecret")]):
            self.assertEqual((await self.exercise(header)).call_count, 0)

    @isolated_test
    async def test_allowlisted_id_correlates_without_body_or_credentials(self):
        log = await self.exercise([
            (b"x-kinnship-startup-trace", b"a" * 32),
            (b"authorization", b"Bearer must-never-log"),
            (b"x-railway-request-id", b"edge_123"),
        ])
        self.assertEqual(log.call_count, 3)
        text = str(log.call_args_list)
        self.assertIn("edge_123", text)
        self.assertNotIn("must-never-log", text)
        self.assertNotIn("unchanged", text)

    @isolated_test
    async def test_nonstartup_path_is_not_traced(self):
        self.assertEqual((await self.exercise(
            [(b"x-kinnship-startup-trace", b"a" * 32)], path="/api/members/private/location"
        )).call_count, 0)

    @isolated_test
    async def test_original_failure_and_cancellation_identity_survive(self):
        for error in (ValueError("private detail"), asyncio.CancelledError()):
            log = await self.exercise([(b"x-kinnship-startup-trace", b"a" * 32)], error=error)
            self.assertEqual(log.call_count, 2)
            self.assertNotIn("private detail", str(log.call_args_list))

    @isolated_test
    async def test_logger_failure_does_not_change_response(self):
        with patch.object(trace.logger, "info", side_effect=RuntimeError("logger down")):
            # Exercise directly to avoid the inner helper mock overriding this mock.
            sent = []
            async def app(scope, receive, send):
                await send({"type": "http.response.body", "body": b"same"})
            async def send(message):
                sent.append(message)
            await trace.StartupRequestTraceMiddleware(app)(
                {"type": "http", "method": "GET", "path": "/api/members",
                 "headers": [(b"x-kinnship-startup-trace", b"a" * 32)]}, None, send
            )
            self.assertEqual(sent[0]["body"], b"same")

    @isolated_test
    async def test_observer_budget_never_limits_requests(self):
        calls = []
        async def app(scope, receive, send):
            calls.append(scope)
        middleware = trace.StartupRequestTraceMiddleware(app)
        scope = {"type": "http", "method": "GET", "path": "/api/members",
                 "headers": [(b"x-kinnship-startup-trace", b"a" * 32)]}
        with patch.object(trace.logger, "info") as log, patch.object(trace.time, "monotonic_ns", return_value=60_000_000_000):
            for _ in range(40):
                await middleware(scope, None, None)
        self.assertEqual(len(calls), 40)
        self.assertEqual(log.call_count, 32)
