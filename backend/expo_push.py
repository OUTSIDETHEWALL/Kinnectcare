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


def _collapse_id(data: dict) -> Optional[str]:
    """Derive a stable collapse ID from the notification payload.

    Expo's `collapseId` field maps to FCM's `collapse_key` and APNS's
    `apns-collapse-id`.  When the OS receives a notification whose
    collapseId matches a notification already in the tray, it REPLACES
    the old one instead of stacking a new entry.  This is the OS-level
    safety net that complements the client-side `stableNotificationId`
    logic in push.ts.

    Scheme mirrors stableNotificationId() in frontend/src/push.ts:
      medication self-due  → med_<reminder_id>_due
      medication family    → med_<reminder_id>_family
      medication refill    → med_<reminder_id>_refill
      routine due          → rt_<reminder_id>_due
      sos                  → sos_<alert_id>
      missed_checkin       → miss_<member_id>

    Returns None when the payload lacks the fields needed to build a
    meaningful ID — in that case Expo omits the field and the OS stacks
    normally (no regression vs. current behaviour).
    """
    t = data.get("type")
    rid = data.get("reminder_id")
    aid = data.get("alert_id")
    mid = data.get("member_id")
    stage = data.get("stage") or data.get("subtype")

    if t == "medication" and rid:
        if stage in ("refill",):
            return f"med_{rid}_refill"
        if stage in ("family_alert",):
            return f"med_{rid}_family"
        return f"med_{rid}_due"
    if t == "routine" and rid:
        return f"rt_{rid}_due"
    if t == "sos" and aid:
        return f"sos_{aid}"
    if t == "missed_checkin" and mid:
        return f"miss_{mid}"
    return None


# =========================================================================
# Build 53 — Blank notification safety net.
#
# Rule: if a push would render on the tray (has_title OR has_body) but the
# user-visible content is functionally empty (<3 non-whitespace chars
# across both fields, whitespace-only, single glyph/emoji), DROP the send
# and log the source_tag + payload so we can trace who called us with junk.
#
# Data-only pushes (both title AND body empty) are FINE — they never render.
# =========================================================================
def _would_render_blank(title: str, body: str) -> bool:
    t = (title or "").strip()
    b = (body or "").strip()
    if not t and not b:
        return False  # data-only push — never visible, never blank problem
    # Build #59 — stricter rule.  Any push that renders visibly on the
    # tray MUST have BOTH a meaningful title (>=3 chars) AND a
    # meaningful body (>=3 chars).  Historical rule allowed one-or-the-
    # other, which let single-word pushes like title="Update" body=""
    # slip through and render as the icon-only "K" ghost when Android's
    # notification layout collapses the empty line.  If a caller only
    # has a title, they're building a bad notification — reject.
    if len(t) < 3 or len(b) < 3:
        return True  # visible push with missing/tiny title OR body
    # Also reject obvious placeholder / low-info titles.  These are
    # bugs from callers that forgot to fill in real content but did
    # pass the char-count check.
    placeholder_titles = {"update", "notification", "alert", "kinnship", "k"}
    if t.lower() in placeholder_titles and len(b) < 8:
        return True
    return False  # has meaningful content


# In-memory ring buffer of dropped blank pushes for the runtime.  Callers
# can query it via `get_recent_blank_drops()` to see who's leaking.
# Persisted MongoDB write is added at the server.py caller level (kept
# out of this module so we don't need to import motor here).
_BLANK_DROP_RING: List[Dict[str, Any]] = []
_BLANK_DROP_MAX = 50

# Optional MongoDB sink — server.py wires this up at import time so
# every blank-drop is persisted for post-mortem.  Kept as a hook so this
# module stays DB-agnostic.
_mongo_sink = None


def register_blank_drop_sink(fn):
    """server.py calls this with an async fn(entry_dict) at startup."""
    global _mongo_sink
    _mongo_sink = fn


def get_recent_blank_drops() -> List[Dict[str, Any]]:
    return list(_BLANK_DROP_RING)


def _record_blank_drop(entry: Dict[str, Any]) -> None:
    _BLANK_DROP_RING.append(entry)
    while len(_BLANK_DROP_RING) > _BLANK_DROP_MAX:
        _BLANK_DROP_RING.pop(0)
    logger.warning(
        f"BLANK_PUSH_DROP: source={entry.get('source_tag')} "
        f"title={entry.get('title')!r} body={entry.get('body')!r} "
        f"tokens={entry.get('token_count')}"
    )


async def send_expo_push(
    tokens: List[str],
    title: str,
    body: str,
    data: Optional[Dict[str, Any]] = None,
    sound: str = "default",
    priority: str = "high",
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

    `priority`: Build #58 — configurable.  Historically hard-coded to
    "high" which is correct for SOS / medications / user-visible
    notifications.  Silent data-only pushes (refresh) should use
    "normal" so FCM does NOT aggressively wake the OS notification
    handler — root cause of the "blank K" tray flashes Charles saw
    correlating with every Refresh Trace.  See
    request_location_refresh below for the concrete change.
    """
    valid = [t for t in (tokens or []) if is_valid_expo_token(t)]
    if not valid:
        return []
    data = data or {}
    cat_id = data.get("categoryIdentifier") or data.get("categoryId")
    channel_id = data.get("channelId") or "default"
    source_tag = data.get("_source_tag") or "unknown"
    # Optional TTL (seconds) injected via data["_ttl"].  None = omit the
    # field and let FCM/APNs use their default (~28-day) redelivery window.
    # Callers that send time-sensitive status notifications (e.g. SOS
    # resolved) should set a short TTL so a delayed delivery doesn't
    # confuse the recipient.
    _ttl = data.get("_ttl")

    # Build #62 — comprehensive outbound-push audit log.
    # Every push (visible AND silent) is logged with source_tag,
    # channel, priority, title/body previews, type — so on Railway
    # we can grep for "[push-outbound]" and trace exactly which
    # subsystem originated any given tray notification.  This is the
    # instrumentation we needed when Charles reported the phantom-K
    # notifications on Build #60/61 QA.
    _t_preview = (title or "")[:40].replace("\n", " ")
    _b_preview = (body or "")[:60].replace("\n", " ")
    logger.info(
        f"[push-outbound] source={source_tag!r} type={data.get('type', '?')!r} "
        f"channel={channel_id!r} priority={priority!r} "
        f"tokens={len(valid)} "
        f"title={_t_preview!r} body={_b_preview!r}"
    )

    # Build 53 — Blank notification safety net.  Reject any send where
    # the OUTGOING message would surface visibly on the tray but has
    # functionally empty content.  This is the last line of defence
    # against ghost "K"-icon notifications regardless of which upstream
    # caller misbehaved.
    if _would_render_blank(title, body):
        entry = {
            "at": None,  # server.py sink stamps this
            "source_tag": source_tag,
            "title": title,
            "body": body,
            "channel_id": channel_id,
            "data_keys": sorted(list(data.keys())),
            "token_count": len(valid),
        }
        _record_blank_drop(entry)
        if _mongo_sink is not None:
            try:
                await _mongo_sink(entry)
            except Exception as e:
                logger.warning(f"blank_drop mongo sink failed: {e}")
        return []

    messages = []
    is_data_only = not bool((title or "").strip()) and not bool((body or "").strip())
    for t in valid:
        msg: Dict[str, Any] = {
            "to": t,
            "priority": priority,
            "data": data,
            # Build 63 — omit top-level channelId for data-only pushes.
            #
            # The top-level `channelId` in the Expo Push API format tells
            # Expo to set `android.channel_id` inside the FCM *notification*
            # block.  For notification messages (non-empty title or body)
            # this is correct — it routes the heads-up to the right Android
            # channel.
            #
            # For data-only pushes (both title AND body empty), including
            # a top-level `channelId` causes Expo's relay to attach an
            # `android.channel_id` field to what should be a pure data
            # message.  Samsung One UI / Xiaomi MIUI / OnePlus OxygenOS
            # intercept this and render a status-bar icon ("K") even
            # though the message has no visible content — because the OEM
            # treats any message with a channel assignment as potentially
            # visible.  JS can dismiss this icon only while the JS runtime
            # is alive; when the OS has killed JS (typical after 30-60 min
            # of background on Samsung under App Power Management), the
            # dismiss never fires and the blank K persists indefinitely.
            #
            # Fix: when the push is data-only, omit `channelId` from the
            # top-level Expo message entirely.  FCM then sends a pure
            # data message with no notification block — nothing for any
            # OEM to render, regardless of JS state.  The `channelId`
            # field is still present inside `data` (e.g. "silent_v2") so
            # the JS handler can read it if needed.
            #
            # Notification messages keep the top-level channelId so
            # Android routes the heads-up to the correct channel.
            # NOTE: TTL intentionally OMITTED BY DEFAULT so Expo/FCM/APNs
            # use their default redelivery window (~28 days for FCM, 4
            # weeks for APNs tokens).  An earlier version of this file set
            # ttl=0 which told FCM "drop if device not immediately
            # reachable" — that silently dropped medication/check-in/family-
            # alert pushes whenever the recipient phone was in Doze, on a
            # poor cell connection, or had screen off long enough to throttle
            # the FCM socket. SOS happened to work because caregivers were
            # typically active when SOS fired.  We now let FCM hold the push
            # until the device wakes up — same behaviour as any production
            # messaging app.
            #
            # Callers may override via data["_ttl"] (seconds) for
            # notifications whose value decays quickly (e.g. SOS resolved).
        }
        if _ttl is not None:
            msg["ttl"] = int(_ttl)
        # Build 63 — see comment in msg dict above.
        # Only attach top-level channelId for notification messages.
        if not is_data_only:
            msg["channelId"] = channel_id
        # Phase 2 ghost-notification fix — OS-level deduplication.
        # collapseId maps to FCM collapse_key and APNS apns-collapse-id.
        # When a notification with the same collapseId is already in the
        # tray, the OS replaces it instead of stacking a new entry.  This
        # is the backend-side safety net that complements the client-side
        # stableNotificationId logic in push.ts — together they ensure
        # at most one tray entry per logical event on both Android and iOS.
        _cid = _collapse_id(data)
        if _cid:
            msg["collapseId"] = _cid
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
