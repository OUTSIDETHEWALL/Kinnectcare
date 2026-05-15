"""Stripe billing helpers for Kinnship.

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
PAID_PRODUCT_NAME = os.getenv("PAID_PLAN_PRODUCT_NAME", "Kinnship Family Plan")
PAID_CURRENCY = os.getenv("PAID_PLAN_CURRENCY", "usd")
PAID_ANNUAL_AMOUNT_CENTS = int(os.getenv("PAID_PLAN_ANNUAL_AMOUNT_CENTS", "9999"))

# Per-interval config used by /billing/status and /billing/checkout-session
PLAN_INTERVALS = {
    "month": {
        "amount_cents": PAID_AMOUNT_CENTS,
        "label": "Monthly",
        "currency": PAID_CURRENCY,
    },
    "year": {
        "amount_cents": PAID_ANNUAL_AMOUNT_CENTS,
        "label": "Annual",
        "currency": PAID_CURRENCY,
    },
}


def normalize_interval(value: Optional[str]) -> str:
    """Sanitize an interval string. Defaults to monthly when unknown/empty."""
    if not value:
        return "month"
    v = str(value).strip().lower()
    if v in ("year", "yearly", "annual", "annually"):
        return "year"
    return "month"


def annual_savings_cents() -> int:
    """Cents saved by paying annually vs 12 months. Never negative."""
    return max(0, PAID_AMOUNT_CENTS * 12 - PAID_ANNUAL_AMOUNT_CENTS)


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


async def get_or_create_price(db, interval: str = "month") -> str:
    """Return a Stripe Price ID for the family plan at the requested interval.

    On first use for an interval the function creates the underlying Stripe
    Product (shared across intervals) and a Price for that interval, then caches
    the price id under the doc key f"price_{interval}" in db.billing_config.

    interval: 'month' or 'year'.
    """
    interval = normalize_interval(interval)

    # Env override (one key per interval).
    env_key = "STRIPE_PRICE_ID_ANNUAL" if interval == "year" else "STRIPE_PRICE_ID"
    env_price = (os.getenv(env_key) or "").strip()
    if env_price:
        return env_price

    cache_key = f"price_{interval}"
    cached = await db.billing_config.find_one({"key": cache_key}, {"_id": 0})
    if cached and cached.get("price_id"):
        return cached["price_id"]

    # Re-use existing product across intervals.
    existing_product_id: Optional[str] = None
    any_cached = await db.billing_config.find_one(
        {"product_id": {"$exists": True}}, {"_id": 0}
    )
    if any_cached and any_cached.get("product_id"):
        existing_product_id = any_cached["product_id"]
    else:
        # Legacy doc (key="price") used to store product_id at top level.
        legacy = await db.billing_config.find_one({"key": "price"}, {"_id": 0})
        if legacy and legacy.get("product_id"):
            existing_product_id = legacy["product_id"]

    if existing_product_id:
        product_id = existing_product_id
    else:
        product = stripe.Product.create(
            name=PAID_PRODUCT_NAME,
            description="Unlimited family members and premium Kinnship features.",
        )
        product_id = product.id

    amount = PLAN_INTERVALS[interval]["amount_cents"]
    price = stripe.Price.create(
        product=product_id,
        unit_amount=amount,
        currency=PAID_CURRENCY,
        recurring={"interval": interval, "interval_count": 1},
        nickname=f"Kinnship Family Plan – {PLAN_INTERVALS[interval]['label']}",
    )
    await db.billing_config.update_one(
        {"key": cache_key},
        {"$set": {
            "key": cache_key,
            "product_id": product_id,
            "price_id": price.id,
            "amount_cents": amount,
            "currency": PAID_CURRENCY,
            "interval": interval,
            "created_at": datetime.now(timezone.utc),
        }},
        upsert=True,
    )
    logger.info(f"Auto-created Stripe price ({interval})={price.id} on product={product_id}")
    return price.id


def plan_for_user(user_doc: dict) -> str:
    sub = (user_doc or {}).get("subscription") or {}
    plan = sub.get("plan") or "free"
    status = sub.get("status")
    # Treat paid plan as active only if Stripe reports it active or trialing.
    if plan == "family_plan" and status in ("active", "trialing", "past_due"):
        return "family_plan"
    return "free"


async def group_is_paid(db, family_group_id: Optional[str]) -> bool:
    """A family group is on Family Plan if ANY user in it has an active paid sub."""
    if not family_group_id:
        return False
    cursor = db.users.find(
        {"family_group_id": family_group_id, "subscription.plan": "family_plan"},
        {"_id": 0, "subscription": 1},
    )
    docs = await cursor.to_list(50)
    for d in docs:
        if plan_for_user(d) == "family_plan":
            return True
    return False


async def get_member_limit_for_group(
    db, user_doc: dict, free_limit: int = FREE_LIMIT_DEFAULT
):
    """Returns int member limit for the user's family group (math.inf for paid)."""
    if is_paid(user_doc):
        return math.inf
    fgid = user_doc.get("family_group_id")
    if fgid and await group_is_paid(db, fgid):
        return math.inf
    return free_limit


def is_paid(user_doc: dict) -> bool:
    return plan_for_user(user_doc) == "family_plan"


def get_member_limit(user_doc: dict, free_limit: int = FREE_LIMIT_DEFAULT):
    """Returns int member limit (math.inf for paid). Synchronous; only checks
    this user's own subscription. For full group-level check, use
    get_member_limit_for_group."""
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


async def create_checkout_session(
    db,
    user_doc: dict,
    success_url: str,
    cancel_url: str,
    interval: str = "month",
):
    """Create a Stripe Checkout subscription session and return its URL + id."""
    interval = normalize_interval(interval)
    price_id = await get_or_create_price(db, interval)
    customer_id = await _ensure_stripe_customer(db, user_doc)
    session = stripe.checkout.Session.create(
        customer=customer_id,
        mode="subscription",
        payment_method_types=["card"],
        line_items=[{"price": price_id, "quantity": 1}],
        success_url=success_url,
        cancel_url=cancel_url,
        allow_promotion_codes=True,
        metadata={"kinnect_user_id": user_doc["id"], "interval": interval},
        subscription_data={
            "metadata": {"kinnect_user_id": user_doc["id"], "interval": interval},
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


def _extract_interval_from_subscription(sub_obj: dict) -> Optional[str]:
    """Extract recurring interval from a Stripe Subscription dict, or None."""
    try:
        items = (sub_obj.get("items") or {}).get("data") or []
        if items:
            price = items[0].get("price") or {}
            rec = price.get("recurring") or {}
            iv = rec.get("interval")
            if iv:
                return normalize_interval(iv)
    except Exception:
        pass
    # Fallback: stripe metadata we set on the subscription/checkout
    meta = sub_obj.get("metadata") or {}
    if isinstance(meta, dict) and meta.get("interval"):
        return normalize_interval(meta.get("interval"))
    return None


async def apply_subscription_to_user(db, user_id: str, customer_id: str, subscription) -> None:
    """Persist subscription state on the user document."""
    sub_obj = subscription if isinstance(subscription, dict) else subscription.to_dict_recursive()
    interval = _extract_interval_from_subscription(sub_obj)
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
    if interval:
        update["subscription.interval"] = interval
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
    fgid = user_doc.get("family_group_id")
    # Count members for the user's family group (the user's own data is also
    # tagged with this group id).
    if fgid:
        member_count = await db.members.count_documents({"family_group_id": fgid})
    else:
        member_count = await db.members.count_documents({"owner_id": user_doc["id"]})
    limit = await get_member_limit_for_group(db, user_doc, free_limit)
    # If the group is paid (someone else paid), reflect that.
    if plan == "free" and fgid and await group_is_paid(db, fgid):
        plan = "family_plan"
    members_remaining: Optional[int]
    if limit == math.inf:
        members_remaining = None
    else:
        members_remaining = max(0, int(limit) - int(member_count))

    # Pricing for BOTH plans (offered on the upgrade screen).
    paid_plans = [
        {
            "interval": "month",
            "label": "Monthly",
            "amount_cents": PAID_AMOUNT_CENTS,
            "currency": PAID_CURRENCY,
            "product_name": PAID_PRODUCT_NAME,
            "is_recommended": False,
            "savings_cents": 0,
        },
        {
            "interval": "year",
            "label": "Annual",
            "amount_cents": PAID_ANNUAL_AMOUNT_CENTS,
            "currency": PAID_CURRENCY,
            "product_name": PAID_PRODUCT_NAME,
            "is_recommended": True,
            "savings_cents": annual_savings_cents(),
        },
    ]

    # Resolve the user's current subscription interval (if paid).
    sub_interval = normalize_interval(sub.get("interval")) if sub.get("interval") else None
    if plan == "family_plan" and not sub_interval:
        # Fallback: legacy users without recorded interval are assumed monthly.
        sub_interval = "month"
    plan_label: Optional[str] = None
    if plan == "family_plan":
        plan_label = "Annual Plan" if sub_interval == "year" else "Monthly Plan"

    payload = {
        "plan": plan,
        "plan_label": plan_label,
        "status": sub.get("status"),
        "interval": sub_interval,
        "member_limit": None if limit == math.inf else int(limit),
        "member_count": member_count,
        "members_remaining": members_remaining,
        "current_period_end": (
            sub.get("current_period_end").isoformat()
            if isinstance(sub.get("current_period_end"), datetime) else sub.get("current_period_end")
        ),
        "cancel_at_period_end": bool(sub.get("cancel_at_period_end")),
        "stripe_customer_id": sub.get("stripe_customer_id"),
        # Legacy single-plan field (kept for backward compatibility with any
        # callers that read paid_plan.amount_cents/.interval directly).
        "paid_plan": {
            "amount_cents": (
                PAID_ANNUAL_AMOUNT_CENTS if sub_interval == "year" else PAID_AMOUNT_CENTS
            ),
            "currency": PAID_CURRENCY,
            "interval": sub_interval or "month",
            "product_name": PAID_PRODUCT_NAME,
        },
        # NEW: full pricing menu rendered by the upgrade screen.
        "paid_plans": paid_plans,
        "annual_savings_cents": annual_savings_cents(),
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
