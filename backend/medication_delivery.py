"""Provider evidence for medication escalation only; no change to other pushes."""
import logging

logger = logging.getLogger(__name__)


def successful_completion(result) -> bool:
    """An attempted-device count is not successful provider acceptance."""
    return (
        isinstance(result, dict)
        and result.get("outcome") == "accepted"
        and isinstance(result.get("accepted_ticket_ids"), list)
        and bool(result["accepted_ticket_ids"])
        and all(isinstance(t, str) and t for t in result["accepted_ticket_ids"])
    )


async def send_verified_escalation(
    db, user_ids, title, body, data, *, send_with_tickets, in_quiet_hours,
):
    """Wait for every fanout operation and retain only token-safe evidence.

    Quiet-hours and dead-token pruning retain their existing policy. Unknown
    results are never converted into success, even if another recipient was
    accepted. Expo acceptance is not proof of display on a physical phone.
    """
    accepted = []
    unknown = False
    failed = False
    for uid in user_ids:
        user = await db.users.find_one(
            {"id": uid}, {"_id": 0, "push_tokens": 1, "quiet_hours": 1, "timezone": 1},
        )
        if not user or not user.get("push_tokens") or in_quiet_hours(user):
            continue
        result = await send_with_tickets(user["push_tokens"], title, body, data)
        dead = result.get("dead_tokens") or []
        if dead:
            try:
                await db.users.update_one({"id": uid}, {"$pullAll": {"push_tokens": dead}})
            except Exception as exc:
                logger.warning("Medication dead-token pruning failed: %s", type(exc).__name__)
        if result.get("transport_status") == "no_valid_tokens":
            continue
        tickets = result.get("tickets") or []
        if (
            result.get("transport_status") != "response_received"
            or len(tickets) != result.get("valid_token_count")
        ):
            unknown = True
            continue
        for ticket in tickets:
            if ticket.get("status") == "ok" and ticket.get("ticket_id"):
                accepted.append(ticket["ticket_id"])
            elif ticket.get("status") == "error":
                failed = True
            else:
                unknown = True
    outcome = "unknown" if unknown else "failed" if failed or not accepted else "accepted"
    return {"outcome": outcome, "accepted_ticket_ids": accepted}
