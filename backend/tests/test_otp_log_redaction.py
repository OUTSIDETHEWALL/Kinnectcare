"""Execute the real email helpers without importing server startup or using a
database/network. Cover both independently deployable server entrypoints.
"""
import ast
import logging
import smtplib
from email.message import EmailMessage
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock

import pytest


ROOT = Path(__file__).resolve().parents[2]
CODE = "613927"
EMAIL = "test@example.com"
HELPERS = {
    "_otp_email_body", "_send_email_via_resend", "_send_otp_via_resend",
    "_send_otp_via_smtp", "_deliver_otp_email", "_deliver_otp_email_sync",
}


@pytest.fixture(params=["backend/server.py", "server.py"])
def helpers(request):
    tree = ast.parse((ROOT / request.param).read_text())
    functions = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in HELPERS]
    assert {node.name for node in functions} == HELPERS
    constants = [node for node in tree.body if isinstance(node, ast.Assign)
                 and any(isinstance(target, ast.Name) and target.id == "OTP_TTL_MINUTES" for target in node.targets)]
    assert len(constants) == 1
    namespace = {
        "os": SimpleNamespace(environ={}),
        "logger": logging.getLogger("otp-redaction"),
        "requests": SimpleNamespace(post=Mock()),
        "smtplib": SimpleNamespace(SMTP=MagicMock()),
        "EmailMessage": EmailMessage,
    }
    # Defer annotations, just as a module with future annotations would.
    import __future__
    exec(compile(ast.Module(body=constants + functions, type_ignores=[]), request.param, "exec",
                 flags=__future__.annotations.compiler_flag), namespace)
    namespace["entrypoint"] = request.param
    return namespace


def assert_redacted(caplog):
    assert CODE not in caplog.text
    assert "SMTPDataError" in caplog.text or "OTP" in caplog.text


@pytest.mark.parametrize("purpose", ["login", "signup"])
def test_resend_failure_and_provider_echo_do_not_log_code(helpers, caplog, purpose):
    helpers["os"].environ.update(RESEND_API_KEY="test-only", RESEND_FROM="sender@example.com")
    post = helpers["requests"].post
    post.return_value = SimpleNamespace(status_code=422, text=f"Rejected body containing {CODE}")
    with caplog.at_level(logging.INFO):
        assert helpers["_send_otp_via_resend"](EMAIL, CODE, purpose) is False
    assert_redacted(caplog)
    payload = post.call_args.kwargs["json"]
    assert CODE in payload["text"]  # Redact logs, not the message sent to the user.
    assert payload["to"] == [EMAIL]
    assert post.call_args.kwargs["timeout"] == 15


def test_resend_exception_cannot_echo_code(helpers, caplog):
    helpers["os"].environ.update(RESEND_API_KEY="test-only", RESEND_FROM="sender@example.com")
    helpers["requests"].post.side_effect = RuntimeError(f"transport echoed {CODE}")
    assert helpers["_send_otp_via_resend"](EMAIL, CODE, "login") is False
    assert_redacted(caplog)
    assert "RuntimeError" in caplog.text


def test_smtp_failure_cannot_echo_code(helpers, caplog):
    helpers["os"].environ.update(SMTP_HOST="test.invalid", SMTP_USER="test", SMTP_PASSWORD="test-only")
    helpers["smtplib"].SMTP.return_value.__enter__.return_value.send_message.side_effect = smtplib.SMTPDataError(
        550, f"rejected message {CODE}".encode(),
    )
    assert helpers["_send_otp_via_smtp"](EMAIL, CODE, "login") is False
    assert_redacted(caplog)


def test_smtp_success_still_sends_code(helpers, caplog):
    helpers["os"].environ.update(SMTP_HOST="test.invalid", SMTP_USER="test", SMTP_PASSWORD="test-only")
    assert helpers["_send_otp_via_smtp"](EMAIL, CODE, "login") is True
    smtp = helpers["smtplib"].SMTP.return_value.__enter__.return_value
    assert CODE in smtp.send_message.call_args.args[0].get_content()
    assert CODE not in caplog.text


def test_resend_success_still_sends_code(helpers, caplog):
    helpers["os"].environ.update(RESEND_API_KEY="test-only", RESEND_FROM="sender@example.com")
    helpers["requests"].post.return_value = SimpleNamespace(status_code=200)
    assert helpers["_send_otp_via_resend"](EMAIL, CODE, "login") is True
    assert CODE in helpers["requests"].post.call_args.kwargs["json"]["text"]
    assert CODE not in caplog.text


@pytest.mark.asyncio
async def test_async_no_transport_fails_without_exposing_code(helpers, caplog):
    assert await helpers["_deliver_otp_email"](EMAIL, CODE, "login") is False
    assert_redacted(caplog)
    helpers["requests"].post.assert_not_called()
    helpers["smtplib"].SMTP.assert_not_called()


@pytest.mark.parametrize("resend_ok,smtp_ok,transport", [
    (True, False, "resend"), (False, True, "smtp"), (False, False, "none"),
])
def test_sync_delivery_preserves_build78_transport_contract(helpers, caplog, resend_ok, smtp_ok, transport):
    helpers["_send_otp_via_resend"] = Mock(return_value=resend_ok)
    helpers["_send_otp_via_smtp"] = Mock(return_value=smtp_ok)
    result = helpers["_deliver_otp_email_sync"](EMAIL, CODE, "login")
    if helpers["entrypoint"] == "backend/server.py":
        assert result == (transport != "none", transport)
    else:
        assert result is None  # Preserve the historic root entrypoint contract.
    helpers["_send_otp_via_resend"].assert_called_once_with(EMAIL, CODE, "login")
    if resend_ok:
        helpers["_send_otp_via_smtp"].assert_not_called()
    else:
        helpers["_send_otp_via_smtp"].assert_called_once_with(EMAIL, CODE, "login")
    assert CODE not in caplog.text
