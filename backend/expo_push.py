"""Expo Push helper — sends push notifications via the public Expo API.

Supports notification categories (for action buttons) and Android channel
routing via the optional `categoryIdentifier` / `channelId` fields in the
data payload.  Falls back to safe defaults so older clients still work.

Also returns the list of tokens that the Expo API tells us are invalid
(DeviceNotRegistered, InvalidCredentials, etc.) so the caller can prune
them from the database.  This stops "ghost notifications" being sent
indefinitely to uninstalled-app push tokens.
"""
import logging
from typing import List, Optional, Dict, Any
import httpx

logger = logging.getLogger(__name__)

EXPO_PUSH_API = "https://exp.host/--/api/v2/push/send"

# Error codes Expo returns for tokens that are no longer reachable. When
# we see any of these for a given token we remove it from the user's
# push_tokens array immediately — there is no point trying again.
#   DeviceNotRegistered — app uninstalled OR token expired/rotated by OS
#   InvalidCredentials  — token format / project mismatch
#   MismatchSenderId    — FCM sender mismatch (server reconfigured)
DEAD_TOKEN_ERRORS = {
    "DeviceNotRegistered",
    "InvalidCredentials",
    "MismatchSenderId",
}


def is_valid_expo_token(t: str) -> bool:
    return isinstance(t, str) and t.startswith("ExponentPushToken[") and t.endswith("]")


async def send_expo_push(
    tokens: List[str],
    title: str,
    body: str,
    data: Optional[Dict[str, Any]] = None,
    sound: str = "default",
) -> List[str]:
    """Send a push notification to a list of Expo push tokens.

    Returns a list of tokens that the Expo API reported as PERMANENTLY
    invalid (DeviceNotRegistered etc.) so the caller can remove them
    from its store.  Transient errors (MessageRateExceeded, network
    failures, MessageTooBig) are NOT returned — we'll retry those on
    the next push.

    Optional fields read from `data`:
        categoryIdentifier — iOS/Android notification category (for action buttons)
        channelId          — Android notification channel id (e.g. 'meds_v2', 'sos')
    """
    valid = [t for t in (tokens or []) if is_valid_expo_token(t)]
    if not valid:
        return []
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
            # NOTE: TTL intentionally OMITTED so Expo/FCM/APNs use their
            # default redelivery window (~28 days for FCM, 4 weeks for APNs
            # tokens).  An earlier version of this file set ttl=0 which
            # told FCM "drop if device not immediately reachable" — that
            # silently dropped medication/check-in/family-alert pushes
            # whenever the recipient phone was in Doze, on a poor cell
            # connection, or had screen off long enough to throttle the
            # FCM socket. SOS happened to work because caregivers were
            # typically active when SOS fired.  We now let FCM hold the
            # push until the device wakes up — same behavior as any
            # production messaging app.
        }
        if cat_id:
            msg["categoryId"] = cat_id
            msg["categoryIdentifier"] = cat_id
        messages.append(msg)

    dead: List[str] = []
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(
                EXPO_PUSH_API,
                json=messages,
                headers={"Content-Type": "application/json"},
            )
            if r.status_code >= 400:
                logger.warning(
                    f"Expo push non-200: {r.status_code} body={r.text[:300]}"
                )
                return []
            # Parse per-message response. Expo returns:
            #   { "data": [ { "status": "ok" | "error", ... }, ... ] }
            # The order matches the order of messages we sent, so we can
            # zip them with `valid` to recover the offending token.
            try:
                payload = r.json()
            except Exception:
                return []
            results = payload.get("data") or []
            if not isinstance(results, list):
                return []
            for token, res in zip(valid, results):
                if not isinstance(res, dict):
                    continue
                if res.get("status") == "error":
                    details = res.get("details") or {}
                    err = details.get("error") if isinstance(details, dict) else None
                    if err in DEAD_TOKEN_ERRORS:
                        dead.append(token)
                        logger.info(
                            f"Expo push: pruning dead token (err={err}) "
                            f"token={token[:25]}..."
                        )
                    else:
                        logger.warning(
                            f"Expo push transient error err={err} "
                            f"msg={res.get('message')!r}"
                        )
    except Exception as e:
        logger.warning(f"Expo push failed: {e}")
    return dead
