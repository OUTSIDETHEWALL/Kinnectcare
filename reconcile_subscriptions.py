#!/usr/bin/env python3
"""
Kinnship subscription reconciliation tool.

Repairs the local `users.subscription` document by fetching the canonical
state from Stripe. Useful any time Stripe webhooks are dropped, delayed, or
fail (e.g., after a webhook handler bug, an outage, or while migrating).

The script is **idempotent** — running it repeatedly produces the same result
and never charges Stripe or modifies the live subscription. It only reads
from Stripe and writes to Mongo.

Usage:
    # Reconcile one user (case-insensitive email match):
    python3 reconcile_subscriptions.py --email user@example.com

    # Reconcile every user that has a stripe_customer_id on file:
    python3 reconcile_subscriptions.py --all

    # Preview what would change WITHOUT writing to Mongo:
    python3 reconcile_subscriptions.py --all --dry-run

Exit codes:
    0  success (all targeted users reconciled — or nothing to do)
    1  partial failure (one or more users could not be reconciled)
    2  bad usage / config error

Examples:
    # After fixing a webhook bug:
    python3 reconcile_subscriptions.py --all

    # Quick repair of a single user who reports their plan is wrong:
    python3 reconcile_subscriptions.py --email finalcut71@gmail.com --verbose
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
from datetime import datetime, timezone
from typing import Any, Optional

import stripe
from motor.motor_asyncio import AsyncIOMotorClient

# Load env from the backend/.env file regardless of cwd.
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))
except Exception:
    pass

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("reconcile")


# ---------- Stripe helpers ----------

def _normalize(obj: Any) -> dict:
    """Convert a Stripe StripeObject (or anything dict-ish) into a plain dict.

    Matches the normalization the webhook handler does, so this script and the
    webhook stay in sync. Stripe StripeObject's __getattr__ raises
    AttributeError for missing keys (including for `.get`), which is why we
    can't trust `obj.get("foo")` directly.
    """
    if obj is None or isinstance(obj, dict):
        return obj or {}
    for accessor in ("to_dict", "_to_dict_recursive"):
        fn = getattr(obj, accessor, None)
        if callable(fn):
            try:
                d = fn()
                if isinstance(d, dict):
                    return d
            except Exception:  # noqa: BLE001
                continue
    try:
        return dict(obj)
    except Exception:
        return {}


def _ts_to_dt(ts: Optional[int]) -> Optional[datetime]:
    if ts is None:
        return None
    try:
        return datetime.fromtimestamp(int(ts), tz=timezone.utc)
    except Exception:
        return None


def _extract_interval(sub_doc: dict) -> str:
    items = (sub_doc.get("items") or {}).get("data") or []
    if items:
        price = (items[0].get("price") or {})
        rec = price.get("recurring") or {}
        iv = rec.get("interval")
        if iv:
            return "year" if iv in ("year", "yearly", "annual") else "month"
    meta = sub_doc.get("metadata") or {}
    if isinstance(meta, dict) and meta.get("interval"):
        return "year" if meta["interval"] in ("year", "yearly", "annual") else "month"
    return "month"


def _stripe_subscription_for_customer(customer_id: str) -> Optional[dict]:
    """Return the canonical sub for this customer, or None.

    Preference order:
      1. status in (active, trialing, past_due) — these grant access
      2. most recently created subscription (regardless of status)
    """
    try:
        subs = stripe.Subscription.list(customer=customer_id, status="all", limit=10)
    except Exception as e:  # noqa: BLE001
        log.error(f"  stripe list error for {customer_id}: {e}")
        return None
    docs = [_normalize(s) for s in subs.data]
    if not docs:
        return None
    active = [d for d in docs if d.get("status") in ("active", "trialing", "past_due")]
    if active:
        return active[0]
    # Most recent fallback.
    docs.sort(key=lambda d: d.get("created") or 0, reverse=True)
    return docs[0]


# ---------- Reconciliation core ----------

def _build_update(sub_doc: Optional[dict], customer_id: str) -> dict:
    """Build the Mongo $set patch for users.subscription based on Stripe truth.

    If sub_doc is None (customer has no subscriptions at all on Stripe), reset
    plan to free but PRESERVE the stripe_customer_id so future checkouts can
    re-use it.
    """
    if not sub_doc:
        return {
            "subscription.plan": "free",
            "subscription.status": "canceled",
            "subscription.cancel_at_period_end": False,
            "subscription.stripe_customer_id": customer_id,
            "subscription.stripe_subscription_id": None,
            "subscription.updated_at": datetime.now(timezone.utc),
        }

    items = (sub_doc.get("items") or {}).get("data") or []
    item0 = items[0] if items else {}
    cpe_ts = item0.get("current_period_end") or sub_doc.get("current_period_end")
    cps_ts = item0.get("current_period_start") or sub_doc.get("current_period_start")
    status = sub_doc.get("status")
    interval = _extract_interval(sub_doc)

    update = {
        "subscription.plan": "family_plan" if status in ("active", "trialing", "past_due") else "free",
        "subscription.status": status,
        "subscription.stripe_customer_id": customer_id,
        "subscription.stripe_subscription_id": sub_doc.get("id"),
        "subscription.cancel_at_period_end": bool(sub_doc.get("cancel_at_period_end")),
        "subscription.interval": interval,
        "subscription.updated_at": datetime.now(timezone.utc),
    }
    cps = _ts_to_dt(cps_ts)
    cpe = _ts_to_dt(cpe_ts)
    if cps:
        update["subscription.current_period_start"] = cps
    if cpe:
        update["subscription.current_period_end"] = cpe
    return update


def _diff_summary(before: dict, update: dict) -> str:
    """Pretty-print the meaningful subscription deltas."""
    before_sub = before.get("subscription") or {}
    changes = []
    for k, new in update.items():
        # Map "subscription.foo" → "foo"
        key = k.split(".", 1)[1] if k.startswith("subscription.") else k
        old = before_sub.get(key)
        if isinstance(old, datetime):
            old = old.isoformat()
        new_disp = new.isoformat() if isinstance(new, datetime) else new
        if old != new_disp and key != "updated_at":
            changes.append(f"    {key}: {old!r} → {new_disp!r}")
    return "\n".join(changes) if changes else "    (no changes)"


async def reconcile_one(db, user: dict, dry_run: bool, verbose: bool) -> tuple[bool, str]:
    """Reconcile a single user. Returns (success, message)."""
    sub = user.get("subscription") or {}
    customer_id = sub.get("stripe_customer_id")
    if not customer_id:
        return True, f"{user['email']:<40} — skip (no stripe_customer_id)"

    sub_doc = _stripe_subscription_for_customer(customer_id)
    update = _build_update(sub_doc, customer_id)
    new_plan = update.get("subscription.plan")
    new_status = update.get("subscription.status")
    cpe = update.get("subscription.current_period_end")
    cpe_disp = cpe.date().isoformat() if cpe else "—"

    will_change = (
        (sub.get("plan") != new_plan)
        or (sub.get("status") != new_status)
        or (bool(sub.get("cancel_at_period_end")) != bool(update.get("subscription.cancel_at_period_end")))
        or (sub.get("stripe_subscription_id") != update.get("subscription.stripe_subscription_id"))
    )

    status_icon = "🔄" if will_change else "✓"
    line = (
        f"{status_icon} {user['email']:<40} "
        f"plan={sub.get('plan','?'):<11} → {new_plan:<11} "
        f"status={new_status:<10} renews={cpe_disp}"
    )
    if verbose:
        line += "\n" + _diff_summary(user, update)

    if not will_change:
        return True, line + (" (already in sync)" if not verbose else "")
    if dry_run:
        return True, line + "  [dry-run, not written]"
    try:
        await db.users.update_one({"id": user["id"]}, {"$set": update})
        return True, line + "  ✅ updated"
    except Exception as e:  # noqa: BLE001
        return False, line + f"  ❌ db error: {e}"


async def reconcile_many(db, query: dict, dry_run: bool, verbose: bool) -> int:
    fields = {"_id": 0, "id": 1, "email": 1, "subscription": 1}
    users = await db.users.find(query, fields).to_list(length=None)
    if not users:
        log.info("No users matched query.")
        return 0
    log.info(f"Reconciling {len(users)} user(s)...")
    failures = 0
    for u in users:
        ok, line = await reconcile_one(db, u, dry_run, verbose)
        print(line)
        if not ok:
            failures += 1
    print()
    if dry_run:
        log.info("DRY-RUN complete — no DB writes were performed.")
    else:
        log.info(f"Done. {len(users) - failures} succeeded, {failures} failed.")
    return failures


# ---------- CLI ----------

def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Reconcile Kinnship subscriptions from Stripe truth.")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--email", help="Reconcile a single user by email (case-insensitive).")
    g.add_argument("--all", action="store_true", help="Reconcile every user with a stripe_customer_id.")
    p.add_argument("--dry-run", action="store_true", help="Preview changes without writing to Mongo.")
    p.add_argument("--verbose", "-v", action="store_true", help="Print field-level diffs per user.")
    return p.parse_args()


async def _amain(args: argparse.Namespace) -> int:
    sk = os.getenv("STRIPE_SECRET_KEY")
    mongo_url = os.getenv("MONGO_URL")
    db_name = os.getenv("DB_NAME", "test_database")
    if not sk:
        log.error("STRIPE_SECRET_KEY not set in env. Aborting.")
        return 2
    if not mongo_url:
        log.error("MONGO_URL not set in env. Aborting.")
        return 2
    stripe.api_key = sk
    stripe.api_version = "2024-04-10"

    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]
    log.info(f"db={db_name}  stripe_mode={'live' if sk.startswith('sk_live_') else 'test'}")

    try:
        if args.email:
            query = {"email": {"$regex": f"^{args.email}$", "$options": "i"}}
        else:
            query = {"subscription.stripe_customer_id": {"$exists": True, "$ne": None}}
        return await reconcile_many(db, query, args.dry_run, args.verbose)
    finally:
        client.close()


def main() -> None:
    args = _parse_args()
    sys.exit(asyncio.run(_amain(args)))


if __name__ == "__main__":
    main()
