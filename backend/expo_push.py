"""Expo Push helper — sends push notifications via the public Expo API.
No API key required. Best-effort: failures are logged but never crash the app.
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
    """Send a push notification to a list of Expo push tokens. Best-effort."""
    valid = [t for t in (tokens or []) if is_valid_expo_token(t)]
    if not valid:
        return
    messages = [
        {
            "to": t,
            "title": title[:200],
            "body": body[:500],
            "sound": sound,
            "priority": "high",
            "data": data or {},
        }
        for t in valid
    ]
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(EXPO_PUSH_API, json=messages, headers={"Content-Type": "application/json"})
            if r.status_code >= 400:
                logger.warning(f"Expo push non-200: {r.status_code} body={r.text[:300]}")
    except Exception as e:
        logger.warning(f"Expo push failed: {e}")
