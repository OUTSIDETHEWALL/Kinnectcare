"""Focused regression tests for Stripe entitlement webhook reconciliation."""

import json
import os
import sys
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "kinnship_test")
os.environ.setdefault("JWT_SECRET", "test-suite-only-signing-secret-that-is-long-enough")

with patch("motor.motor_asyncio.AsyncIOMotorClient", MagicMock()):
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
    import server


class FakeRequest:
    def __init__(self, event):
        self.event = event
        self._payload = json.dumps(event).encode()
        self.headers = {"stripe-signature": "test-signature"}

    async def body(self):
        return self._payload


def subscription_event(status: str):
    return {
        "type": "customer.subscription.updated",
        "data": {
            "object": {
                "id": "sub_current",
                "customer": "cus_current",
                "status": status,
                "metadata": {"kinnship_user_id": "user-1"},
            }
        },
    }


def checkout_completed_event():
    return {
        "type": "checkout.session.completed",
        "data": {
            "object": {
                "id": "cs_complete",
                "customer": "cus_current",
                "subscription": "sub_current",
                "metadata": {"kinnship_user_id": "user-1"},
            }
        },
    }


@pytest.mark.asyncio
async def test_delayed_incomplete_event_reconciles_current_active_subscription():
    current_active = {
        "id": "sub_current",
        "customer": "cus_current",
        "status": "active",
        "metadata": {"kinnship_user_id": "user-1"},
    }
    stripe_subscription = server.stripe.Subscription.construct_from(
        current_active, "sk_test"
    )
    apply = AsyncMock()
    request = FakeRequest(subscription_event("incomplete"))

    with (
        patch.object(server.billing, "is_configured", return_value=True),
        patch.dict(os.environ, {"STRIPE_WEBHOOK_SECRET": "whsec_test"}),
        patch.object(
            server.stripe.Webhook, "construct_event", return_value=request.event
        ),
        patch.object(
            server.stripe.Subscription, "retrieve", return_value=stripe_subscription
        ),
        patch.object(server.billing, "apply_subscription_to_user", apply),
    ):
        result = await server.billing_webhook(request)

    assert result == {"status": "ok"}
    persisted = apply.await_args.args[3]
    assert persisted["status"] == "active"
    assert persisted["customer"] == "cus_current"


@pytest.mark.asyncio
async def test_active_then_delayed_incomplete_events_cannot_downgrade_entitlement():
    current_active = {
        "id": "sub_current",
        "customer": "cus_current",
        "status": "active",
        "metadata": {"kinnship_user_id": "user-1"},
    }
    apply = AsyncMock()
    request_active = FakeRequest(subscription_event("active"))
    request_incomplete = FakeRequest(subscription_event("incomplete"))

    with (
        patch.object(server.billing, "is_configured", return_value=True),
        patch.dict(os.environ, {"STRIPE_WEBHOOK_SECRET": "whsec_test"}),
        patch.object(
            server.stripe.Webhook,
            "construct_event",
            side_effect=[request_active.event, request_incomplete.event],
        ),
        patch.object(server.stripe.Subscription, "retrieve", return_value=current_active),
        patch.object(server.billing, "apply_subscription_to_user", apply),
    ):
        await server.billing_webhook(request_active)
        await server.billing_webhook(request_incomplete)

    assert apply.await_count == 2
    assert all(call.args[3]["status"] == "active" for call in apply.await_args_list)


@pytest.mark.asyncio
async def test_webhook_processing_failure_returns_retryable_non_2xx():
    current_active = {
        "id": "sub_current",
        "customer": "cus_current",
        "status": "active",
        "metadata": {"kinnship_user_id": "user-1"},
    }
    request = FakeRequest(subscription_event("active"))

    with (
        patch.object(server.billing, "is_configured", return_value=True),
        patch.dict(os.environ, {"STRIPE_WEBHOOK_SECRET": "whsec_test"}),
        patch.object(
            server.stripe.Webhook, "construct_event", return_value=request.event
        ),
        patch.object(server.stripe.Subscription, "retrieve", return_value=current_active),
        patch.object(
            server.billing,
            "apply_subscription_to_user",
            AsyncMock(side_effect=RuntimeError("database unavailable")),
        ),
    ):
        with pytest.raises(HTTPException) as exc:
            await server.billing_webhook(request)

    assert exc.value.status_code == 500
    assert exc.value.detail == "Webhook processing failed"


@pytest.mark.asyncio
async def test_active_subscription_persists_family_plan_and_active_status():
    update_result = MagicMock(matched_count=1)
    users = MagicMock()
    users.update_one = AsyncMock(return_value=update_result)
    fake_db = MagicMock(users=users)
    subscription = {
        "id": "sub_current",
        "status": "active",
        "items": {"data": [{"price": {"recurring": {"interval": "month"}}}]},
        "cancel_at_period_end": False,
    }

    await server.billing.apply_subscription_to_user(
        fake_db, "user-1", "cus_current", subscription
    )

    update = users.update_one.await_args.args[1]["$set"]
    assert update["subscription.plan"] == "family_plan"
    assert update["subscription.status"] == "active"
    assert update["subscription.interval"] == "month"


@pytest.mark.asyncio
async def test_checkout_completed_persists_real_stripe_active_subscription():
    current_active = {
        "id": "sub_current",
        "customer": "cus_current",
        "status": "active",
        "items": {"data": [{"price": {"recurring": {"interval": "month"}}}]},
        "metadata": {"kinnship_user_id": "user-1"},
        "cancel_at_period_end": False,
    }
    stripe_subscription = server.stripe.Subscription.construct_from(
        current_active, "sk_test"
    )
    update_result = MagicMock(matched_count=1)
    users = MagicMock()
    users.update_one = AsyncMock(return_value=update_result)
    fake_db = MagicMock(users=users)
    request = FakeRequest(checkout_completed_event())

    with (
        patch.object(server.billing, "is_configured", return_value=True),
        patch.dict(os.environ, {"STRIPE_WEBHOOK_SECRET": "whsec_test"}),
        patch.object(
            server.stripe.Webhook, "construct_event", return_value=request.event
        ),
        patch.object(
            server.stripe.Subscription, "retrieve", return_value=stripe_subscription
        ),
        patch.object(server, "db", fake_db),
    ):
        result = await server.billing_webhook(request)

    assert result == {"status": "ok"}
    update = users.update_one.await_args.args[1]["$set"]
    assert update["subscription.plan"] == "family_plan"
    assert update["subscription.status"] == "active"


@pytest.mark.asyncio
async def test_unmatched_entitlement_write_fails_for_webhook_retry():
    update_result = MagicMock(matched_count=0)
    users = MagicMock()
    users.update_one = AsyncMock(return_value=update_result)
    fake_db = MagicMock(users=users)
    subscription = {
        "id": "sub_current",
        "status": "active",
        "items": {"data": []},
        "cancel_at_period_end": False,
    }

    with pytest.raises(RuntimeError, match="could not be matched"):
        await server.billing.apply_subscription_to_user(
            fake_db, "missing-user", "cus_current", subscription
        )