"""Synthetic billing tests. Store reads mocked; integration uses owned loopback Mongo."""
import asyncio
import copy
import hashlib
import hmac
import json
import os
import pathlib
import sys
from datetime import timedelta
from unittest.mock import AsyncMock
from types import SimpleNamespace

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI, HTTPException, Request
from motor.motor_asyncio import AsyncIOMotorClient

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import billing
import google_billing as google
import google_billing_routes
from test_email_links_mongo_integration import local_replica


@pytest.fixture(autouse=True)
def config(monkeypatch):
    assert pathlib.Path(billing.__file__).resolve().parent == pathlib.Path(google.__file__).resolve().parent
    for key, value in {
        "GOOGLE_BILLING_ENABLED": "true",
        "GOOGLE_BILLING_ORIGINAL_OWNER_CONFIRMED": "true",
        "REVENUECAT_PROJECT_ID": "proj_test",
        "REVENUECAT_GOOGLE_APP_ID": "app_test",
        "REVENUECAT_SECRET_API_KEY": "synthetic-not-a-credential",
        "REVENUECAT_ENTITLEMENT_ID": "ent_test",
        "GOOGLE_MONTHLY_PRODUCT": "family_plan:monthly",
        "GOOGLE_ANNUAL_PRODUCT": "family_plan:annual",
        "GOOGLE_BILLING_ENVIRONMENT": "production",
        "REVENUECAT_WEBHOOK_AUTH": "Bearer synthetic-hook-auth",
        "REVENUECAT_WEBHOOK_SIGNING_SECRET": "synthetic-hook-signing",
    }.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setattr(billing, "is_configured", lambda: False)
    return google.settings()


def snapshot(purchaser="opaque-id", status="active", access=True, interval="month", environment="production"):
    at = google.now()
    sub = {
        "id": "sub_test", "customer_id": purchaser, "original_customer_id": purchaser,
        "store": "play_store", "environment": environment, "product_id": "prod_test",
        "store_subscription_identifier": "GPA.0000-1111-2222-33333..2",
        "ownership": "purchased", "gives_access": access, "status": status,
        "pending_payment": status in ("incomplete", "in_grace_period"),
        "ends_at": (at + timedelta(days=30)).timestamp() * 1000,
        "current_period_ends_at": (at + timedelta(days=30)).timestamp() * 1000,
        "auto_renewal_status": "will_renew",
        "entitlements": {"items": [{"id": "ent_test"}]},
    }
    ent = {"entitlement_id": "ent_test", "expires_at": (at + timedelta(days=30)).timestamp() * 1000}
    prod = {"app_id": "app_test", "store_identifier": "family_plan:" + ("monthly" if interval == "month" else "annual")}
    return [sub], [ent], {"prod_test": prod}


@pytest.mark.parametrize("interval", ["month", "year"])
def test_verified_google_entitlement(config, interval):
    grant, chains = google.projection(config, "opaque-id", *snapshot(interval=interval))
    assert google.google_access({"google_subscription": grant})
    assert grant["interval"] == interval
    assert "order:GPA.0000-1111-2222-33333" in chains


@pytest.mark.parametrize("status", ["incomplete", "in_billing_retry", "paused", "expired"])
def test_non_access_lifecycle_never_grants(config, status):
    grant, _ = google.projection(config, "opaque-id", *snapshot(status=status, access=False))
    assert not google.google_access({"google_subscription": grant})
    assert grant["status"] == status


def test_grace_uses_exact_entitlement_expiry(config):
    subs, ent, products = snapshot(status="in_grace_period")
    subs[0]["ends_at"] = (google.now() - timedelta(minutes=1)).timestamp() * 1000
    ent[0]["expires_at"] = (google.now() + timedelta(days=2)).timestamp() * 1000
    grant, _ = google.projection(config, "opaque-id", subs, ent, products)
    assert google.google_access({"google_subscription": grant})
    assert grant["access_until"] == google.millis(ent[0]["expires_at"])
    assert not google.google_access({"google_subscription": grant}, grant["access_until"])


def test_cancellation_preserves_paid_period(config):
    subs, ent, products = snapshot()
    subs[0]["auto_renewal_status"] = "will_not_renew"
    grant, _ = google.projection(config, "opaque-id", subs, ent, products)
    assert grant["cancel_at_period_end"] is True
    assert google.google_access({"google_subscription": grant})


@pytest.mark.parametrize("field,value", [
    ("customer_id", "attacker"), ("original_customer_id", "attacker"), ("ownership", "family_shared"),
])
def test_cross_account_and_store_sharing_rejected(config, field, value):
    subs, ent, products = snapshot()
    subs[0][field] = value
    with pytest.raises(HTTPException) as exc:
        google.projection(config, "opaque-id", subs, ent, products)
    assert exc.value.status_code == 409


@pytest.mark.parametrize("change", ["wrong_app", "unknown_product", "other_store", "sandbox", "missing_entitlement"])
def test_wrong_source_cannot_grant(config, change):
    subs, ent, products = snapshot()
    if change == "wrong_app":
        products["prod_test"]["app_id"] = "another_app"
    elif change == "unknown_product":
        products["prod_test"]["store_identifier"] = "unapproved"
    elif change == "other_store":
        subs[0]["store"] = "stripe"
    elif change == "sandbox":
        subs[0]["environment"] = "sandbox"
    else:
        subs[0]["entitlements"] = {"items": []}
    grant, _ = google.projection(config, "opaque-id", subs, ent, products)
    assert not google.google_access({"google_subscription": grant})


def test_sandbox_requires_both_approved_user_and_family(config, monkeypatch):
    grant, _ = google.projection(config, "opaque-id", *snapshot())
    grant["environment"] = "sandbox"
    user = {"id": "tester", "family_group_id": "test-family", "google_subscription": grant}
    assert not google.google_access(user)
    monkeypatch.setenv("GOOGLE_BILLING_TEST_USER_IDS", "tester")
    assert not google.google_access(user)
    monkeypatch.setenv("GOOGLE_BILLING_TEST_FAMILY_IDS", "test-family")
    assert google.google_access(user)
    user["family_group_id"] = "real-family"
    assert not google.google_access(user)


def test_activation_and_restore_confirmation_fail_closed(config, monkeypatch):
    monkeypatch.delenv("GOOGLE_BILLING_ENABLED")
    with pytest.raises(HTTPException):
        google.settings()
    monkeypatch.setenv("GOOGLE_BILLING_ENABLED", "true")
    monkeypatch.delenv("GOOGLE_BILLING_ORIGINAL_OWNER_CONFIRMED")
    with pytest.raises(HTTPException):
        google.settings()


def signed(event=None, stamp=2000000000):
    event = event or {"id": "event-test", "app_id": "app_test", "app_user_id": "opaque-id",
                      "environment": "PRODUCTION", "type": "RENEWAL"}
    raw = json.dumps({"event": event}).encode()
    digest = hmac.new(b"synthetic-hook-signing", str(stamp).encode() + b"." + raw, hashlib.sha256).hexdigest()
    return raw, "Bearer synthetic-hook-auth", f"t={stamp},v1={digest}"


def test_hmac_accepts_raw_signed_body_and_rejects_tamper(config):
    raw, auth, signature = signed()
    google.verify_webhook(raw, auth, signature, timestamp=2000000000)
    for body, header, sig, stamp in [
        (raw + b" ", auth, signature, 2000000000),
        (raw, "wrong", signature, 2000000000),
        (raw, auth, signature, 2000000400),
        (raw, auth, "broken", 2000000000),
    ]:
        with pytest.raises(HTTPException) as exc:
            google.verify_webhook(body, header, sig, timestamp=stamp)
        assert exc.value.status_code == 401


@pytest.mark.asyncio
async def test_api_unknown_customer_is_empty_but_auth_failure_never_revokes(config, monkeypatch):
    class FakeClient:
        status = 404
        def __init__(self, **kwargs):
            assert kwargs["follow_redirects"] is False
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        async def get(self, url, headers):
            assert url.startswith("https://api.revenuecat.com/v2/projects/proj_test/")
            assert headers["Authorization"] == "Bearer synthetic-not-a-credential"
            return type("Response", (), {"status_code": self.status})()
    monkeypatch.setattr(google.httpx, "AsyncClient", FakeClient)
    client = google.RevenueCat(config)
    assert await client.snapshot("opaque-id") == ([], [], {})
    FakeClient.status = 401
    with pytest.raises(HTTPException) as exc:
        await client.snapshot("opaque-id")
    assert exc.value.status_code == 503


@pytest.mark.asyncio
async def test_provider_pagination_cannot_redirect_secrets(config):
    with pytest.raises(HTTPException):
        await google.RevenueCat(config).get("https://attacker.invalid/steal")


@pytest.mark.asyncio
async def test_optional_worker_retries_initialization_failure_without_running_sweep(config, monkeypatch):
    users = SimpleNamespace(create_index=AsyncMock(side_effect=RuntimeError("Synthetic index failure")))
    fake_db = SimpleNamespace(users=users)
    sweep = AsyncMock()
    sleep = AsyncMock(side_effect=asyncio.CancelledError)
    monkeypatch.setattr(google, "sweep", sweep)
    monkeypatch.setattr(google.asyncio, "sleep", sleep)
    with pytest.raises(asyncio.CancelledError):
        await google.worker(fake_db)
    users.create_index.assert_awaited_once()
    sweep.assert_not_awaited()
    sleep.assert_awaited_once_with(30)


RUN_MONGO = pytest.mark.skipif(os.getenv("KINNSHIP_RUN_LOCAL_MONGO_TESTS") != "1",
                               reason="Explicit opt-in for disposable Mongo integration")


@pytest_asyncio.fixture
async def db(local_replica):
    client = AsyncIOMotorClient(local_replica, tz_aware=True)
    name = "disposable_google_" + google.uuid.uuid4().hex
    database = client[name]
    await database.users.insert_many([
        {"id": "buyer", "family_group_id": "family", "google_billing_id": "opaque-id"},
        {"id": "other", "family_group_id": "other-family", "google_billing_id": "other-opaque"},
    ])
    await database.users.create_index("google_billing_id", unique=True, sparse=True)
    try:
        yield database
    finally:
        await client.drop_database(name)
        client.close()


@RUN_MONGO
class TestMongoBilling:
    @pytest.mark.asyncio
    async def test_reconcile_and_revoke_do_not_modify_stripe(self, db, config):
        stripe = {"plan": "family_plan", "status": "active", "stripe_subscription_id": "sub_stripe"}
        await db.users.update_one({"id": "buyer"}, {"$set": {"subscription": stripe}})
        client = type("Fake", (), {"snapshot": AsyncMock(return_value=snapshot())})()
        await google.reconcile(db, "buyer", client)
        user = await db.users.find_one({"id": "buyer"})
        assert user["subscription"] == stripe
        assert billing.plan_for_user(user) == "family_plan"
        assert await billing.group_is_paid(db, "family")
        client.snapshot.return_value = snapshot(status="expired", access=False)
        await google.reconcile(db, "buyer", client)
        user = await db.users.find_one({"id": "buyer"})
        assert user["subscription"] == stripe
        assert not google.google_access(user)
        assert billing.plan_for_user(user) == "family_plan"

    @pytest.mark.asyncio
    async def test_stripe_event_updates_cannot_erase_google_grant(self, db, config):
        client = type("Fake", (), {"snapshot": AsyncMock(return_value=snapshot())})()
        await google.reconcile(db, "buyer", client)
        await billing.apply_subscription_to_user(db, "buyer", "cus_test", {
            "id": "sub_stripe", "status": "canceled",
        })
        assert billing.plan_for_user(await db.users.find_one({"id": "buyer"})) == "family_plan"
        await billing.revert_user_to_free_by_customer(db, "cus_test")
        assert billing.plan_for_user(await db.users.find_one({"id": "buyer"})) == "family_plan"

    @pytest.mark.asyncio
    async def test_immutable_ownership_blocks_even_changed_provider_claim(self, db, config):
        client = type("Fake", (), {"snapshot": AsyncMock(return_value=snapshot())})()
        await google.reconcile(db, "buyer", client)
        client.snapshot.return_value = snapshot(purchaser="other-opaque")
        with pytest.raises(HTTPException) as exc:
            await google.reconcile(db, "other", client)
        assert exc.value.status_code == 409
        assert not (await db.users.find_one({"id": "other"})).get("google_subscription")
        assert not (await db.users.find_one({"id": "other"})).get("google_billing_lock")

    @pytest.mark.asyncio
    async def test_concurrent_reconciles_are_serialized_and_stale_lease_cannot_publish(self, db, config):
        entered, release = asyncio.Event(), asyncio.Event()
        async def blocked(_):
            entered.set()
            await release.wait()
            return snapshot()
        client = type("Fake", (), {"snapshot": staticmethod(blocked)})()
        pending = asyncio.create_task(google.reconcile(db, "buyer", client))
        await entered.wait()
        with pytest.raises(HTTPException) as exc:
            await google.reconcile(db, "buyer", client)
        assert exc.value.status_code == 409
        await db.users.update_one({"id": "buyer"}, {"$set": {
            "google_billing_lock": {"token": "new-owner", "until": google.now() + timedelta(minutes=2)},
        }})
        release.set()
        with pytest.raises(HTTPException):
            await pending
        user = await db.users.find_one({"id": "buyer"})
        assert "google_subscription" not in user
        assert user["google_billing_lock"]["token"] == "new-owner"

    @pytest.mark.asyncio
    async def test_group_paid_query_does_not_stop_at_fifty(self, db, config):
        await db.users.insert_many([{"id": f"old-{i}", "family_group_id": "large",
                                    "subscription": {"plan": "family_plan", "status": "canceled"}}
                                   for i in range(55)])
        grant, _ = google.projection(config, "opaque-id", *snapshot())
        await db.users.insert_one({"id": "last", "family_group_id": "large", "google_subscription": grant})
        assert await billing.group_is_paid(db, "large")

    @pytest.mark.asyncio
    async def test_routes_reject_spoofing_and_duplicate_purchase(self, db, config, monkeypatch):
        app = FastAPI()
        async def current(request: Request):
            user = await db.users.find_one({"id": request.headers.get("x-test-user")})
            if not user:
                raise HTTPException(401, "Sign in")
            return user
        app.include_router(google_billing_routes.router(db, current), prefix="/api")
        grant, _ = google.projection(config, "opaque-id", *snapshot())
        await db.users.update_one({"id": "buyer"}, {"$set": {"google_subscription": grant}})
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://test.invalid") as http:
            response = await http.post("/api/billing/google/identity", json={})
            assert response.status_code == 401
            response = await http.post("/api/billing/google/identity", json={}, headers={"x-test-user": "buyer"})
            assert response.json()["can_purchase"] is False
            for route in ("identity", "reconcile"):
                response = await http.post("/api/billing/google/" + route,
                                           json={"app_user_id": "opaque-id", "user_id": "buyer"},
                                           headers={"x-test-user": "other"})
                assert response.status_code == 422
            # A family beneficiary must not be offered another subscription.
            await db.users.update_one({"id": "other"}, {"$set": {"family_group_id": "family"}})
            response = await http.post("/api/billing/google/identity", json={}, headers={"x-test-user": "other"})
            assert response.json()["can_purchase"] is False

    @pytest.mark.asyncio
    async def test_webhook_inbox_deduplicates_and_does_not_persist_attributes(self, db, config, monkeypatch):
        monkeypatch.setattr(google.time, "time", lambda: 2000000000)
        event = {"id": "evt", "app_id": "app_test", "app_user_id": "opaque-id",
                 "environment": "PRODUCTION", "type": "RENEWAL",
                 "subscriber_attributes": {"sensitive": "must-not-store"}}
        raw, auth, signature = signed(event)
        await google.receive_webhook(db, raw, auth, signature)
        await google.receive_webhook(db, raw, auth, signature)
        assert await db.google_billing_events.count_documents({}) == 1
        record = await db.google_billing_events.find_one({})
        assert "subscriber_attributes" not in record
        assert "must-not-store" not in str(record)
        assert not (await db.users.find_one({"id": "buyer"})).get("google_subscription")
        assert record["done"] is False

    @pytest.mark.asyncio
    async def test_inbox_retries_after_failure_and_reconciles_latest_state(self, db, config, monkeypatch):
        await db.google_billing_events.insert_one({
            "_id": "evt", "app_user_id": "opaque-id", "done": False,
            "next_attempt": google.now(), "attempts": 0,
        })
        mock = AsyncMock(side_effect=HTTPException(503, "Store down"))
        monkeypatch.setattr(google, "reconcile", mock)
        await google.sweep(db)
        event = await db.google_billing_events.find_one({})
        assert event["done"] is False and event["attempts"] == 1
        mock.side_effect = None
        await db.google_billing_events.update_one({}, {"$set": {"next_attempt": google.now()}})
        await google.sweep(db)
        assert (await db.google_billing_events.find_one({}))["done"] is True

    @pytest.mark.asyncio
    async def test_provider_failure_preserves_last_verified_state(self, db, config):
        grant, _ = google.projection(config, "opaque-id", *snapshot())
        await db.users.update_one({"id": "buyer"}, {"$set": {"google_subscription": grant}})
        client = type("Fake", (), {"snapshot": AsyncMock(side_effect=HTTPException(503, "Unavailable"))})()
        with pytest.raises(HTTPException):
            await google.reconcile(db, "buyer", client)
        assert google.google_access(await db.users.find_one({"id": "buyer"}))

    @pytest.mark.asyncio
    async def test_google_status_overlays_canceled_stripe_without_changing_storage(self, db, config):
        grant, _ = google.projection(config, "opaque-id", *snapshot())
        stripe = {"plan": "free", "status": "canceled", "stripe_subscription_id": "old_stripe"}
        await db.users.update_one({"id": "buyer"}, {"$set": {
            "subscription": stripe, "google_subscription": grant,
        }})
        user = await db.users.find_one({"id": "buyer"})
        payload = await billing.build_status_payload(user, db)
        assert payload["plan"] == "family_plan"
        assert payload["billing_provider"] == "google_play"
        assert payload["billing_providers"] == ["stripe", "google_play"]
        assert payload["paid_plan"] is None  # no invented localized Google price
        assert (await db.users.find_one({"id": "buyer"}))["subscription"] == stripe
