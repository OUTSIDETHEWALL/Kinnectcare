# Kinnship Notification System Audit
**Date:** July 16, 2026  
**Status:** Investigation only — no code changes  
**Scope:** Complete end-to-end trace of every notification type

---

## 1. Architecture Overview

```
User action / scheduled tick
        │
        ▼
med_scheduler.py (15s tick)          server.py (per-request routes)
  STAGE_DUE  STAGE_FAMILY  STAGE_REFILL    /sos  /refresh  /detect_missed_checkins
        │           │             │           │       │              │
        └───────────┴─────────────┴───────────┴───────┴──────────────┘
                                  │
                    insert_one guard (unique index)
                                  │ success only
                                  ▼
                            push_to_user()
                            push_to_family_group()
                                  │
                                  ▼
                           expo_push.py
                    send_expo_push(tokens, title, body, data)
                    _collapse_id(data) → collapseId
                    is_data_only → omit top-level channelId (Build 63)
                                  │
                                  ▼
                         Expo Push API (api.expo.dev)
                                  │  ticket_id returned, not stored
                                  ▼
                    FCM (Android)  /  APNs (iOS)
                         collapse_key (from collapseId)
                                  │
                                  ▼
                        Android notification system
                          channel routing → importance
                                  │
              ┌───────────────────┼────────────────────┐
              ▼                   ▼                    ▼
         foreground           background            killed
    setNotificationHandler  ReceivedListener     OS renders directly
    ReceivedListener        rePresentSticky=NO   collapseId is only dedup
    rePresentSticky=YES
              │                   │                    │
              ▼                   ▼                    ▼
    dismiss original        stays as-is           tray entry (stable if collapseId)
    dismiss stableId            │
    schedule stableId     (foreground on         
    (sticky, action btns)  next app open →
                           rePresentSticky fires)
```

---

## 2. Android Notification Channels

| Channel ID | Importance | Sound | Vibration | Badge | Bypass DnD | Used by |
|---|---|---|---|---|---|---|
| `default` | MAX | ✅ | [0,350,250,350] | ✅ | ❌ | missed_checkin, misc |
| `meds_v2` | MAX | ✅ | [0,500,250,500,250,500] | ✅ | ❌ | medication due/family/refill |
| `routines` | HIGH | ✅ | [0,300,150,300] | ✅ | ❌ | routine/activity reminders |
| `sos` | MAX | ✅ | [0,800,300,800,300,800] | ✅ | ✅ | SOS only |
| `silent_v2` | MIN | ❌ | none | ❌ | ❌ | request_location_refresh |

**Note on channel creation:** `ensureNotificationChannel()` runs pre-auth on every app open. Channel settings are cached by Android on first creation; bumping the ID (`meds` → `meds_v2`, `silent` → `silent_v2`) is the only escape hatch. The legacy `meds` and `silent` channels are deleted at setup.

---

## 3. ID System — Every Identifier, Where It's Born, Where It Dies

### Backend collapseId (expo_push.py `_collapse_id()`)

| Event | collapseId value | FCM maps to | APNs maps to |
|---|---|---|---|
| medication due | `med_<reminder_id>_due` | `collapse_key` | `apns-collapse-id` |
| medication family | `med_<reminder_id>_family` | `collapse_key` | `apns-collapse-id` |
| medication refill | `med_<reminder_id>_refill` | `collapse_key` | `apns-collapse-id` |
| SOS | `sos_<alert_id>` | `collapse_key` | `apns-collapse-id` |
| missed_checkin | `miss_<member_id>` | `collapse_key` | `apns-collapse-id` |
| routine/activity | **None** | — | — |
| location refresh | **None** | — | — |

### Frontend stableNotificationId (push.ts `stableNotificationId()`)

| Event | stableNotificationId | Used as Android notification ID |
|---|---|---|
| medication due | `med_<reminder_id>_due` | ✅ via scheduleNotificationAsync identifier |
| medication family | `med_<reminder_id>_family` | ✅ |
| medication refill | `med_<reminder_id>_refill` | ✅ |
| routine/activity | `rt_<reminder_id>_due` | ✅ |
| SOS | `sos_<alert_id>` | ✅ |
| missed_checkin | `miss_<member_id>` | ✅ |

**Key observation:** backend collapseId and frontend stableNotificationId use the same scheme for medication/SOS/missed_checkin. They are independent dedup layers operating at different points in the pipeline:
- `collapseId` → OS-level dedup (FCM replaces before delivery if key matches)
- `stableNotificationId` → tray-level dedup (JS replaces after delivery via scheduleNotificationAsync with a fixed identifier)

For routine reminders: stableId exists on the frontend (`rt_<rid>_due`) but no corresponding backend collapseId. See §7 gap analysis.

### Other IDs

| ID | Born at | Used for | Destroyed |
|---|---|---|---|
| `reminder_id` | MongoDB `db.reminders` insert | Links push → reminder | Never (permanent) |
| `alert_id` | MongoDB `db.alerts` insert | Links push → alert record (SOS, missed_checkin) | Never |
| `member_id` | MongoDB `db.users` | collapseId for missed_checkin | Never |
| `slot_key` | med_scheduler.py at STAGE_DUE | `med_notifications` unique guard | Never |
| `slot_key` (check-in) | `interval_<iso>` or `fixed_<date>_<time>` | `alerts` unique guard | Never |
| Expo ticket ID | Expo Push API response | Should be used for receipt check | **Not stored or checked** ← gap |
| FCM message ID | FCM delivery | Correlation | **Never captured** ← gap |

---

## 4. Notification Lifecycle — Every Type

### 4.1 Medication Due

```
User creates reminder
  → db.reminders { category: "medication", slot_times: [...], member_id }

med_scheduler.py ticks every 15s
  → query db.reminders where delta_min in [0, 10]
  → for each: _try_record_stage(reminder_id, slot_time, local_date, stage="due")
      → db.med_notifications.insert_one(...)
      → unique index: (reminder_id, slot_time, local_date, stage)
      → DuplicateKeyError → return False (skip push)
      → Success → return True (proceed)
  → push_to_user(owner_id, title="💊 Medication time", body="...", data={
        type: "medication", stage: "due", reminder_id, member_id,
        channelId: "meds_v2", categoryIdentifier: "medication_due"
    })
  → expo_push.py:
      collapseId = "med_<reminder_id>_due"
      is_data_only = False → channelId: "meds_v2" included
      → POST Expo Push API

FCM → Android → meds_v2 channel (IMPORTANCE_MAX)

Frontend:
  Foreground:
    setNotificationHandler → log notification
    ReceivedListener → rePresentSticky("medication")
      → dismiss original FCM notification (by FCM identifier)
      → dismiss stableId "med_<rid>_due" (prior sticky if any)
      → scheduleNotificationAsync({ identifier: "med_<rid>_due",
          content: { ..., sticky: true, categoryIdentifier: "medication_due" },
          trigger: { channelId: "meds_v2" }
        })
    → 1 tray entry: "med_<rid>_due" (sticky, action buttons visible)

  Background (alive):
    setNotificationHandler → suppressed (no banner shown from handler)
    ReceivedListener → rePresentSticky skipped (AppState !== 'active')
    → 1 tray entry: as FCM delivered (random OS-assigned Android notif ID)
    → collapseId: "med_<rid>_due" deduplicates at FCM level

  Killed:
    OS renders notification directly → meds_v2 channel
    → 1 tray entry (FCM-assigned ID, but collapseId used by FCM to replace)

User actions:
  TOOK_IT button → response listener → POST /reminders/:id/mark → dismissNotificationAsync("med_<rid>_due")
  Body tap → deep-link to reminder detail screen
  Swipe dismiss → BLOCKED (sticky: true on Android prevents swipe)
```

**Expected count:** 1 tray entry at all times while unacknowledged. 0 after TOOK_IT.  
**Idempotency:** Mathematically guaranteed once per slot per day (unique index).  
**Scheduler window:** 0–10 min post slot time. 15s tick = up to 40 `_try_record_stage` calls, only first succeeds.

---

### 4.2 Medication Family Alert

```
med_scheduler.py STAGE_FAMILY:
  → triggers if delta_min in [15, 75] AND db.medication_logs has no "taken" entry
  → _try_record_stage(reminder_id, slot_time, local_date, stage="family_alert")
      → same unique index as above (stage differs → separate row)
  → push_to_family_group(family_id, title="💊 [Name] hasn't taken medication",
        data={ type: "medication", stage: "family_alert", reminder_id, member_id,
               channelId: "meds_v2" })
  → One push per family member (including the member themselves? — see assumption §9)

collapseId = "med_<reminder_id>_family"
stableId   = "med_<reminder_id>_family"
```

**Expected count:** 1 tray entry per family member while unresolved.  
**Dismiss path:** Family member opens app → no explicit dismiss trigger found in the response listener for family_alert type specifically. The family notification persists until the family member interacts with it or dismisses manually.  
**Open question (not a bug, may be intentional):** Does the family notification on family members' devices get cleared when the member finally takes the medication? Current code does not send a dismiss-push to family members' devices when TOOK_IT is pressed. The family notification stays in the tray indefinitely.

---

### 4.3 Medication Refill

```
med_scheduler.py STAGE_REFILL:
  → triggers when days_until_runout <= lead_days
  → _try_record_stage written to db.refill_notifications (separate collection)
  → push_to_user(owner_id, data={ type: "medication", stage: "refill", reminder_id,
        channelId: "meds_v2" })

collapseId = "med_<reminder_id>_refill"
stableId   = "med_<reminder_id>_refill"
```

**Expected count:** 1.  
**Open question:** The dedup collection is `refill_notifications`, separate from `med_notifications`. The unique index key there needs to include a date component to prevent the same reminder from firing only once ever (vs. once per depletion cycle). Not verified in this audit.

---

### 4.4 Routine / Activity Reminder (Walk, Exercise, etc.)

```
med_scheduler.py STAGE_DUE (same code path as medication):
  → category="routine" follows identical path
  → _try_record_stage same unique index (reminder_id, slot_time, local_date, stage="due")
  → push_to_user(owner_id, data={ type: "routine", reminder_id, member_id,
        channelId: "routines" })

expo_push.py:
  collapseId = None   ← routines not in _collapse_id()
  channelId  = "routines" (IMPORTANCE_HIGH)

Frontend rePresentSticky:
  stableId = "rt_<reminder_id>_due"
  Same dismiss → re-schedule logic as medication
```

**Expected count:** 1.  
**Idempotency:** Same unique index as medication — guaranteed once per slot.  
**Gap (see §7.2):** No backend `collapseId` for routines. Killed-state dedup relies entirely on the frontend stableId, which only fires when JS is alive. If the push arrives when JS is dead (killed / aggressive Samsung background kill), it lands with a random Android notification ID. No OS-level replacement occurs if a second push somehow arrives. In practice, the unique index prevents a second push from being sent, so this gap only matters if FCM retries a failed delivery — theoretically the same FCM message ID would be used for retries, making it moot. **No confirmed bug; noted as missing defense-in-depth.**

---

### 4.5 Missed Check-in

```
server.py detect_missed_checkins():
  Modes:
    Interval: slot_key = "interval_<last_due_utc_iso_no_microseconds>"
    Fixed:    slot_key = "fixed_<date>_<fixed_time>"
  → db.alerts.insert_one({ slot_key, member_id, type: "missed_checkin", ... })
      → DuplicateKeyError → skip push
  → push_to_family_group(family_id, title="⚠️ [Name] missed check-in",
        data={ type: "missed_checkin", alert_id, member_id, channelId: "default" })

expo_push.py:
  collapseId = "miss_<member_id>"
  channelId  = "default" (IMPORTANCE_MAX)

Frontend:
  stableId   = "miss_<member_id>"
  rePresentSticky: amber sticky notification with action

_layout.tsx routing:
  notification tap → /missed-checkin/<member_id>

missed-checkin/[id].tsx:
  "I've checked on them" CTA → POST /alerts/:id/resolve → dismissNotificationAsync("miss_<member_id>")
```

**Expected count:** 1 per family member per slot. 0 after "I've checked on them".  
**Idempotency:** Guaranteed by unique index on slot_key in `db.alerts`.  
**collapseId design note:** `miss_<member_id>` means two different missed check-in events for the same member (different slots) will replace each other at the OS level. This is intentional — only the latest missed check-in matters; stacking multiple from the same person is noise.

---

### 4.6 SOS

```
POST /api/sos (user-initiated):
  → db.alerts.insert_one({ type: "sos", alert_id, ... })
  → push_to_family_group(family_id, title="🆘 SOS from [Name]",
        data={ type: "sos", alert_id, channelId: "sos" })
  → One push per family member × all registered tokens for that member

expo_push.py:
  collapseId = "sos_<alert_id>"
  channelId  = "sos" (IMPORTANCE_MAX, bypassDnd=true)

Frontend:
  stableId = "sos_<alert_id>"
  rePresentSticky: red sticky notification
  Response listener body tap: deep-link to SOS detail
```

**Expected count:** 1 per family member (persistent until resolved).  
**Idempotency:** insert_one on `db.alerts` before push. **Not verified whether a unique index exists on (user_id, alert_id) or similar — if the SOS endpoint is called twice in rapid succession before the first insert completes, two inserts could succeed.** This is a potential race at the HTTP layer.  
**bypassDnd:** SOS is the only type configured to bypass Do Not Disturb.

---

### 4.7 Silent Location Refresh (request_location_refresh)

```
POST /api/request-location-refresh (user taps member's location card):
  → in-memory 30s throttle per member_id (_REFRESH_TRACE_LOG)
  → No DB write
  → push_to_user(target_member_id, title="", body="",
        data={ type: "request_location_refresh", channelId: "silent_v2",
               _contentAvailable: True, ... })

expo_push.py (Build 63):
  is_data_only = True (title="" and body="")
  → channelId OMITTED from top-level Expo message
  → FCM receives: pure data message, no notification block
  collapseId = None

FCM → Android:
  Pure data message → no notification block → no tray entry rendered
  (pre-Build 63: channelId="silent_v2" in top-level → Expo attached
   android.channel_id → Samsung OEM rendered blank "K" status-bar icon)

Frontend:
  Foreground / background (alive):
    addNotificationReceivedListener:
      type === "request_location_refresh" OR channelId === "silent_v2"
      → refreshLocationIfStale('pull-request')
      → dismissNotificationAsync(notification.request.identifier)
      (dismiss is belt-and-suspenders; with Build 63 there's nothing to dismiss)

  Killed (Build 63+):
    FCM wakes the app's background task (if configured)
    No tray entry created regardless of JS state
    No dismiss needed
```

**Expected count:** 0 visible notifications (data-only).  
**Idempotency:** 30-second in-memory throttle only. Server restart resets the throttle. No persistent guard.

---

### 4.8 Battery Alerts

**Not implemented.** No scheduler, no push, no DB collection. Not a gap unless this feature was promised; flagging for awareness.

---

### 4.9 Diagnostic / Internal Notifications

No push notifications are sent for diagnostics. All diagnostic data is stored in AsyncStorage ring buffers on-device:
- `@kinnship/notification_log_v1` — last 20 received notifications (JS-alive only)
- Engine log, auth log, route log, push log, etc. — all on-device, not pushed

---

## 5. Every Expo Notification API Call — Where, When, Whether It Can Run Twice

| API | Location | When | Can run twice? | Notes |
|---|---|---|---|---|
| `scheduleNotificationAsync` | `rePresentSticky` (push.ts ~L621) | Foreground push received (AppState=active, <30s old) | Yes for different notifications, but same stableId → OS replaces, not duplicates | Awaited after two sequential dismisses |
| `scheduleNotificationAsync` | SNOOZE_10 response listener (push.ts ~L929) | User taps Snooze action | Once per tap | Schedules in 600s on meds_v2 channel |
| `dismissNotificationAsync` | `rePresentSticky` ~L612 | Before re-presenting | Yes — idempotent | Dismiss original FCM delivery |
| `dismissNotificationAsync` | `rePresentSticky` ~L618 | Before re-presenting | Yes — idempotent | Dismiss prior stableId entry |
| `dismissNotificationAsync` | ReceivedListener ~L896 | request_location_refresh arrives | Yes — idempotent | Belt-and-suspenders since Build 63 |
| `dismissNotificationAsync` | Response listener ~L919 | TOOK_IT or DONE action | Once per tap | Dismisses stableId |
| `dismissNotificationAsync` | Response listener ~L943 | SNOOZE_10 action | Once per tap | Dismisses current before rescheduling |
| `cancelAllScheduledNotificationsAsync` | `setupNotificationsForOS` (startup pre-auth) | Every cold start | Once per start | **Wipes all pending scheduled notifications including active snooze timers** |

---

## 6. rePresentSticky / stableNotificationId / collapseId — Interaction Audit

### Can two different logical events replace each other?

| Scenario | Result |
|---|---|
| Member misses check-in twice (different slots) | `miss_<member_id>` is the same both times → second replaces first at OS level. **By design.** |
| Same medication fires at 8 AM and 8 PM | Different slot_time → unique index → two separate DB rows → `med_<rid>_due` collapseId is the same → **FCM replaces old with new at delivery.** Only one tray entry at a time. Intentional. |
| Two different members miss check-in simultaneously | `miss_<member_id_A>` and `miss_<member_id_B>` → different IDs → stack independently. Correct. |
| SOS fires while missed_checkin is in tray | Different stableIds → stack independently. Correct. |

### Can one logical event appear twice?

**Foreground path — no.** Dismiss (original) + dismiss (stableId) + schedule (stableId) are three sequential awaits. The window between the first dismiss completing and the schedule completing is sub-millisecond; in practice no user would see a double entry.

**Background path — no for medication/SOS/missed_checkin.** collapseId prevents OS-level duplication. 

**Background path — theoretically yes for routine reminders** (no collapseId). The unique index prevents the backend from sending twice, so this would require an FCM delivery retry of the same message after initial failure. In that case FCM uses the same message ID for retries, so it's moot. **No confirmed duplication vector; noted as missing defense-in-depth.**

### Can dismiss happen before replacement?

No. The rePresentSticky sequence is:
1. `await dismissNotificationAsync(original)` — removes FCM-delivered entry
2. `await dismissNotificationAsync(stableId)` — removes prior sticky if any
3. `await scheduleNotificationAsync({ identifier: stableId })` — adds new sticky

This is sequential and correct. The brief window between step 1 and step 3 means the tray is momentarily empty (sub-second). This is observable if the user is watching the notification shade at exactly the right moment but is not a bug.

### Can replacement leave a ghost entry?

Only if `scheduleNotificationAsync` at step 3 throws. It is wrapped in a try/catch that swallows the error. If it throws (e.g., device low memory, channel not yet initialized), the notification is dismissed but not re-presented — the push is **silently lost**.

### Can Android retain an orphan notification?

Yes, in one scenario: the app is killed immediately after step 1 (dismiss original) completes but before step 3 (schedule stableId) runs. The FCM notification is gone, the new sticky is never scheduled, and the push is lost with no user-visible indication.

---

## 7. Backend Scheduler Audit

### 7.1 Medication (Due, Family, Refill)

| Property | Value |
|---|---|
| Function | `process_pending_notifications` (med_scheduler.py L212) |
| Tick frequency | 15 seconds |
| Decision | delta_min in [0,10] (due), [15,75] (family), days_until_runout <= lead (refill) |
| Document write | `insert_one` to `db.med_notifications` / `db.refill_notifications` BEFORE push |
| Unique index | `(reminder_id, slot_time, local_date, stage)` |
| Retry | None. If push fails, the stage is already recorded. Push will not be re-attempted. |
| Idempotency | **Mathematically guaranteed.** DuplicateKeyError on every tick after the first. |
| Maximum duplicate sends | **1** (one push ever per reminder × slot × date × stage) |

### 7.2 Routine / Activity

Same as 7.1. Category="routine" follows the identical code path with `stage="due"`. No family escalation. Same idempotency guarantee.

**Gap:** `_collapse_id()` in expo_push.py handles `medication`, `sos`, `missed_checkin` but not `routine`. Routine pushes have no `collapseId` in the FCM message. The frontend stableId (`rt_<rid>_due`) provides dedup when JS is alive, but there is no OS-level safety net.

### 7.3 Missed Check-in

| Property | Value |
|---|---|
| Function | `detect_missed_checkins` (server.py L764) |
| Trigger | External tick (interval depends on scheduler configuration) |
| Document write | `insert_one` to `db.alerts` with `slot_key` BEFORE push |
| Unique index | On `slot_key` |
| Retry | None. |
| Idempotency | **Guaranteed.** DuplicateKeyError on second call for same slot. |
| Maximum duplicate sends | **1** |

### 7.4 SOS

| Property | Value |
|---|---|
| Function | `trigger_sos` (server.py L3271) |
| Trigger | User HTTP request (POST /api/sos) |
| Document write | `insert_one` to `db.alerts` BEFORE push |
| Unique index | **Not confirmed by audit.** If two rapid HTTP calls arrive before either insert completes, two records could be inserted. |
| Maximum duplicate sends | **Potentially 2** if SOS endpoint called twice concurrently without a unique index on the SOS alert record. |

### 7.5 Location Refresh

| Property | Value |
|---|---|
| Function | `request_location_refresh` (server.py L3552) |
| Trigger | User HTTP request (POST) |
| Document write | **None.** |
| Throttle | In-memory per member_id, 30-second cooldown (`_REFRESH_TRACE_LOG`) |
| Idempotency | **NOT guaranteed** across server restarts. Memory throttle resets on deploy. |
| Maximum duplicate sends | Unbounded if called rapidly from multiple clients or immediately after server restart. |

---

## 8. Expo Push API Audit — Observability

```
send_expo_push(tokens, title, body, data):
  POST https://exp.host/--/api/v2/push/send
  → Response: [ { status: "ok", id: "<ticket_id>" }
                  OR { status: "error", details: {...} } ]
  
  Ticket IDs are:
    - Collected from the response ✅
    - Logged to server output ✅
    - NOT stored to MongoDB ❌
    - NOT checked against the receipt endpoint later ❌

  Dead tokens:
    - Detected via status="error" / details.error="DeviceNotRegistered" ✅
    - Pruned from db.push_tokens ✅
    - Only detected at send time, not receipt time ⚠️

  Receipt endpoint (https://exp.host/--/api/v2/push/getReceipts):
    - NOT called anywhere in the codebase ❌
    - This is where actual FCM/APNs delivery confirmation lives
```

### Observability gaps at the Expo layer

| What we cannot see | Impact |
|---|---|
| Whether FCM actually delivered the push | A push can succeed at Expo and fail at FCM silently |
| FCM message ID | Cannot correlate a specific tray entry with a specific send event |
| APNs delivery status | Same gap on iOS |
| Expo ticket receipts | Tickets are collected once but never checked. A ticket with `status: "error"` in the receipt means FCM/APNs rejected the message — we never know |
| Delivery timing | Cannot distinguish "push sent at 8:00 AM" from "push delivered at 8:47 AM" (Doze delay) |

---

## 9. Android State Audit

| State | setNotificationHandler | ReceivedListener | rePresentSticky | collapseId effective | stableId effective |
|---|---|---|---|---|---|
| Foreground | ✅ | ✅ | ✅ | ✅ (FCM-level, before arrive) | ✅ (replaces via identifier) |
| Background (alive) | ❌ (no banner from handler) | ✅ | ❌ skipped | ✅ | ❌ (stableId never scheduled) |
| Killed (normal) | ❌ | ❌ | ❌ | ✅ | ❌ |
| Killed (Samsung App Power Mgmt, 30-60 min) | ❌ | ❌ | ❌ | ✅ | ❌ |
| Force stopped (user cleared) | ❌ | ❌ | ❌ | FCM may not deliver at all | ❌ |
| Doze mode | ❌ | ❌ | ❌ | ✅ (delivered on Doze exit) | ❌ |
| Battery saver (Android native) | ❌ | ❌ | ❌ | ✅ (may delay) | ❌ |

**What changes per state:**

**Foreground:** Full pipeline. `setNotificationHandler` determines whether a banner is shown (for `request_location_refresh` it suppresses sound/badge; for all others it enables MAX priority). `rePresentSticky` fires and replaces the ephemeral FCM delivery with a persistent, sticky, action-button-equipped entry.

**Background (alive):** `setNotificationHandler` is registered but the banner is controlled by the handler's return value — for location refresh it returns `shouldShowAlert: false`. For everything else, `shouldShowAlert: true` with MAX priority. `rePresentSticky` is explicitly gated out (`AppState !== 'active'`). The notification stays as FCM delivered it (no sticky, no action buttons in expanded view from rePresentSticky — though the channel and FCM payload still provide the registered category action buttons). The push still lands in the tray.

**Killed / Samsung aggressive kill:** OS renders directly. Channel determines importance. `collapseId` (`collapse_key`) is the only dedup mechanism. Location refresh (Build 63): no notification rendered at all. For medication/SOS/missed_checkin: tray entry appears, no action button enforcement from rePresentSticky, but FCM category action buttons may still appear depending on OS version. On next foreground entry, if a new push for the same event arrives, rePresentSticky fires and restores the sticky presentation.

**Force stopped:** FCM generally refuses to deliver to force-stopped apps on Samsung/Xiaomi. This is an OS-level block. **No notification will arrive even at HIGH importance.** This is outside app control.

**Doze:** FCM `priority: "high"` (used for all visible notifications) is supposed to exempt messages from Doze. In practice, Samsung One UI and MIUI apply additional power management on top of Android Doze that can delay high-priority FCM by 5–30 minutes. This is the suspected cause of Bug A (medication timing delay, not yet confirmed).

**Samsung One UI specifics:**
- App Power Management (`Restricted` mode): kills background processes after ~30-60 min. JS runtime dies. Dismiss callbacks never fire.
- `silent_v2` channel at IMPORTANCE_MIN: renders a status-bar icon ("K") even with empty title/body **if top-level `channelId` is present** — fixed in Build 63 by omitting top-level `channelId` for data-only pushes.
- Battery optimization applied per-app. User must manually set Kinnship to `Unrestricted` to guarantee background delivery.

---

## 10. Silent Push Audit (request_location_refresh)

### Before Build 63

```
Backend sent:
  { to: token, priority: "normal", channelId: "silent_v2", 
    title: "", body: "", data: { type: "request_location_refresh", channelId: "silent_v2" } }
                                   ↑
              Top-level channelId caused Expo to attach android.channel_id to FCM payload.
              FCM treated message as notification-capable.
              Samsung OEM rendered status-bar "K" icon when JS was dead.
              JS dismiss path never fired (no JS runtime).
              Icon accumulated in tray.
```

### After Build 63

```
Backend sends:
  { to: token, priority: "normal",
    data: { type: "request_location_refresh", channelId: "silent_v2" } }
                                   ↑
              No top-level channelId → Expo cannot construct android.channel_id.
              FCM sends pure data message with no notification block.
              No OEM can render a tray entry. No status-bar icon.
              FCM wakes the app background task with the data payload.
              JS refresh still executes (if background task is alive).
              No dismiss needed.
```

### Whether a better architecture exists

The current architecture (silent FCM push to trigger location pull) is correct for a safety app. Alternatives:
- **Polling from the frontend:** Less responsive (depends on app-open events), worse battery.
- **WebSocket keepalive:** Requires persistent connection; Samsung/Xiaomi kill it in background.
- **WorkManager (Android) scheduled task:** Not accessible from React Native / Expo without a native module; BackgroundGeolocation SDK already covers this.

The Build 63 fix closes the OEM icon gap. The remaining open question is whether the background task executes after Samsung kills JS. BackgroundGeolocation SDK has its own native task manager that runs independently of the JS runtime — so GPS should still upload even when JS is dead. The location refresh push is a "pull harder right now" signal, not the primary GPS upload mechanism.

---

## 11. Activity Reminder / Walk Duplication Audit

**Backend verdict:** Idempotent. The unique index on `(reminder_id, slot_time, local_date, stage)` means exactly one push is ever sent per Walk reminder per slot per day. `_try_record_stage` is called up to 40 times (every 15s over 10 min) and succeeds exactly once.

**Possible causes for "multiple Walk notifications" Charles observed:**

1. **Two registered devices (most likely):** If the user has two Android devices with active tokens, `push_to_user` fans out to all registered tokens. Each device gets one push → two tray entries across two devices, or two tray entries on one device if both tokens belong to the same physical device (e.g., after reinstall without token cleanup).

2. **rePresentSticky + original both briefly visible:** In foreground, rePresentSticky fires. Between `dismiss(original)` completing and `schedule(stableId)` completing, there is a ~1–5ms window where neither exists. Before Build 50 (which introduced the foreground-only gate), rePresentSticky also fired in background, causing dismiss+reschedule while the tray was visible → user saw the notification disappear and reappear (not duplication, but confusing).

3. **Token accumulation:** If token dedup logic on registration doesn't clean up old tokens, a user might have 3-4 tokens from prior installs. Each gets a push. The backend sends to all, the OS routes to the single physical device multiple times under different notification IDs. The collapseId prevents FCM from deduplicating these because they're separate messages to separate tokens, not the same message. **A user with N stale tokens gets N tray entries.**

4. **Snooze + next slot overlap:** If the user snoozed a medication/routine and the next scheduled slot fires before the snooze notification displays, both could appear simultaneously — though the stableId means the 10-min snooze would be replaced by the next real slot's rePresentSticky.

**Most probable cause for the Walk duplication:** stale token accumulation (cause 3). The collapseId (which would fix this) is absent for routine reminders — this is the exact gap documented in §7.2.

---

## 12. Duplication Paths — Complete Map

| Path | Type | Protected by | Confirmed safe? |
|---|---|---|---|
| Same medication slot fires twice from scheduler | Backend | Unique index on med_notifications | ✅ Yes |
| Same activity slot fires twice from scheduler | Backend | Unique index on med_notifications | ✅ Yes |
| Same missed check-in slot fires twice | Backend | Unique index on alerts (slot_key) | ✅ Yes |
| SOS endpoint called twice concurrently | Backend | insert_one on alerts (unique index not confirmed) | ⚠️ Unconfirmed |
| Location refresh called twice within 30s | Backend | In-memory throttle | ⚠️ Resets on server restart |
| Location refresh called twice after server restart | Backend | Nothing | ❌ Duplicate push possible |
| Foreground: FCM notification + rePresentSticky both visible | Frontend | Sequential await chain | ✅ Sub-second window only |
| Background: two pushes for same event | Frontend | collapseId (med/SOS/checkin) | ✅ for these types |
| Background: two routine pushes | Frontend | Backend unique index prevents 2nd push | ✅ In practice (no collapseId safety net) |
| Killed state: stale tokens produce N tray entries | Both | Nothing — collapseId only works per token | ❌ N pushes for N tokens |
| Snooze notification wiped by app restart | Frontend | Nothing | ❌ Snooze lost on force-restart |

---

## 13. Race Conditions

| Race | Location | Status |
|---|---|---|
| rePresentSticky dismiss vs. schedule | push.ts L612–621 | ✅ Resolved — sequential awaits |
| Cold-start deep-link vs. auth gate | _layout.tsx + push.ts | ✅ Resolved — pendingDeepLinkData queue + consumedNotificationIds |
| Background rePresentSticky dismissing notification before user sees it | push.ts | ✅ Resolved — gated to AppState=active |
| cancelAllScheduledNotificationsAsync wiping snooze timer | setupNotificationsForOS | ❌ Not resolved — snooze is lost on cold start |
| SOS double-send from concurrent HTTP requests | server.py | ⚠️ Unconfirmed — depends on whether db.alerts has a unique index for SOS |
| rePresentSticky scheduleNotificationAsync throws silently | push.ts ~L635 | ⚠️ Push silently lost; no retry, no user feedback |

---

## 14. Observability Gaps — Complete List

| Gap | Where | Impact |
|---|---|---|
| Expo receipt endpoint never called | expo_push.py | Cannot confirm FCM/APNs delivery. A push can be "sent" and never arrive. |
| FCM message ID not captured | expo_push.py | Cannot correlate a tray entry with a specific backend send event |
| Expo ticket IDs not persisted | expo_push.py | Ticket IDs are returned but logged only; lost after log rotation |
| Notification log only captures JS-alive arrivals | notificationLog.ts | Any notification that arrives while JS is dead is invisible to the log |
| Notification log capped at 20 entries (ring buffer) | notificationLog.ts | High-traffic periods rotate out evidence |
| Location refresh has no DB trace | server.py | Refresh history is lost on server restart; impossible to correlate post-hoc |
| No per-token delivery tracking | expo_push.py | Cannot determine which device/token actually received a push |
| Android Doze delivery delay invisible | — | Push sent at T+0, delivered at T+45 min; backend has no visibility |
| Background task execution after Samsung kill invisible | — | Cannot confirm GPS upload happened after JS death |
| Silent notification arrival when JS dead | push.ts | NotificationLog captures nothing; tray entry invisible until Build 63 fix |

---

## 15. Assumptions — Every Assumption in the System

| Assumption | Where assumed | Risk if wrong |
|---|---|---|
| FCM delivers high-priority pushes promptly on all Android devices | server.py, med_scheduler.py | Medication reminders arrive late (Bug A, unconfirmed) |
| JS runtime stays alive in background for 30-60 min on Samsung | push.ts | Location refresh dismiss never fires, rePresentSticky never fires |
| User has exactly one registered device / token set | push_to_user | Stale tokens → N tray entries per push |
| collapseId replaces across tokens | expo_push.py | It does NOT — FCM collapse_key operates per-token, not per-device-owner |
| cancelAllScheduledNotificationsAsync at startup has no user-visible cost | setupNotificationsForOS | Wipes active snooze timers on force-restart |
| Family members want to see family_alert even after member takes medication | med_scheduler.py | Family notification never proactively dismissed after TOOK_IT |
| In-memory throttle is sufficient for location refresh | server.py | Server restart → throttle reset → burst of refreshes possible |
| `routines` channel IMPORTANCE_HIGH is sufficient for user to see activity reminders | ensureNotificationChannel | Lower than medication (MAX) — may not produce heads-up on some OEMs |
| `bypassDnd` on sos channel reliably bypasses DnD | ensureNotificationChannel | Some Android 14 OEMs ignore bypassDnd for non-phone-call notifications |

---

## 16. Remaining Reliability Concerns (ranked)

| # | Concern | Severity | Confirmed? |
|---|---|---|---|
| 1 | **Medication delivery delayed by Samsung/Doze** (Bug A) | Critical — safety app | Suspected, unconfirmed |
| 2 | **Stale token accumulation causes N tray entries per push** | High | Pattern identified; not confirmed with user data |
| 3 | **SOS idempotency unconfirmed** — no verified unique index preventing double-alert | High | Not verified in audit |
| 4 | **Snooze notification wiped on cold start** — cancelAllScheduledNotificationsAsync runs pre-auth | Medium | Confirmed in code |
| 5 | **Expo receipts never checked** — silent FCM delivery failures invisible | Medium | Confirmed in code |
| 6 | **rePresentSticky silently swallows scheduleNotificationAsync failure** | Medium | Confirmed in code |
| 7 | **Location refresh throttle resets on server restart** | Low-Medium | Confirmed in code |
| 8 | **Family alert never proactively dismissed after TOOK_IT** | Low-Medium | Confirmed in code (may be intentional) |
| 9 | **routine reminders missing backend collapseId** | Low | Confirmed; mitigated by backend idempotency |
| 10 | **Force-stopped apps receive no FCM on Samsung/Xiaomi** | Low (user action required to force-stop) | OS behavior, outside app control |
