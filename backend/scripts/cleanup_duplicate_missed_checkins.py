"""One-time cleanup of duplicate missed_checkin alerts.

Removes redundant copies of missed_checkin alerts for the same
(family_group_id, member_id) on the same calendar day, keeping
only the OLDEST one.  Safe to re-run — idempotent once duplicates
are gone.

Usage (on Railway):
    python -m scripts.cleanup_duplicate_missed_checkins
"""
from __future__ import annotations

import asyncio
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone

from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

load_dotenv()


async def main() -> None:
    mongo_url = os.environ.get("MONGO_URL")
    db_name = os.environ.get("DB_NAME") or "kinnship"
    if not mongo_url:
        print("MONGO_URL not set; aborting.", file=sys.stderr)
        sys.exit(1)

    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]
    print(f"Connected to {db_name}.  Scanning alerts.missed_checkin ...")

    cursor = db.alerts.find(
        {"type": "missed_checkin"},
        {"_id": 1, "id": 1, "family_group_id": 1, "member_id": 1, "created_at": 1, "slot_key": 1},
    ).sort("created_at", 1)
    docs = await cursor.to_list(100000)
    print(f"Found {len(docs)} missed_checkin alerts.")

    # Bucket by (family_group_id, member_id, YYYY-MM-DD).  If slot_key
    # exists prefer it; otherwise fall back to the created-at day.
    buckets: dict[tuple, list] = defaultdict(list)
    for d in docs:
        fg = d.get("family_group_id") or ""
        mid = d.get("member_id") or ""
        slot = d.get("slot_key")
        if not slot:
            ca = d.get("created_at")
            if isinstance(ca, str):
                try:
                    ca = datetime.fromisoformat(ca.replace("Z", "+00:00"))
                except Exception:
                    ca = None
            if ca and ca.tzinfo is None:
                ca = ca.replace(tzinfo=timezone.utc)
            slot = ca.date().isoformat() if ca else "unknown"
        buckets[(fg, mid, slot)].append(d)

    to_delete: list = []
    for key, group in buckets.items():
        if len(group) <= 1:
            continue
        # Keep the EARLIEST; delete the rest.
        keep = group[0]
        for d in group[1:]:
            to_delete.append(d["_id"])
        print(f"  bucket {key}: keep {keep.get('id')} ({keep.get('created_at')}), drop {len(group)-1}")

    if not to_delete:
        print("No duplicates found.  Nothing to do.")
        client.close()
        return

    print(f"Deleting {len(to_delete)} duplicate alert(s) ...")
    r = await db.alerts.delete_many({"_id": {"$in": to_delete}})
    print(f"Deleted {r.deleted_count} document(s).")
    client.close()


if __name__ == "__main__":
    asyncio.run(main())
