"""Storage-only seams for pre-existing algorithm tests with nontransactional DBs.

These mocks are NOT concurrency/authorization evidence. The production helpers
are exercised without these seams by test_family_write_fence_mongo.py.
"""
import copy
import family_write_fence as fw
import sos_history as sh


def install(monkeypatch):
    authorize = fw.actor_in_family

    async def actor(db, actor_id, gid, *, owner=False):
        # Older algorithm fixtures supply identity directly and don't seed
        # a full roster. Keep real owner authorization in these fixtures.
        if owner:
            group = await db.family_groups.find_one({"id": gid, "owner_user_id": actor_id})
            if not group:
                from fastapi import HTTPException
                raise HTTPException(403, "Only the current family owner can do this.")
        record = await db.users.find_one({"id": actor_id}) if hasattr(db, "users") else None
        if record and record.get("family_group_id"):
            return await authorize(db, actor_id, gid, owner=owner)
        return {**(record or {}), "id": actor_id, "family_group_id": gid}

    async def insert(db, collection, document, **kwargs):
        return await getattr(db, collection).insert_one(copy.deepcopy(document))

    async def background(db, collection, document):
        await insert(db, collection, document)
        return True

    async def sos(db, document, actor_id, *, explicit_member_id=None):
        await insert(db, "alerts", document)
        return document, {"id": actor_id, "family_group_id": document["family_group_id"]}

    async def resolve(db, gid, aid, actor_id, updates, *, include_ordinary=False):
        row = await db.alerts.find_one({"id": aid, "family_group_id": gid})
        if not row:
            from fastapi import HTTPException
            raise HTTPException(404, "Alert not found")
        if row.get("resolved") is updates["resolved"]:
            return row, False
        await db.alerts.update_one({"id": aid, "family_group_id": gid}, {"$set": updates})
        return {**row, **updates}, True

    async def acknowledge(db, actor_id, gid, aid, *, complete_medication=None):
        query = {"id": aid, **await sh.family_alert_query(db, gid)}
        row = await db.alerts.find_one(query)
        if not row:
            from fastapi import HTTPException
            raise HTTPException(404, "Alert not found")
        if row.get("type") == "medication" and row.get("self_due") is True:
            await complete_medication(db, row)
        await db.alerts.update_one(query, {"$set": {"acknowledged": True}})
        return row

    monkeypatch.setattr(fw, "insert_record", insert)
    monkeypatch.setattr(fw, "insert_background_record", background)
    monkeypatch.setattr(fw, "persist_sos", sos)
    monkeypatch.setattr(fw, "change_sos_resolution", resolve)
    monkeypatch.setattr(sh, "acknowledge_in_family", acknowledge)
    monkeypatch.setattr(fw, "actor_in_family", actor)

    async def run(db, family_ids, action, **kwargs):
        return await action(db)

    monkeypatch.setattr(fw, "run", run)
