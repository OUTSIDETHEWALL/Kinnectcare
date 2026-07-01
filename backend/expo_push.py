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
        # Build 50 — ghost-notification KILL at the FCM protocol level.
        #
        # FCM has a strict rule: any message that contains a
        # `notification` block (which Expo constructs from any non-empty
        # `title` or `body`) is treated as a NOTIFICATION message and
        # renders on the tray automatically — even when the app is
        # killed and even at IMPORTANCE_MIN (falls back to the app-name
        # initial "K").  Only messages with EXCLUSIVELY a `data` block
        # are true data-only wake-ups that never surface visually.
        #
        # Build 49's JS-side dismissNotificationAsync() only works when
        # the JS runtime is alive to fire the listener.  On Joyce's
        # phone during long idle periods (OS kills JS after 30-60 min of
        # background per audit P4), the notification arrives, the OS
        # draws the tray entry, and nothing dismisses it because there
        # is no JS to receive the event.  That's the source of the 10
        # ghost K notifications she saw over 2 hours today.
        #
        # Fix: OMIT title/body entirely when both are empty, so Expo's
        # push service constructs a data-only FCM message.  FCM then
        # wakes the app to run the JS handler without EVER rendering a
        # tray entry — regardless of whether JS is currently alive.
        # The refresh still happens (the data payload is delivered); it
        # just stops being visible.
        has_title = bool(title and title.strip())
        has_body = bool(body and body.strip())
        if has_title:
            msg["title"] = title[:200]
        if has_body:
            msg["body"] = body[:500]
        # v1.3.0+ silent-push hardening: omit the sound key entirely
        # when caller passes a falsy value.  An empty-string sound was
        # being interpreted by Android FCM as "use default sound",
        # which made the request_location_refresh data push audibly
        # buzz on the receiving device — defeating the whole point.
        if sound and (has_title or has_body):
            msg["sound"] = sound
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
