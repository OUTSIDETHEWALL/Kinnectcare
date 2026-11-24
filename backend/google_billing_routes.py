"""Authenticated Google billing routes; no caller-controlled customer identity."""
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict

import billing
import google_billing as google


class EmptyBody(BaseModel):
    model_config = ConfigDict(extra="forbid")


def router(db, get_current_user):
    routes = APIRouter()

    @routes.post("/billing/google/identity")
    async def get_identity(payload: EmptyBody, current=Depends(get_current_user)):
        config = google.settings()
        fresh = await db.users.find_one({"id": current["id"]})
        if not fresh:
            raise HTTPException(401, "Account unavailable")
        if not google.allowed_account(fresh, config["environment"]):
            raise HTTPException(403, "Sandbox billing is restricted to approved test accounts and families")
        # Renewal/restoration must remain available; only purchase is blocked.
        app_user_id = await google.identity(db, current["id"])
        paid = await billing.get_member_limit_for_group(db, fresh) == float("inf")
        purchase_available = google.purchases_enabled(fresh)
        return {
            "user_id": current["id"], "app_user_id": app_user_id,
            "can_purchase": purchase_available and not paid,
            "purchases_enabled": purchase_available,
            "products": {"month": config["GOOGLE_MONTHLY_PRODUCT"],
                         "year": config["GOOGLE_ANNUAL_PRODUCT"]},
        }

    @routes.post("/billing/google/reconcile")
    async def sync(payload: EmptyBody, current=Depends(get_current_user)):
        await google.reconcile(db, current["id"])
        fresh = await db.users.find_one({"id": current["id"]})
        return await billing.build_status_payload(fresh, db)

    @routes.post("/billing/google/webhook")
    async def webhook(request: Request):
        # Bound streamed input even if Content-Length is absent or dishonest.
        data = bytearray()
        async for chunk in request.stream():
            data.extend(chunk)
            if len(data) > 262144:
                raise HTTPException(413, "Webhook too large")
        return await google.receive_webhook(
            db, bytes(data), request.headers.get("authorization"),
            request.headers.get("x-revenuecat-webhook-signature"),
        )

    return routes
