"""Cross-worker transfer preemption; never an SOS authorization substitute.

Only a family ID and server-clock deadline are stored, not incident content.
One logically expiring row per family needs no TTL/index/config migration.
"""
import asyncio

from fastapi import HTTPException
from pymongo.errors import DuplicateKeyError


SOS_PRIORITY_WINDOW_MS = 3000  # Outlasts the unchanged 2s SOS transaction bound.
TRANSFER_PRIORITY_POLL_SECONDS = .05


async def announce(db, family_id):
    # Server time avoids clock skew across workers. Do not clear this on exit:
    # one overlapping SOS must never withdraw another SOS's priority window.
    query = {"_id": family_id}
    update = [{"$set": {"until": {"$add": ["$$NOW", SOS_PRIORITY_WINDOW_MS]}}}]
    try:
        await db.family_sos_priority.update_one(query, update, upsert=True)
    except DuplicateKeyError:
        # Two first announcements can race on the built-in unique _id index.
        result = await db.family_sos_priority.update_one(query, update)
        if result.matched_count != 1:
            raise HTTPException(503, "Unable to establish SOS priority.")


class TransferPriority:
    def __init__(self, db):
        self.db = db
        self.families = set()

    async def check(self):
        if self.families and await self.db.family_sos_priority.find_one({
            "_id": {"$in": sorted(self.families)},
            "$expr": {"$gt": ["$until", "$$NOW"]},
        }, {"_id": 1}):
            # Do not disclose a destination family's emergency activity to an
            # invitee who has not yet become a member of that family.
            raise HTTPException(409, "Family operation interrupted. Check its status before retrying.")

    async def watch(self):
        while True:
            await self.check()
            await asyncio.sleep(TRANSFER_PRIORITY_POLL_SECONDS)

    async def execute(self, operation):
        work = asyncio.create_task(operation())
        watcher = asyncio.create_task(self.watch())
        try:
            done, _ = await asyncio.wait((work, watcher), return_when=asyncio.FIRST_COMPLETED)
            # Prefer a known completed result over a simultaneous priority signal.
            if work in done:
                return await work
            await watcher  # Raises; finally cancels/joins the transaction first.
        finally:
            for task in (work, watcher):
                if not task.done():
                    task.cancel()
            # Cancellation must complete transaction cleanup before responding.
            await asyncio.gather(work, watcher, return_exceptions=True)
