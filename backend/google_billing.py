"""Google-only RevenueCat adapter. No Stripe writes, receipts, or family data.

Disabled until explicitly configured. RevenueCat verifies/acknowledges Play
purchases; only authenticated server reads can update Kinnship's access mirror.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
import time
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import httpx
from fastapi import HTTPException
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

log = logging.getLogger(__name__)


def now():
    return datetime.now(timezone.utc)


def enabled():
    return os.getenv("GOOGLE_BILLING_ENABLED") == "true"


def reconciliation_enabled():
    return enabled() and os.getenv("GOOGLE_BILLING_RECONCILIATION_ENABLED") == "true"


def emergency_access_disabled():
    # This is the ONLY operational switch that revokes an existing Google grant.
    # It never affects Stripe access.
    return os.getenv("GOOGLE_BILLING_EMERGENCY_ACCESS_DISABLED") == "true"


def purchases_enabled():
    if not reconciliation_enabled() or emergency_access_disabled():
        return False
    if os.getenv("GOOGLE_BILLING_PURCHASES_ENABLED") != "true":
        return False
    try:
        settings()
        return True
    except HTTPException:
        return False


def controls():
    return {
        "purchases_enabled": purchases_enabled(),
        "reconciliation_enabled": reconciliation_enabled(),
        "emergency_access_disabled": emergency_access_disabled(),
    }


def settings(require_reconciliation=True):
    """Configuration is explicit; no test-store or unverified catalog fallback."""
    values = {k: os.getenv(k, "").strip() for k in (
        "REVENUECAT_PROJECT_ID", "REVENUECAT_GOOGLE_APP_ID",
        "REVENUECAT_SECRET_API_KEY", "REVENUECAT_ENTITLEMENT_ID",
        "GOOGLE_MONTHLY_PRODUCT", "GOOGLE_ANNUAL_PRODUCT",
    )}
    if not enabled() or not all(values.values()) or (require_reconciliation and not reconciliation_enabled()):
        raise HTTPException(503, "Google billing is not enabled and configured")
    if os.getenv("GOOGLE_BILLING_ORIGINAL_OWNER_CONFIRMED") != "true":
        raise HTTPException(503, "Original-purchaser restoration must be confirmed before activation")
    values["environment"] = os.getenv("GOOGLE_BILLING_ENVIRONMENT", "production")
    if values["environment"] not in ("sandbox", "production"):
        raise HTTPException(503, "Invalid Google billing environment")
    return values


def allowed_account(user, environment):
    if environment != "sandbox":
        return True
    users = os.getenv("GOOGLE_BILLING_TEST_USER_IDS", "").split(",")
    families = os.getenv("GOOGLE_BILLING_TEST_FAMILY_IDS", "").split(",")
    return bool(user and user.get("id") in users and user.get("family_group_id")
                and user["family_group_id"] in families)


def millis(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        return datetime.fromtimestamp(value / 1000, timezone.utc)
    except (ValueError, OverflowError, OSError):
        return None


def google_access(user, at=None):
    if emergency_access_disabled():
        return False
    sub = (user or {}).get("google_subscription") or {}
    if not allowed_account(user, sub.get("environment")):
        return False
    expiry = sub.get("access_until")
    if isinstance(expiry, datetime) and expiry.tzinfo is None:
        expiry = expiry.replace(tzinfo=timezone.utc)
    return sub.get("verified") is True and isinstance(expiry, datetime) and expiry > (at or now())


def owns_purchase(user):
    sub = (user or {}).get("google_subscription") or {}
    # An empty successful lookup is NOT ownership. product_identifier supports
    # mirrors written by the first draft without inventing a second purchaser.
    return sub.get("verified") is True and bool(sub.get("has_purchase") or sub.get("product_identifier"))


async def identity(db, user_id):
    # Existing account must still exist at the atomic write; never upsert users.
    doc = await db.users.find_one_and_update(
        {"id": user_id, "google_billing_id": {"$exists": False}},
        {"$set": {"google_billing_id": str(uuid.uuid4())}},
        return_document=ReturnDocument.AFTER,
    )
    if not doc:
        doc = await db.users.find_one({"id": user_id})
    if not doc or not doc.get("google_billing_id"):
        raise HTTPException(401, "Account unavailable")
    return doc["google_billing_id"]


class RevenueCat:
    """Server-side API v2 client. Secrets never leave this process."""
    def __init__(self, config):
        self.config = config
        self.project = quote(config["REVENUECAT_PROJECT_ID"], safe="")

    async def get(self, path, missing_empty=False):
        if not path.startswith(f"/v2/projects/{self.project}/"):
            raise HTTPException(502, "Invalid billing pagination")
        async with httpx.AsyncClient(timeout=12, follow_redirects=False) as client:
            response = await client.get(
                "https://api.revenuecat.com" + path,
                headers={"Authorization": "Bearer " + self.config["REVENUECAT_SECRET_API_KEY"]},
            )
        # Do not log responses/errors: they may contain purchaser identifiers.
        if response.status_code == 404 and missing_empty:
            return {"items": []}
        if response.status_code != 200:
            raise HTTPException(503, "Subscription verification temporarily unavailable")
        return response.json()

    async def listing(self, path):
        items = []
        for page in range(20):
            data = await self.get(path, missing_empty=page == 0)
            if not isinstance(data.get("items"), list):
                raise HTTPException(502, "Invalid subscription verification response")
            items.extend(data["items"])
            path = data.get("next_page")
            if not path:
                return items
        raise HTTPException(503, "Subscription history requires further reconciliation")

    async def snapshot(self, app_user_id):
        base = f"/v2/projects/{self.project}/customers/{quote(app_user_id, safe='')}"
        subs = await self.listing(base + "/subscriptions?limit=100")
        entitlements = await self.listing(base + "/active_entitlements?limit=100")
        products = {}
        for sub in subs:
            if sub.get("store") == "play_store" and sub.get("environment") == self.config["environment"]:
                product_id = sub.get("product_id")
                if not isinstance(product_id, str):
                    raise HTTPException(502, "Invalid verified product")
                if product_id not in products:
                    products[product_id] = await self.get(
                        f"/v2/projects/{self.project}/products/{quote(product_id, safe='')}"
                    )
        return subs, entitlements, products


def projection(config, app_user_id, subs, entitlements, products, at=None):
    """Fail closed on ownership mismatch; never use a client entitlement claim."""
    at = at or now()
    grant = {"verified": True, "has_purchase": False, "status": "expired", "access_until": at,
             "checked_at": at, "environment": config["environment"]}
    chains = set()
    allowed = {config["GOOGLE_MONTHLY_PRODUCT"]: "month", config["GOOGLE_ANNUAL_PRODUCT"]: "year"}
    entitlement_expiry = max(
        (millis(e.get("expires_at")) or at for e in entitlements
         if e.get("entitlement_id") == config["REVENUECAT_ENTITLEMENT_ID"]),
        default=at,
    )
    for sub in subs:
        if sub.get("store") != "play_store" or sub.get("environment") != config["environment"]:
            continue
        product = products.get(sub.get("product_id"), {})
        identifier = product.get("store_identifier")
        if product.get("app_id") != config["REVENUECAT_GOOGLE_APP_ID"] or identifier not in allowed:
            continue
        if sub.get("customer_id") != app_user_id or sub.get("original_customer_id") != app_user_id:
            raise HTTPException(409, "Purchase belongs to another Kinnship account")
        if sub.get("ownership") != "purchased":
            raise HTTPException(409, "Only the original purchaser can restore this subscription")
        if grant["access_until"] <= at:
            grant["status"] = sub.get("status", "unknown")
            grant["interval"] = allowed[identifier]
            grant["current_period_end"] = millis(sub.get("current_period_ends_at"))
        # Google renewal Order IDs append '..N'; retain ownership of the root.
        order = sub.get("store_subscription_identifier")
        if not isinstance(order, str) or not order or not sub.get("id"):
            raise HTTPException(502, "Verified purchase identity is missing")
        chains.add("order:" + order.split("..", 1)[0])
        chains.add("subscription:" + sub["id"])
        grant["has_purchase"] = True
        linked = {e.get("id") for e in (sub.get("entitlements") or {}).get("items", [])}
        if config["REVENUECAT_ENTITLEMENT_ID"] not in linked:
            continue
        # API v2 exposes gives_access on this exact subscription, but does not
        # expose its grace end. Never borrow another product/environment's
        # customer-wide expiry. Grace gets a short, renewable verification lease.
        grace = sub.get("status") == "in_grace_period"
        expiry = at + timedelta(minutes=5) if grace else min(
            entitlement_expiry, millis(sub.get("ends_at")) or at,
        )
        if sub.get("gives_access") is True and expiry > grant["access_until"]:
            grant.update(
                access_until=expiry, status=sub.get("status", "unknown"),
                interval=allowed[identifier], product_identifier=identifier,
                current_period_end=millis(sub.get("current_period_ends_at")),
                cancel_at_period_end=sub.get("auto_renewal_status") == "will_not_renew",
                subscription_id=sub["id"],
                verification_mode="subscription_grace_lease" if grace else "paid_period",
            )
    return grant, chains


async def reconcile(db, user_id, client=None):
    config = settings()
    user = await db.users.find_one({"id": user_id})
    if not allowed_account(user, config["environment"]):
        raise HTTPException(403, "Sandbox billing is restricted to approved test accounts and families")
    app_user_id = await identity(db, user_id)
    token = str(uuid.uuid4())
    at = now()
    lease = await db.users.find_one_and_update(
        {"id": user_id, "google_billing_id": app_user_id, "$or": [
            {"google_billing_lock.until": {"$lt": at}},
            {"google_billing_lock": {"$exists": False}},
        ]},
        {"$set": {"google_billing_lock": {"token": token, "until": at + timedelta(minutes=2)}}},
        return_document=ReturnDocument.AFTER,
    )
    if not lease:
        raise HTTPException(409, "Subscription verification already in progress; retry shortly")
    try:
        snapshot = await (client or RevenueCat(config)).snapshot(app_user_id)
        grant, chains = projection(config, app_user_id, *snapshot)
        settings()  # A reconciliation pause during a provider await fences writes.
        for chain in sorted(chains):
            key = hashlib.sha256((config["REVENUECAT_GOOGLE_APP_ID"] + ":" +
                                  config["environment"] + ":" + chain).encode()).hexdigest()
            try:
                await db.google_purchase_owners.update_one(
                    {"_id": key}, {"$setOnInsert": {"user_id": user_id, "created_at": now()}}, upsert=True,
                )
            except DuplicateKeyError:
                pass
            owner = await db.google_purchase_owners.find_one({"_id": key})
            if not owner or owner["user_id"] != user_id:
                raise HTTPException(409, "Purchase is already bound to another account")
        result = await db.users.update_one(
            {"id": user_id, "google_billing_id": app_user_id,
             "family_group_id": user.get("family_group_id"),
             "google_billing_lock.token": token, "google_billing_lock.until": {"$gt": now()}},
            {"$set": {"google_subscription": grant,
                       "google_billing_next_check": now() + timedelta(
                           minutes=1 if grant.get("verification_mode") == "subscription_grace_lease" else 5)}},
        )
        if result.matched_count != 1:
            raise HTTPException(409, "Account changed during verification; retry")
        return grant
    finally:
        await db.users.update_one(
            {"id": user_id, "google_billing_lock.token": token}, {"$unset": {"google_billing_lock": ""}},
        )


def verify_webhook(raw, authorization, signature, timestamp=None):
    expected = os.getenv("REVENUECAT_WEBHOOK_AUTH", "")
    secret = os.getenv("REVENUECAT_WEBHOOK_SIGNING_SECRET", "")
    if not expected or not secret:
        raise HTTPException(503, "Subscription webhook is not configured")
    if not hmac.compare_digest(authorization or "", expected):
        raise HTTPException(401, "Invalid webhook authorization")
    try:
        parts = dict(part.split("=", 1) for part in (signature or "").split(","))
        stamp = int(parts["t"])
        digest = hmac.new(secret.encode(), str(stamp).encode() + b"." + raw, hashlib.sha256).hexdigest()
        valid = abs((time.time() if timestamp is None else timestamp) - stamp) <= 300 and hmac.compare_digest(digest, parts["v1"])
    except (KeyError, ValueError):
        valid = False
    if not valid:
        raise HTTPException(401, "Invalid webhook signature")


async def receive_webhook(db, raw, authorization, signature):
    # Pausing processing does not discard incoming lifecycle evidence.
    config = settings(require_reconciliation=False)
    verify_webhook(raw, authorization, signature)
    try:
        event = json.loads(raw)["event"]
        event_id, app_user_id = event["id"], event.get("app_user_id")
    except (ValueError, KeyError, TypeError):
        raise HTTPException(400, "Invalid webhook event")
    if not isinstance(event_id, str) or not 0 < len(event_id) <= 255:
        raise HTTPException(400, "Invalid webhook event ID")
    if event.get("app_id") != config["REVENUECAT_GOOGLE_APP_ID"]:
        raise HTTPException(400, "Unexpected webhook app")
    if event.get("environment", "").lower() != config["environment"]:
        raise HTTPException(400, "Unexpected webhook environment")
    # Do not store the full webhook (attributes can contain arbitrary PII).
    if not isinstance(app_user_id, str) or len(app_user_id) > 1500:
        raise HTTPException(400, "Missing purchaser identity")
    try:
        await db.google_billing_events.insert_one({
            "_id": event_id, "app_user_id": app_user_id, "received_at": now(),
            "event_type": str(event.get("type", "UNKNOWN"))[:80],
            "done": False, "next_attempt": now(), "attempts": 0,
        })
    except DuplicateKeyError:
        pass
    return {"accepted": True}


async def sweep(db):
    """Durable inbox + periodic reconciliation, bounded batches, no raw payloads."""
    async for event in db.google_billing_events.find(
        {"done": False, "next_attempt": {"$lte": now()}}
    ).limit(25):
        user = await db.users.find_one({"google_billing_id": event["app_user_id"]})
        try:
            if user:
                await reconcile(db, user["id"])
            # Unknown IDs never grant access; keep retrying for binding races.
            else:
                raise HTTPException(409, "Purchaser identity not yet bound")
            await db.google_billing_events.update_one({"_id": event["_id"]}, {"$set": {"done": True}})
        except Exception:
            await db.google_billing_events.update_one(
                {"_id": event["_id"]}, {"$inc": {"attempts": 1},
                 "$set": {"next_attempt": now() + timedelta(minutes=5)}},
            )
            log.warning("Google billing inbox reconciliation deferred")
    async for user in db.users.find({
        "google_billing_id": {"$exists": True}, "$or": [
            {"google_billing_next_check": {"$lte": now()}},
            {"google_billing_next_check": {"$exists": False}},
        ],
    }).limit(25):
        try:
            await reconcile(db, user["id"])
        except Exception:
            log.warning("Google billing periodic reconciliation deferred")
            await db.users.update_one({"id": user["id"]}, {"$set": {
                "google_billing_next_check": now() + timedelta(minutes=5),
            }})


async def worker(db):
    initialized = False
    while True:
        try:
            settings()
            if not initialized:
                await db.users.create_index("google_billing_id", unique=True, sparse=True)
                await db.users.create_index("google_billing_next_check")
                await db.google_billing_events.create_index([("done", 1), ("next_attempt", 1)])
                initialized = True
            await sweep(db)
        except Exception:
            log.warning("Google billing reconciliation cycle failed")
        await asyncio.sleep(30)
