# Joyce Pre-Drive Android Checklist
### For Samsung One UI — verify before every drive test

This checklist eliminates Android-configuration false positives from Kinnship drive tests.
If any item below is wrong, the ring buffer logs will look identical to a real software bug —
motion never detected, no GPS fix, no upload — because Android will have silently suppressed
the exact same pipeline stages. Run this list once before the drive; it takes ~4 minutes.

---

## Item 1 — Battery Exemption (Doze / App Standby)

**What it is:** Android "Doze" suspends network access and CPU wakes for apps that have been
idle for a while. App Standby goes further and throttles background processing between
usage sessions. A battery exemption puts Kinnship on the "unrestricted" list and prevents
both.

**Why it matters:** Even with the foreground service notification visible, Doze can delay
Activity Recognition callbacks by minutes or tens of minutes when the phone has been sitting
still for >15 minutes. This is indistinguishable in the logs from a bug in the SDK's
stationary-detection logic.

**Where to check (Samsung One UI):**
1. Settings → Battery → Battery usage
2. Tap the three-dot menu (⋮) in the top right → "Optimisation settings" or "Ignore optimisations"
3. Look for "Apps not optimised" or tap "All apps" in the dropdown
4. Search for **Kinnship**
5. It must say **"Not optimised"** (or "Unrestricted" depending on One UI version)

If it says "Optimising battery usage" or anything other than Not optimised:
- Tap Kinnship → "Don't optimise" → Done

**Ring buffer tells you if this was the problem:**

| What you see in Diagnostics | What it means |
|---|---|
| `sdk_onActivityChange` never fires across the whole drive | Doze suppressed Activity Recognition — this was the problem |
| `headless_task_invoked` fires every ~60 s but `motion_recovery_start` never fires | Headless heartbeat is alive but motionchange never delivered |
| `motion_recovery_start` fires within 30 s of Joyce starting the car | Battery exemption was fine; look elsewhere |

---

## Item 2 — Samsung Background Usage Limits (One UI second layer)

**What it is:** One UI adds a second kill layer on top of Android's standard Battery
Optimization. "Background usage limits" can terminate background apps even when they
appear in the "Not optimised" list. It also maintains a "Sleeping apps" list that aggressively
throttles anything Samsung deems inactive.

**Why it matters:** This is the most common silent killer on Samsung devices. The foreground
service notification stays visible, `started_ok` is in the ring buffer, but Activity
Recognition callbacks stop firing after 20–30 minutes of stillness.

**Where to check (Samsung One UI):**
1. Settings → Battery → Background usage limits
2. Confirm "Adaptive battery" is either **OFF**, or Kinnship is excluded
3. Tap "Sleeping apps" — Kinnship must **not** appear in this list
4. Tap "Deep sleeping apps" — Kinnship must **not** appear here either
5. Tap "Never sleeping apps" → Tap "+" and add Kinnship if it's not already there

**One UI 6+ alternate path:**
Settings → Device care → Battery → Background usage limits → Never sleeping apps

**Ring buffer correlation:**

| What you see | What it means |
|---|---|
| `started_ok` present, then silence (no `sdk_onActivityChange`, no `headless_task_invoked`) | Background Usage Limits killed the entire process, including the headless engine |
| `headless_task_invoked` fires but `sdk_onActivityChange` fires only once then stops | AR callbacks suppressed; foreground service alive but AR listener throttled |
| Both `headless_task_invoked` and `sdk_onActivityChange` fire normally | This layer is not the problem |

---

## Item 3 — Activity Recognition Permission

**What it is:** Android 10+ requires an explicit `ACTIVITY_RECOGNITION` permission for apps
to receive motion data from the Activity Recognition API. Without it the SDK receives zero
motion events — `sdk_onActivityChange` never fires. This is a **completely silent failure**:
no error log, no crash, just nothing.

**Where to check:**
1. Settings → Apps → Kinnship → Permissions
2. Find "Physical activity" (this is the ACTIVITY_RECOGNITION permission)
3. It must be set to **"Allow"**

If it says "Denied" or is missing from the list, tap it and grant it.

**Ring buffer correlation:**

| What you see | What it means |
|---|---|
| `sdk_onActivityChange` never appears in the log at all | Permission denied — this is the problem |
| `permission_requested` present but `sdk_onActivityChange` absent | Permission was revoked after the last grant |
| `sdk_onActivityChange` fires at least once (any activity type) | Permission is fine |
| `motion_recovery_start` fires and `sdk_onActivityChange` type is `'still'` throughout the drive | Permission is granted but AR is reading the wrong sensor — phone orientation issue, not a permission issue |

**Important:** The Transistor SDK requests this permission during `requestPermission()` at
engine start (`started_ok` entry in the ring buffer). However, the user can revoke it
between sessions without any notification to the app.

---

## Item 4 — Location Permission Accuracy (Precise vs Approximate)

**What it is:** Android 12+ lets users grant "Approximate location" instead of "Precise
location." Approximate location gives a ~3 km radius estimate, which is insufficient for
meaningful drive tracking. More critically, the Transistor SDK's motion detection relies on
GPS signal characteristics — approximate mode can suppress the GPS satellite acquisition
that triggers the stationary→moving transition.

**Where to check:**
1. Settings → Apps → Kinnship → Permissions → Location
2. Must be set to **"Allow all the time"** (not "Only while using")
3. Below the allow/deny option, look for **"Use precise location"** — this toggle must be **ON**

**Ring buffer correlation:**

| What you see | What it means |
|---|---|
| `gps_fix_received` has `accuracy` values > 1000 (metres) throughout the drive | Approximate mode — this is the problem |
| `gps_fix_received` has `accuracy` < 50 on a first fix in open sky | Precise GPS is working |
| `getCurrentPosition_start` fires but no `gps_fix_received` follows (timeout) | GPS acquisition failed — can be approximate mode or Doze |
| `headless_motionchange_getCurrentPosition_error` present | GPS timed out in the headless context — check both this item and Item 2 |

---

## Item 5 — Samsung Device Maintenance / Power Saving Mode

**What it is:** Samsung's "Device care" has its own power-saving modes separate from
Android's standard battery optimization. "Medium power saving" and "Maximum power saving"
both restrict background network access and can throttle or stop foreground services
not on Samsung's internal approved list.

**Where to check:**
1. Settings → Device care (or Battery and device care) → Battery
2. Power saving mode must be **OFF** for the drive test
3. Settings → Device care → Battery → Power saving → Adaptive power saving: **OFF** for the test

Also check:
- Pull down the notification shade → look for a "Power saving" tile — it must not be active (not highlighted)

**Ring buffer correlation:**

| What you see | What it means |
|---|---|
| `headless_task_invoked` fires but `headless_heartbeat_ok` fails with network error | Power saving mode is blocking the background GPS fix or battery PATCH request |
| `headless_battery_patch_error` with "network request failed" | Same — network access restricted |
| `http_upload_success` absent while `gps_fix_received` is present | GPS worked but network was blocked by power saving |

---

## Quick Confirmation Checklist (Joyce's version)

Before getting in the car, open Kinnship's **Diagnostics** screen and confirm:

- [ ] **Diagnostics shows "Engine: started"** — `started_ok` is the most recent engine event
- [ ] **Battery exemption**: Settings → Battery → Battery usage → Kinnship = "Not optimised"
- [ ] **Never sleeping**: Settings → Battery → Background usage limits → Never sleeping apps → Kinnship is listed
- [ ] **Physical activity permission**: Settings → Apps → Kinnship → Permissions → Physical activity = Allow
- [ ] **Location permission**: Settings → Apps → Kinnship → Permissions → Location = "Allow all the time" + Precise = ON
- [ ] **Power saving OFF**: Notification shade shows no active "Power saving" tile

Then: **clear the engine log** on the Diagnostics screen (so the post-drive log is clean),
start the engine by stepping into the car, and drive for at least 5 minutes.

---

## How to Read the Log After the Drive

Open Diagnostics → Engine Log. Look for this chain in order:

```
sdk_onActivityChange    ← AR delivered a motion event (Doze/permission OK)
motion_recovery_start   ← headless motionchange handler triggered upload
getCurrentPosition_start ← GPS acquisition requested
gps_fix_received        ← GPS lock obtained (accuracy < 100 m = good)
upload_queued           ← SDK queued the location for upload
[headless_http_ok or http_upload_success] ← upload reached the backend
```

**If the chain breaks at `sdk_onActivityChange` not appearing at all:**
→ Check Items 1, 2, and 3 (Doze, Samsung layer, AR permission)

**If `sdk_onActivityChange` appears but `motion_recovery_start` does not:**
→ The AR event was delivered but the motionchange event wasn't — check Item 2 (Samsung layer)
→ Alternatively the cooldown gate fired (normal if the test drove for <60 s after a previous move)

**If `motion_recovery_start` appears but `gps_fix_received` does not:**
→ GPS timed out — check Item 4 (precise location) and Item 5 (power saving blocking GPS)

**If `gps_fix_received` appears but no upload event follows:**
→ Network was blocked — check Item 5 (power saving) and confirm WiFi or mobile data is active

**If the full chain is present and `gps_fix_received` shows `accuracy` < 100:**
→ Android configuration is clean. Any delay seen on the dashboard is a software issue,
  not a device configuration issue, and the ring buffer timestamps will tell Charles exactly
  which pipeline stage was slow.

---

## Pipeline Timestamp Panel (Diagnostics screen)

The Diagnostics screen also shows "Pipeline Timestamps" — the wall-clock age of each stage's
last callback. After a 5-minute drive these should all be recent (< 5 minutes old):

| Timestamp label | Stage | Absent means |
|---|---|---|
| `activity` | `sdk_onActivityChange` | AR permission denied or Doze/Samsung suppression |
| `motion` | `onMotionChange` | SDK never transitioned stationary→moving |
| `headless_invoked` | HeadlessTask any event | Headless engine not registered or Samsung killed the process |
| `headless_heartbeat` | HeadlessTask GPS fix | GPS failed in headless context |
| `http_attempt` | Any HTTP attempt | Upload never tried |
| `http_success` | Confirmed 200/201 upload | Upload tried but failed (check network + power saving) |

If every timestamp is null after a 5-minute drive: start at Item 3 (AR permission) and work
down the list — all-null is the signature of a complete Android suppression at the
permission or process-kill layer.
