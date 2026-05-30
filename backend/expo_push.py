"""Expo Push helper — sends push notifications via the public Expo API.

Supports notification categories (for action buttons) and Android channel
routing via the optional `categoryIdentifier` / `channelId` fields in the
data payload.  Falls back to safe defaults so older clients still work.
"""
import logging
from typing import List, Optional, Dict, Any
import httpx

logger = logging.getLogger(__name__)

EXPO_PUSH_API = "https://exp.host/--/api/v2/push/send"


def is_valid_expo_token(t: str) -> bool:
    return isinstance(t, str) and t.startswith("ExponentPushToken[") and t.endswith("]")


async def send_expo_push(
    tokens: List[str],
    title: str,
    body: str,
    data: Optional[Dict[str, Any]] = None,
    sound: str = "default",
) -> None:
    """Send a push notification to a list of Expo push tokens. Best-effort.

    Optional fields read from `data`:
        categoryIdentifier — iOS/Android notification category (for action buttons)
        channelId          — Android notification channel id (e.g. 'meds', 'sos')
    """
    valid = [t for t in (tokens or []) if is_valid_expo_token(t)]
    if not valid:
        return
    data = data or {}
    cat_id = data.get("categoryIdentifier") or data.get("categoryId")
    channel_id = data.get("channelId") or "default"

    messages = []
    for t in valid:
        msg: Dict[str, Any] = {
            "to": t,
            "title": title[:200],
            "body": body[:500],
            "sound": sound,
            "priority": "high",
            "channelId": channel_id,
            "data": data,
            # ttl=0 (no expiration) so the OS doesn't drop unread reminders.
            # The unique idempotency index on the server prevents duplicate fires.
            "ttl": 0,
        }
        if cat_id:
            # Expo accepts BOTH categoryId (legacy) and categoryIdentifier (SDK 48+).
            # We send both for max compatibility.
            msg["categoryId"] = cat_id
            msg["categoryIdentifier"] = cat_id
        messages.append(msg)

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(
                EXPO_PUSH_API,
                json=messages,
                headers={"Content-Type": "application/json"},
            )
            if r.status_code >= 400:
                logger.warning(f"Expo push non-200: {r.status_code} body={r.text[:300]}")
    except Exception as e:
        logger.warning(f"Expo push failed: {e}")
