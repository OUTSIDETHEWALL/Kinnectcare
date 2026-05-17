"""Twilio SMS module for Kinnship.

Sends transactional SMS (e.g. SOS alerts) to designated emergency contacts.

Behaviour:
  - When the three env vars TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and
    TWILIO_PHONE_NUMBER are all present, the module switches to LIVE mode and
    actually delivers messages via the Twilio REST API.
  - Otherwise it switches to MOCK mode: every send is logged at INFO level
    (prefix ``[SMS-MOCK]``) so you can see exactly what *would* have been sent.
    No external network calls are made and no exceptions are raised on send.

Public API (all coroutines safe to call from FastAPI background tasks):
  - ``is_configured()`` → bool — True if all env vars set (live mode).
  - ``normalize_e164(raw)`` → "+15555550100" or None when un-parseable.
  - ``send_sms(to, body, *, fire_and_forget=False)`` → dict result.
  - ``send_sms_to_many(numbers, body)`` → list of per-recipient result dicts.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
from typing import Iterable, List, Optional

logger = logging.getLogger(__name__)

# ---------- Env / mode ----------
def _env(key: str) -> Optional[str]:
    v = os.getenv(key)
    return v.strip() if v and v.strip() else None


def is_configured() -> bool:
    return all([
        _env("TWILIO_ACCOUNT_SID"),
        _env("TWILIO_AUTH_TOKEN"),
        _env("TWILIO_PHONE_NUMBER"),
    ])


def mode() -> str:
    return "live" if is_configured() else "mock"


# ---------- Phone helpers ----------
_DIGITS_RX = re.compile(r"[^0-9+]")


def normalize_e164(raw: Optional[str], default_country_code: str = "1") -> Optional[str]:
    """Best-effort E.164 normalization. Returns None if the input clearly isn't a phone.

    Acceptable inputs:
      - "+15555550100" / "15555550100" / "555-555-0100" / "(555) 555-0100"
      - Extensions ('x123' / 'ext 123') are stripped.
    """
    if not raw:
        return None
    s = str(raw).strip()
    # Drop extension parts
    s = re.split(r"(?i)\b(?:x|ext\.?|extension)\b", s, maxsplit=1)[0]
    # Keep only digits and a leading +
    cleaned = _DIGITS_RX.sub("", s)
    if not cleaned:
        return None
    if cleaned.startswith("+"):
        digits = cleaned[1:]
        if not digits.isdigit() or len(digits) < 8 or len(digits) > 15:
            return None
        return "+" + digits
    # No +: assume default country code if length looks national
    if not cleaned.isdigit():
        return None
    if len(cleaned) == 10:
        return f"+{default_country_code}{cleaned}"
    if len(cleaned) == 11 and cleaned.startswith(default_country_code):
        return "+" + cleaned
    if 8 <= len(cleaned) <= 15:
        # International number missing '+'
        return "+" + cleaned
    return None


# ---------- Twilio client (lazy, cached) ----------
_client = None
_client_failed = False


def _get_client():
    global _client, _client_failed
    if _client is not None or _client_failed:
        return _client
    if not is_configured():
        return None
    try:
        from twilio.rest import Client  # local import so mock installs work
        _client = Client(_env("TWILIO_ACCOUNT_SID"), _env("TWILIO_AUTH_TOKEN"))
        return _client
    except Exception as e:
        logger.warning(f"Twilio client init failed; falling back to mock: {e}")
        _client_failed = True
        return None


# ---------- Core send ----------
async def send_sms(to: Optional[str], body: str) -> dict:
    """Send a single SMS. Always returns a dict (never raises)."""
    normalized = normalize_e164(to)
    if not normalized:
        logger.info(f"[SMS-SKIP] invalid phone {to!r} (cannot normalize to E.164)")
        return {"ok": False, "to": to, "reason": "invalid_phone", "mode": mode()}
    if not is_configured():
        # MOCK mode — log full payload, no network call.
        logger.info(
            f"[SMS-MOCK] →{normalized} ({len(body)} chars)\n  body: {body}"
        )
        return {"ok": True, "to": normalized, "mocked": True, "mode": "mock"}
    sender = _env("TWILIO_PHONE_NUMBER")
    client = _get_client()
    if client is None:
        logger.info(f"[SMS-MOCK] (client init failed) →{normalized}: {body}")
        return {"ok": True, "to": normalized, "mocked": True, "mode": "mock"}
    try:
        def _send():
            return client.messages.create(to=normalized, from_=sender, body=body)
        msg = await asyncio.to_thread(_send)
        logger.info(f"[SMS] →{normalized} sid={msg.sid} status={msg.status}")
        return {
            "ok": True,
            "to": normalized,
            "sid": msg.sid,
            "status": msg.status,
            "mode": "live",
        }
    except Exception as e:
        logger.warning(f"[SMS-FAIL] →{normalized}: {e}")
        return {"ok": False, "to": normalized, "error": str(e), "mode": "live"}


async def send_sms_to_many(numbers: Iterable[Optional[str]], body: str) -> List[dict]:
    """Send the same body to multiple recipients in parallel, returning per-recipient results.

    Duplicates and falsy values are silently de-duped/dropped.
    """
    # De-dupe AFTER normalization so "(555)..." and "+1555..." resolve to one send.
    seen: set = set()
    cleaned: List[str] = []
    for n in numbers:
        norm = normalize_e164(n)
        if not norm or norm in seen:
            if n and not norm:
                logger.info(f"[SMS-SKIP] invalid phone {n!r}")
            continue
        seen.add(norm)
        cleaned.append(norm)
    if not cleaned:
        return []
    return await asyncio.gather(*[send_sms(n, body) for n in cleaned])
