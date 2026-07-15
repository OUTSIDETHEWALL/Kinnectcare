# Build 60 — GPS Capture Timestamp Guard

**Date:** 2026-07-15
**Scope:** Backend only
**Files changed:** `backend/server.py`, `backend/test_captured_at_guard.py`
**Commit:** `d52eef5`

---

## Problem

After a device comes back online following a period of poor connectivity, the Transistor Background Geolocation SDK replays its buffered location queue in bulk — up to 90 uploads per minute. The backend had no way to distinguish a buffered GPS fix captured hours earlier from a live upload, because it wrote `last_seen = datetime.now()` (server clock) unconditionally on every request. Whichever HTTP request completed last won, regardless of when the GPS point was actually captured. During a replay, the member row oscillated across every location the device had visited that day. Caregivers saw a different location on each pull-to-refresh — always a real place the senior had been, but never reliably the current one.

**Evidence from today's incident (Charles's device, 2026-07-15):**

- 5,929 location uploads for a single member in one day
- Upload rate spiked from ~4/min to ~90/min at 20:03 UTC when the SDK began flushing its buffer
- During the flush, a single minute contained GPS fixes from up to 12 distinct locations visited between 13:48 and 16:00 — all arriving concurrently and overwriting each other
- The backend's unconditional `$set` meant the last write to complete determined what caregivers saw

---

## Root cause

`update_member_location` wrote lat/lon unconditionally with no ordering guard. The Transistor SDK sends a `timestamp` field (GPS capture time) on every upload — the backend accepted it and immediately discarded it, storing only the server-side `datetime.now()` as `last_seen`.

---

## Fix

### `LocationUpdate` model

Added an explicit `timestamp` field (`Optional[Union[str, int, float]]`) and a `captured_at` property that parses it into a UTC datetime. Handles all SDK payload shapes:

- **Primary flat path** (`locationTemplate`): top-level ISO-8601 string
- **Android nested fallback** (Build 50 edge case — SQLite batch-replay bypasses `locationTemplate`): top-level field on the SDK's default shape; `coords.timestamp` used as secondary fallback
- **Unix epoch milliseconds**: integer or float, converted correctly
- **Absent** (JS-side heartbeat callers): returns `None`; triggers unconditional write to preserve pre-Build-60 behaviour

### `FamilyMember` model

Added `captured_at: Optional[datetime] = None`. Existing rows without the field deserialise cleanly as `None` and are populated on the next successful upload. Included in the `@field_serializer` alongside `last_seen`.

### `update_member_location` handler

**Atomic conditional write.** The MongoDB `update_one` filter is:

```python
{
    "id": member_id,
    "family_group_id": current["family_group_id"],
    "$or": [
        {"captured_at": {"$exists": False}},   # first upload
        {"captured_at": {"$lt": incoming_captured_at}},  # strictly newer
    ],
}
```

The filter and `$set` are evaluated atomically by MongoDB, making the guard safe against concurrent uploads from the same device (the ~90/min replay rate).

**Semantics:**
- `captured_at > stored` → accept: lat/lon and `captured_at` written
- `captured_at == stored` → reject: duplicate, already applied
- `captured_at < stored` → reject: historical buffered point, ignored
- `captured_at` absent → unconditional write: fallback for callers that don't send a timestamp

**`last_seen` is always written** regardless of whether the guard accepts or rejects the coordinates. Leonidas heartbeat monitoring reads only `last_seen` and is completely unaffected — the device remains "alive" even when every buffered historical point is rejected.

**Upper-bound clock guard.** If `captured_at > server_now + 5 minutes`, the timestamp is discarded and the handler falls back to the unconditional write path. This prevents a device with a bad clock from writing a future `captured_at` that would permanently block subsequent real uploads.

### `location_ingest_log`

Four permanent diagnostic fields added to every ingest log entry:

| Field | Type | Meaning |
|---|---|---|
| `incoming_captured_at` | `datetime \| None` | GPS capture time parsed from the SDK payload |
| `stored_captured_at` | `datetime \| None` | Value in the member doc before this write |
| `write_accepted` | `bool` | Whether the guard accepted the lat/lon write |
| `rejection_reason` | `str \| None` | `"older_timestamp"` when rejected; `None` when accepted |

These fields are permanent, not temporary debugging. They provide the evidence trail needed for future support cases and regression analysis (e.g. confirming a buffer replay completed correctly, or identifying a device with a bad clock).

### `diagnostics/my-members`

`captured_at` added to the field projection and the datetime normalisation loop. The diagnostic screen now surfaces GPS capture time alongside server contact time, making the gap between "device last uploaded" and "GPS fix was actually captured" visible.

---

## What does not change

- **`last_seen`** remains the server contact timestamp used by Leonidas, the dashboard staleness indicator, and all existing queries. Its meaning and update behaviour are unchanged.
- **Joyce's device** is unaffected. Her member row has its own `captured_at`; Charles's uploads never touch it.
- **The `/members` response shape** gains one optional field (`captured_at`). Old app builds ignore unknown fields; no client change is required.
- **The JS-side heartbeat path** (callers that don't use the Transistor SDK directly) receives the unconditional write fallback. No behaviour change.

---

## Regression

`backend/test_captured_at_guard.py` — 31 tests, all passing. No write access to production required.

| Part | Tests | What is covered |
|---|---|---|
| 1 — Unit | 12 | `captured_at` parsing: ISO-8601 ± ms, epoch ms int/float, `coords.timestamp` fallback, absent, unparseable, future, upper-bound guard |
| 2 — Simulation | 15 | Guard filter logic: first upload, historical reject, duplicate reject, newer accept, 30-upload buffer-replay scenario, no-timestamp fallback |
| 3 — Prod read-only | 4 | Charles and Joyce live doc shape; ingest log schema validity |

The 30-upload replay scenario (Part 2, test E) directly reproduces today's incident: a current fix is written, then 30 stale buffered points arrive in sequence. All 30 are rejected; the member row remains at the current location throughout.

---

## Deployment note

`captured_at` will be `None` on all existing member documents until each device sends its next location upload after this build is deployed. This is expected and handled. The first upload populates the field; the guard activates from that point forward.

Pre-Build-60 ingest log entries will have `write_accepted: null`, `incoming_captured_at: null`, and `rejection_reason: null`. Entries created after deploy will carry all four fields.
