"""Storage-only seams for pre-existing algorithm tests with nontransactional DBs.

These mocks are NOT concurrency/authorization evidence. The production helpers
are exercised without these seams by test_family_write_fence_mongo.py.
"""
import copy
import family_write_fence as fw


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

    monkeypatch.setattr(fw, "insert_record", insert)
    monkeypatch.setattr(fw, "insert_background_record", background)
    monkeypatch.setattr(fw, "persist_sos", sos)
    monkeypatch.setattr(fw, "change_sos_resolution", resolve)
