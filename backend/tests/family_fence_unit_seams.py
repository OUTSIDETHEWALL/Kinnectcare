"""Storage-only seams for pre-existing algorithm tests with nontransactional DBs.

These mocks are NOT concurrency/authorization evidence. The production helpers
are exercised without these seams by test_family_write_fence_mongo.py.
"""
import copy
import family_write_fence as fw
import sos_history as sh


def install(monkeypatch):
    async def insert(db, collection, document, **kwargs):
        return await getattr(db, collection).insert_one(copy.deepcopy(document))

    async def background(db, collection, document):
        await insert(db, collection, document)
        return True

    async def sos(db, document, actor_id, *, explicit_member_id=None):
        await insert(db, "alerts", document)
        return document, {"id": actor_id, "family_group_id": document["family_group_id"]}

    async def resolve(db, gid, aid, actor_id, updates):
        row = await db.alerts.find_one({"id": aid, "family_group_id": gid})
        if row.get("resolved") is updates["resolved"]:
            return row, False
        await db.alerts.update_one({"id": aid, "family_group_id": gid}, {"$set": updates})
        return {**row, **updates}, True

    async def acknowledge(db, actor_id, gid, aid, *, finish_medication=False):
        query = {"id": aid, **await sh.family_alert_query(db, gid)}
        row = await db.alerts.find_one(query)
        if not row:
            from fastapi import HTTPException
            raise HTTPException(404, "Alert not found")
        if (row.get("type") == "medication" and row.get("self_due") is True) == finish_medication:
            await db.alerts.update_one(query, {"$set": {"acknowledged": True}})
        return row

    monkeypatch.setattr(fw, "insert_record", insert)
    monkeypatch.setattr(fw, "insert_background_record", background)
    monkeypatch.setattr(fw, "persist_sos", sos)
    monkeypatch.setattr(fw, "change_sos_resolution", resolve)
    monkeypatch.setattr(sh, "acknowledge_in_family", acknowledge)
