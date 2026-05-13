"""Stripe billing helpers for KinnectCare.

Plans:
  - free: up to FREE_MEMBER_LIMIT family members (default 2).
  - family_plan: $9.99/mo (configurable), unlimited members + premium features.

The price is auto-created on first use if STRIPE_PRICE_ID is not set in env.
The resolved price id is cached in the `billing_config` Mongo collection so subsequent
boots don't recreate it.

Public surface:
  - init_stripe(): configure stripe SDK from env (idempotent).
  - get_or_create_price(db): return cached/resolved Stripe price id.
  - plan_for_user(user_doc): returns ('free'|'family_plan').
  - is_paid(user_doc): bool.
  - get_member_limit(user_doc, free_limit): int (math.inf for paid).
  - build_status_payload(user_doc, db): dict for GET /api/billing/status.
  - create_checkout_session(db, user_doc, success_url, cancel_url): hosted Checkout URL.
  - apply_subscription_to_user(db, user_id, customer_id, subscription_obj): writes plan.
  - revert_user_to_free(db, customer_id): on cancellation.
"""
from __future__ import annotations

import logging
import math
import os
from datetime import datetime, timezone
from typing import Optional

import stripe

logger = logging.getLogger(__name__)

FREE_LIMIT_DEFAULT = int(os.getenv("FREE_MEMBER_LIMIT", "2"))
PAID_AMOUNT_CENTS = int(os.getenv("PAID_PLAN_AMOUNT_CENTS", "999"))
PAID_INTERVAL = os.getenv("PAID_PLAN_INTERVAL", "month")
PAID_PRODUCT_NAME = os.getenv("PAID_PLAN_PRODUCT_NAME", "KinnectCare Family Plan")
PAID_CURRENCY = os.getenv("PAID_PLAN_CURRENCY", "usd")


def init_stripe() -> bool:
    """Configure stripe SDK from env. Returns True if a secret key was found."""
    key = os.getenv("STRIPE_SECRET_KEY", "").strip()
    if not key:
        logger.warning("STRIPE_SECRET_KEY not set; billing endpoints will return 503.")
        return False
    stripe.api_key = key
    stripe.api_version = "2024-04-10"
    return True


def is_configured() -> bool:
    return bool(os.getenv("STRIPE_SECRET_KEY", "").strip())


async def get_or_create_price(db) -> str:
    """Return a Stripe Price ID for the family plan. Creates Product+Price on first call."""
    env_price = (os.getenv("STRIPE_PRICE_ID") or "").strip()
    if env_price:
        return env_price

    cached = await db.billing_config.find_one({"key": "price"}, {"_id": 0})
    if cached and cached.get("price_id"):
        return cached["price_id"]

    product = stripe.Product.create(
        name=PAID_PRODUCT_NAME,
        description="Unlimited family members and premium KinnectCare features.",
    )
    price = stripe.Price.create(
        product=product.id,
        unit_amount=PAID_AMOUNT_CENTS,
        currency=PAID_CURRENCY,
        recurring={"interval": PAID_INTERVAL, "interval_count": 1},
    )
    await db.billing_config.update_one(
        {"key": "price"},
        {"$set": {
            "key": "price",
            "product_id": product.id,
            "price_id": price.id,
            "amount_cents": PAID_AMOUNT_CENTS,
            "currency": PAID_CURRENCY,
            "interval": PAID_INTERVAL,
            "created_at": datetime.now(timezone.utc),
        }},
        upsert=True,
    )
    logger.info(f"Auto-created Stripe product={product.id} price={price.id}")
    return price.id


def plan_for_user(user_doc: dict) -> str:
    sub = (user_doc or {}).get("subscription") or {}
    plan = sub.get("plan") or "free"
    status = sub.get("status")
    # Treat paid plan as active only if Stripe reports it active or trialing.
    if plan == "family_plan" and status in ("active", "trialing", "past_due"):
        return "family_plan"
    return "free"


def is_paid(user_doc: dict) -> bool:
    return plan_for_user(user_doc) == "family_plan"


def get_member_limit(user_doc: dict, free_limit: int = FREE_LIMIT_DEFAULT):
    """Returns int member limit (math.inf for paid)."""
    return math.inf if is_paid(user_doc) else free_limit


async def _ensure_stripe_customer(db, user_doc: dict) -> str:
    """Return user's Stripe customer id, creating one if missing."""
    sub = user_doc.get("subscription") or {}
    cust_id = sub.get("stripe_customer_id")
    if cust_id:
        return cust_id
    customer = stripe.Customer.create(
        email=user_doc["email"],
        name=user_doc.get("full_name"),
        metadata={"kinnect_user_id": user_doc["id"]},
    )
    await db.users.update_one(
        {"id": user_doc["id"]},
        {"$set": {"subscription.stripe_customer_id": customer.id}},
    )
    return customer.id


async def create_checkout_session(db, user_doc: dict, success_url: str, cancel_url: str):
    """Create a Stripe Checkout subscription session and return its URL + id."""
    price_id = await get_or_create_price(db)
    customer_id = await _ensure_stripe_customer(db, user_doc)
    session = stripe.checkout.Session.create(
        customer=customer_id,
        mode="subscription",
        payment_method_types=["card"],
        line_items=[{"price": price_id, "quantity": 1}],
        success_url=success_url,
        cancel_url=cancel_url,
        allow_promotion_codes=True,
        metadata={"kinnect_user_id": user_doc["id"]},
        subscription_data={
            "metadata": {"kinnect_user_id": user_doc["id"]},
        },
    )
    return session.url, session.id


def _ts_to_dt(ts: Optional[int]) -> Optional[datetime]:
    if ts is None:
        return None
    try:
        return datetime.fromtimestamp(int(ts), tz=timezone.utc)
    except Exception:
        return None


async def apply_subscription_to_user(db, user_id: str, customer_id: str, subscription) -> None:
    """Persist subscription state on the user document."""
    sub_obj = subscription if isinstance(subscription, dict) else subscription.to_dict_recursive()
    update = {
        "subscription.plan": "family_plan" if sub_obj.get("status") in (
            "active", "trialing", "past_due"
        ) else "free",
        "subscription.stripe_customer_id": customer_id,
        "subscription.stripe_subscription_id": sub_obj.get("id"),
        "subscription.status": sub_obj.get("status"),
        "subscription.cancel_at_period_end": bool(sub_obj.get("cancel_at_period_end")),
        "subscription.updated_at": datetime.now(timezone.utc),
    }
    cps = _ts_to_dt(sub_obj.get("current_period_start"))
    cpe = _ts_to_dt(sub_obj.get("current_period_end"))
    if cps:
        update["subscription.current_period_start"] = cps
    if cpe:
        update["subscription.current_period_end"] = cpe
    await db.users.update_one({"id": user_id}, {"$set": update})


async def revert_user_to_free_by_customer(db, customer_id: str) -> None:
    await db.users.update_one(
        {"subscription.stripe_customer_id": customer_id},
        {"$set": {
            "subscription.plan": "free",
            "subscription.status": "canceled",
            "subscription.cancel_at_period_end": False,
            "subscription.updated_at": datetime.now(timezone.utc),
        }},
    )


async def build_status_payload(user_doc: dict, db, free_limit: int = FREE_LIMIT_DEFAULT) -> dict:
    sub = user_doc.get("subscription") or {}
    plan = plan_for_user(user_doc)
    member_count = await db.members.count_documents({"owner_id": user_doc["id"]})
    limit = get_member_limit(user_doc, free_limit)
    members_remaining: Optional[int]
    if limit == math.inf:
        members_remaining = None
    else:
        members_remaining = max(0, int(limit) - int(member_count))
    payload = {
        "plan": plan,
        "status": sub.get("status"),
        "member_limit": None if limit == math.inf else int(limit),
        "member_count": member_count,
        "members_remaining": members_remaining,
        "current_period_end": (
            sub.get("current_period_end").isoformat()
            if isinstance(sub.get("current_period_end"), datetime) else sub.get("current_period_end")
        ),
        "cancel_at_period_end": bool(sub.get("cancel_at_period_end")),
        "stripe_customer_id": sub.get("stripe_customer_id"),
        "paid_plan": {
            "amount_cents": PAID_AMOUNT_CENTS,
            "currency": PAID_CURRENCY,
            "interval": PAID_INTERVAL,
            "product_name": PAID_PRODUCT_NAME,
        },
    }
    # Best-effort billing portal link (paid users only)
    if is_paid(user_doc) and sub.get("stripe_customer_id") and is_configured():
        try:
            portal = stripe.billing_portal.Session.create(
                customer=sub["stripe_customer_id"],
            )
            payload["manage_url"] = portal.url
        except Exception as e:
            logger.warning(f"billing portal session failed: {e}")
            payload["manage_url"] = None
    else:
        payload["manage_url"] = None
    return payload
