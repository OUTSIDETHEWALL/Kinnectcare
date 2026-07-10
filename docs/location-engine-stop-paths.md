# Transistor Location Engine — Stop, Pause, and Restart-Failure Paths

**Document type:** Engineering investigation report  
**Status:** Pre-change-control — evidence mapping only, no code recommendations  
**Scope:** `frontend/src/locationEngine.ts`, `frontend/app/_layout.tsx`, `frontend/src/leonidas/patrol.ts`, `frontend/src/leonidas/healthChecks.ts`, `frontend/src/locationRefresh.ts`  
**Evidence source:** Code analysis + live database observation (July 9, 2026)

---

## System topology

Before cataloguing failure paths, it is important to understand the two parallel upload systems. They share the same backend endpoint but are mechanically independent.

```
                         ┌──────────────────────────────────────┐
                         │         _layout.tsx (RootNav)        │
                         │                                       │
                         │  user?.id effect (line 809)          │
                         │  ├─ starts locationEngine            │
                         │  └─ starts Leonidas patrol           │
                         │                                       │
                         │  AppState 'active' effect (line 651) │
                         │  └─ refreshLocationIfStale()         │
                         └──────────────────────────────────────┘
                                   /                  \
              ┌────────────────────┐      ┌───────────────────────────┐
              │  TRANSISTOR SDK    │      │  EXPO-LOCATION PATH       │
              │  (locationEngine)  │      │  (locationRefresh.ts)     │
              │                    │      │                           │
              │  • Native service  │      │  • JS-only                │
              │  • Survives app    │      │  • Fires on foreground    │
              │    kill (stopOn    │      │    transitions only       │
              │    Terminate:false)│      │  • Throttled 30 s         │
              │  • Heartbeat every │      │  • Uses expo-location     │
              │    60 s            │      │    getCurrentPosition     │
              │  • Headless task   │      │  • Unaffected by          │
              │    for frozen JS   │      │    Transistor state       │
              └────────────────────┘      └───────────────────────────┘
                         |                            |
                         └────────────┬───────────────┘
                                      ▼
                         PUT /api/members/{id}/location
                         (same endpoint, idempotent latest-wins)
```

**Key invariant:** The two paths are independent. Transistor stopping does not stop the expo-location foreground path, and vice versa. But the expo-location path only fires when the app is foregrounded.

---

## Upload triggers enumerated

| # | Trigger | Path | Fires when backgrounded? |
|---|---------|------|--------------------------|
| 1 | Transistor `onLocation` event | Transistor native | Yes — if motion detected |
| 2 | Transistor heartbeat → headless task | Transistor headless JS | Yes — if OS doesn't throttle |
| 3 | Transistor heartbeat → JS `onHeartbeat` | Transistor JS | Only while JS alive |
| 4 | `refreshLocationIfStale()` on `AppState 'active'` | expo-location | **No** |
| 5 | Leonidas `requestFreshLocation()` recovery | Transistor JS | **No** (Leonidas is foreground-only) |

---

## Stop / pause / restart-failure paths

### PATH 1 — Explicit stop on sign-out

**Source:** `_layout.tsx:814–820`

```typescript
if (!user?.id) {
  if (engineBootedForUserIdRef.current !== null) {
    try { leonidas.stop(); } catch (_e) {}
    await locationEngine.stop();         // ← explicit stop
    engineBootedForUserIdRef.current = null;
  }
  return;
}
```

**Trigger conditions:**
- `user?.id` becomes falsy in the `useEffect([user?.id])` dependency
- Happens on: explicit sign-out; `AuthContext` clearing the user due to a 401 on `/auth/me`; any React reconciliation that sets user to null between renders (rare but possible during token rotation if `AuthContext` briefly transitions through null)

**What stops:** Both the Transistor engine and the Leonidas patrol. Engine stop is clean — `locationEngine.stop()` calls `lib.stop()` which tears down the native foreground service.

**What starts it again:** The same effect re-runs when `user?.id` becomes truthy again. Start then proceeds through the full boot sequence: member-row lookup → JWT fetch → `locationEngine.start()` → `leonidas.start()`.

**Distinguishing evidence in production:**

| Log source | Event to look for |
|---|---|
| Engine log (`@kinnship/location_engine_log_v1`) | `stop_invoked` immediately followed by `stop_ok` |
| Engine log | Absence of `start_invoked` for an extended period after `stop_ok` |
| Leonidas recovery log | `patrol-stopped` |
| Ingest log (MongoDB) | Gap in `location_ingest_log` entries starting from the stop timestamp |

**Risk level:** Low — this is correct behaviour. It only becomes a problem if the sign-out is triggered spuriously (e.g., by a 401 on a non-critical endpoint).

---

### PATH 2 — Engine never restarts: member row not linked to user

**Source:** `_layout.tsx:840–850`

```typescript
const arr = await memberStore.fetchAll();
if (cancelled) return;
const me = (arr || []).find((m: any) => m.user_id === user.id);
if (!me) {
  try { leonidas.stop(); } catch (_e) {}
  await locationEngine.stop();
  engineBootedForUserIdRef.current = null;
  return;
}
```

**Trigger conditions:**
- `/members` returns a list where no entry has `user_id === current user.id`
- Causes: (a) user is a caregiver with no member row of their own — expected, not a bug; (b) user was removed and re-added and the new member row does not yet have `user_id` populated; (c) user joined via invite and the `user_id` linkage write on the backend failed or was not yet committed when this effect ran

**This is the primary remove/re-add failure mode.** A member row created by a caregiver via "Add Member" has no `user_id` until the invited user accepts and the backend writes `user_id` to that row. If the Transistor engine effect runs before that linkage is complete, it stops the engine and marks `engineBootedForUserIdRef.current = null`. On the next re-run of the effect (which is gated on `user?.id` changing), if `user.id` hasn't changed, the idempotency guard at line 833 is NOT in play (because `engineBootedForUserIdRef.current` was set to `null`), so the member lookup runs again — but if the linkage still isn't in the database, the engine stays stopped indefinitely.

**Distinguishing evidence in production:**

| Log source | Event to look for |
|---|---|
| Engine log | `stop_ok` not followed by `start_invoked` within the same session |
| Engine log | `start_invoked` with `memberId: null` or absent |
| MongoDB `members` | Member row for the user exists but `user_id` field is null or absent |
| MongoDB `members` | Member row count > 1 for the same phone (duplicate from remove/re-add) |
| Ingest log | Zero entries from `writer_user_id` matching the user's id after the join date |

**Clarification on re-run timing:** The auth effect is keyed to `user?.id`. Without a change in `user.id` — including no sign-out/sign-in — the effect does not re-run and the member lookup is not retried. If the user signs out and back in, the lookup re-runs and the engine starts if the member row is now linked. Short of sign-out, the only other trigger is a full app restart (kills the JS process; on next cold-start the effect runs fresh with `engineBootedForUserIdRef.current = null`).

---

### PATH 3 — Engine never starts: missing JWT or backend URL

**Source:** `_layout.tsx:852–857`

```typescript
const jwt = await getCurrentToken();
const backendBaseUrl = process.env.EXPO_PUBLIC_BACKEND_URL || '';
if (!jwt || !backendBaseUrl) {
  return;   // ← silent bail, no diagnostic log written here
}
```

**Trigger conditions:**
- `getCurrentToken()` returns null: Keychain has no stored token (post-logout, or Keychain wiped by OS on certain Android devices during app update), OR the token-store promise rejects
- `process.env.EXPO_PUBLIC_BACKEND_URL` is empty: wrong EAS build profile, missing variable in `eas.json`, or a development build that accidentally ran with a production env stub

**Silent failure mode:** This `return` fires BEFORE `locationEngine.start()` is called. The engine log will show no `start_invoked` event for this session, even though the user is authenticated and the member row is found. There is no log entry for this bail path.

**Distinguishing evidence in production:**

| Log source | Event to look for |
|---|---|
| Engine log | `ready_ok` or `setConfig_ok` from a prior session, then no `start_invoked` in the current session |
| Engine log | `app_launched` with no subsequent `start_invoked` |
| Token store | Query `getCurrentToken()` from diagnostics; returns null |
| App config | `process.env.EXPO_PUBLIC_BACKEND_URL` visible in the Diagnostics screen env dump |

**Note:** This path is invisible in the engine log because the bail happens before `locationEngine.start()` is called. The only evidence is the *absence* of `start_invoked`.

---

### PATH 4 — `ready()` or `setConfig()` failure

**Source:** `locationEngine.ts:521–541`

```typescript
try {
  if (isReady) {
    await lib.setConfig(config);
    await logEvent('setConfig_ok');
  } else {
    const state = await lib.ready(config);
    isReady = true;
    await logEvent('ready_ok', { ... });
  }
} catch (e: any) {
  await logEvent('ready_or_setConfig_error', { error: ... });
  return;   // ← does not proceed to start()
}
```

**Trigger conditions:**
- The Transistor native module throws during initialization
- SDK internal SQLite corruption (the SDK persists state to a local SQLite database)
- `ready()` called with an invalid configuration object
- Native module not yet fully loaded (race condition on fast cold-start)

**Distinguishing evidence in production:**

| Log source | Event to look for |
|---|---|
| Engine log | `ready_or_setConfig_error` with `error` field |
| Engine log | `start_invoked` present but no `ready_ok` or `setConfig_ok` |

---

### PATH 5 — Permission WHEN_IN_USE: foreground-only tracking

**Source:** `locationEngine.ts:557–577`; config comment at lines 545–550

```typescript
const status = await lib.requestPermission();
await logEvent('requestPermission_ok', {
  status,
  label: status === 3 ? 'ALWAYS'
       : status === 2 ? 'WHEN_IN_USE (foreground only)'
       : ...
});
// execution continues to start() regardless of status
```

**Trigger conditions:**
- User grants "Allow only while using the app" instead of "Allow all the time" on Android 10+
- Permission was downgraded in OS Settings after initial grant
- `requestPermission()` prompt was dismissed or the system auto-denied it

**Behaviour when active:** `lib.start()` succeeds and `started_ok` is logged. The native foreground service starts and the notification appears. While the app is foregrounded, `sdk_onLocation` events fire normally. The moment the app backgrounds and the phone goes stationary, no heartbeat reaches the native service — because background execution requires `ACCESS_BACKGROUND_LOCATION`, which was not granted.

This is mechanically identical to having the engine stopped when the phone is not in the user's hand. The notification is visible but does nothing.

**Distinguishing evidence in production:**

| Log source | Event to look for |
|---|---|
| Engine log | `requestPermission_ok` with `status: 2` |
| Engine log | `sdk_onHeartbeat` and `sdk_onLocation` events stop immediately after `app_backgrounded` |
| Engine log | `sdk_onHttp` entries only correlate with `app_foregrounded` events |
| Ingest log | All successful writes cluster within minutes of Joyce opening the app |

**This pattern is consistent with Joyce's live data.** The 8 ingest log entries observed July 9 at 23:39–23:46 UTC all occurred during an active foreground session. The prior 44-hour gap had zero entries despite the notification being visible.

---

### PATH 6 — Android Stationary Mode (by design)

**Source:** `locationEngine.ts` build comments, lines 30–36; config `stopTimeout: 5` at line 432

**Mechanism:** The Transistor SDK uses Android's Activity Recognition API to detect whether the device is moving. After `stopTimeout: 5` minutes of inactivity, the SDK transitions to "stationary mode" and stops requesting GPS fixes. This is the SDK's battery-optimisation design: no movement = no fixes needed.

In stationary mode, the only upload path through Transistor is the heartbeat cycle:
1. Native service fires a heartbeat every `heartbeatInterval: 60` seconds
2. If JS is alive → `onHeartbeat` callback calls `getCurrentPosition({ samples: 1, persist: true })`
3. If JS is frozen → headless task fires and calls the same `getCurrentPosition()`

**This is not a bug.** Stationary mode is correct behaviour. The system is designed so that heartbeats keep the location fresh. The defect only manifests if the heartbeat delivery is also interrupted (see Path 7).

**Distinguishing evidence in production:**

| Log source | Event to look for |
|---|---|
| Engine log | `sdk_onMotionChange` with `isMoving: false` |
| Engine log | `sdk_onHeartbeat` events occurring every ~60 s after `isMoving: false` |
| Engine log | `heartbeat_getCurrentPosition_ok` following each heartbeat |
| Engine log | `sdk_onHttp` events with 60 s cadence while app is backgrounded |

If heartbeats are firing but `sdk_onHttp` is absent, the GPS acquisition step is failing (permission issue, hardware unavailable). If heartbeats themselves are absent after backgrounding, see Path 7.

---

### PATH 7 — Android App Standby Bucket throttles the headless task

**Source:** Android OS behaviour; no code can prevent this

**Mechanism:** Android assigns every app to an App Standby Bucket based on recency and frequency of user interaction:

| Bucket | Condition | Background execution |
|---|---|---|
| Active | App in foreground | Unrestricted |
| Working Set | Used within past 24 h | Minor restriction |
| Frequent | Used within past week | Moderate restriction |
| Rare | Used within past month | Jobs deferred hours |
| Restricted (Android 11+) | Not used in weeks | Almost no background execution |

When an app is in the Rare or Restricted bucket, Android throttles heartbeat delivery to the headless task. The native Transistor foreground service continues running (the notification remains visible), but the OS-level job scheduler defers the heartbeat callback. The headless JS task never fires. No `getCurrentPosition()` is called. The ingest log goes silent.

**This is the most probable explanation for Joyce's 44-hour gap.** The sequence:
1. Joyce joined July 8, 00:39 UTC. First 2.5 hours had uploads every few minutes (onboarding + active use → Active bucket).
2. Joyce stopped using the app. Android moved it toward Frequent/Rare over hours.
3. At 03:17 UTC July 8, the last heartbeat-driven upload fired. After that, the bucket throttle deferred heartbeats to intervals longer than the monitoring window.
4. At 23:39 UTC July 9 (~44 h later), Joyce opened the app. Android moved it back to Active. The foreground `refreshLocationIfStale` fired immediately. The Transistor engine also processed a new location. Eight uploads arrived in 7 minutes.

**What the notification proves vs. does not prove:**  
The foreground service notification (`"Kinnship is sharing your location"`) is displayed by the Android notification system based on the service's running state. A service can run continuously with its notification visible while the OS defers its scheduled callbacks. The notification proves the native service has not been killed. It does not prove heartbeats are being delivered to JavaScript.

**Distinguishing evidence in production:**

| Log source | Event to look for |
|---|---|
| Engine log (Joyce's device) | `app_backgrounded` followed by zero `sdk_onHeartbeat` for hours |
| Engine log | `sdk_onHeartbeat` events resume the moment `app_foregrounded` is logged |
| Ingest log (MongoDB) | Gap duration correlates with lack of app opens on Joyce's device |
| Engine log | `registerHeadlessTask_ok` present (confirms registration succeeded) but headless events never log (because they run in a separate JS context that writes to a different buffer) |

**Important note on headless task diagnostics:** The headless task runs in a separate Android JS context with no access to AsyncStorage (per the comment at `locationEngine.ts:100–108`). The `logEvent('registerHeadlessTask_ok')` entry only confirms the registration was accepted. There is no log entry for individual headless task invocations unless `logEvent` is called from within the headless task itself — and it cannot be, because AsyncStorage is unavailable in that context. **Headless task invocations are therefore invisible in the existing diagnostic log.**

---

### PATH 8 — Leonidas patrol stops on background (by design)

**Source:** `patrol.ts:295–311`

```typescript
const handleAppState = (next: AppStateStatus) => {
  if (next === 'active') {
    if (!patrolTimer) {
      patrolTimer = setInterval(() => { void runOnePatrol()... }, PATROL_INTERVAL_SECONDS * 1000);
      void runOnePatrol()...
    }
  } else if (next === 'background' || next === 'inactive') {
    if (patrolTimer) {
      clearInterval(patrolTimer);
      patrolTimer = null;       // ← patrol suspended while backgrounded
    }
  }
};
```

**Mechanism:** When the app transitions to background, `clearInterval(patrolTimer)` fires. Leonidas does not run while the app is backgrounded. The comment at line 292–294 explains this is intentional: "Pause patrol while backgrounded to keep battery cost zero in that state — the engine's own headless task handles in-background work."

**Implication:** Every recovery action — `request-fresh-location`, `restart-engine`, `restart-engine+request-fresh-location` — can only fire while the app is foregrounded. If the phone is stationary, backgrounded, and the headless heartbeat is throttled, **no recovery mechanism fires**. There is no watchdog covering this combination.

**Distinguishing evidence in production:**

| Log source | Event to look for |
|---|---|
| Leonidas recovery log | `patrol-stopped` immediately after `app_backgrounded` in engine log |
| Leonidas recovery log | `patrol-started` immediately after `app_foregrounded` |
| Leonidas recovery log | No `patrol-tick` or `recovery-invoked` events during a background gap |

---

### PATH 9 — Leonidas restart-engine: stop without restart (critical defect)

**Source:** `patrol.ts:203–223` (action dispatch) and `_layout.tsx:833` (idempotency guard)

**Trigger conditions:**  
`classifyHealth` returns `restart-engine` when:
- `engine_available` is false → `engine-not-available`
- `engine_enabled` is false → `engine-not-enabled`

`classifyHealth` returns `restart-engine+request-fresh-location` when:
- `engine_is_moving === true` AND `last_upload_age_ms >= 10 * 60 * 1000` (10 minutes) → `moving-critical-10m+`

**What Leonidas does:**

```typescript
// patrol.ts:203–223
if (verdict.action === 'restart-engine' || verdict.action === 'restart-engine+request-fresh-location') {
  await locationEngine.stop();          // ← stops the engine
  await logRecovery('engine-restart-succeeded', verdict.state, {
    note: 'stop completed; restart deferred to next auth lifecycle',
  });
  // No call to locationEngine.start() — config not available here
}
```

**What the idempotency guard does:**

```typescript
// _layout.tsx:833
if (engineBootedForUserIdRef.current === user.id) {
  return;   // ← no-op; start() is never called
}
```

**The defect in full:** After Leonidas calls `locationEngine.stop()`:
1. `engineBootedForUserIdRef.current` is still set to `user.id` (it is only cleared on sign-out at line 819 or on unlinked-member at line 849)
2. The auth effect's `useEffect([user?.id])` does not re-trigger because `user.id` has not changed
3. Even if it did re-trigger, the idempotency guard at line 833 would short-circuit before calling `start()`
4. On the next patrol tick, Leonidas sees `engine_enabled: false` → classifies `engine-not-enabled` → calls `locationEngine.stop()` again (no-op on an already-stopped engine) → logs `engine-restart-succeeded` again
5. This loop continues indefinitely until the user signs out or the JS process is killed

**The misleading log entry:** `engine-restart-succeeded` is logged when `stop()` completes, not when the engine is actually running again. The `note` field clarifies this, but the event name implies success.

**Additionally:** The `logRecovery` event name `'engine-restart-succeeded'` is defined as a valid `LeonidasEventType` in `types.ts:121` but describes only the stop completing, not the restart succeeding. This naming mismatch will complicate post-mortem analysis.

**Distinguishing evidence in production:**

| Log source | Event to look for |
|---|---|
| Leonidas recovery log | `engine-restart-succeeded` with `note: 'stop completed; restart deferred to next auth lifecycle'` |
| Leonidas recovery log | Subsequent `patrol-tick` entries with `health_state: 'critical'` and `reason: 'engine-not-enabled'` |
| Engine log | `stop_ok` followed by no subsequent `started_ok` |
| Ingest log | Permanent gap from the Leonidas stop timestamp onward |

**Recovery conditions (precise):** The engine stays stopped for the lifetime of the current JS process. Recovery happens when the JS process is killed and the app restarts cold (the ref resets to `null`, so the auth effect runs the full boot sequence on next launch), OR when `user.id` genuinely changes (sign-out → sign-in with any user). A foreground/background transition or token rotation does not recover it because neither changes `user.id`.

---

### PATH 10 — JWT expiry: engine running but uploads failing with 401

**Source:** `locationEngine.ts:634–669` (`setAuthToken`); `buildSdkConfig` at line 478–481

**Mechanism:** The Transistor native HTTP transport uses the JWT configured in `authorization.accessToken`. When the JWT expires, every PUT returns 401. The SDK has no built-in refresh mechanism configured (`refreshUrl` is not set in `buildSdkConfig`). The SDK queues the failed upload in its SQLite store and retries with the same expired token. The queue fills toward `maxRecordsToPersist: 10000`. Old records are evicted. No location reaches the backend.

The `setAuthToken()` function is called via a token-change subscription set up at `_layout.tsx:870–874`. If the token refresh pipeline (`subscribeToTokenChanges`) is working, a new JWT is propagated before the old one expires. If it fails (network error, refresh token expired, AuthContext bug), the engine continues with a stale JWT.

**Diagnostic field added in Build 53:** `setAuthToken_ok` events include `jwt_exp_ms`, `minutes_until_expiry`, and `already_expired`. This is the primary evidence.

**Distinguishing evidence in production:**

| Log source | Event to look for |
|---|---|
| Engine log | `sdk_onHttp` with `success: false, status: 401` |
| Engine log | `setAuthToken_ok` with `already_expired: true` |
| Engine log | `setAuthToken_ok` with `minutes_until_expiry` less than 0 |
| Engine log | `sdk_onHeartbeat` → `heartbeat_getCurrentPosition_ok` → `sdk_onHttp` with `success: false` |
| Ingest log | Persistent gap despite heartbeat events being logged |

---

### PATH 11 — `isReady` module flag: `setConfig()` called on un-initialized native module

**Source:** `locationEngine.ts:282–283`, `521–527`

```typescript
let isReady = false;   // module-level, resets on JS process death
...
if (isReady) {
  await lib.setConfig(config);  // assumes ready() already ran
} else {
  const state = await lib.ready(config);
  isReady = true;
}
```

**Trigger conditions:**  
`isReady` is a JavaScript module-level variable. It is `false` on cold start and set to `true` after the first successful `ready()` call. It persists for the lifetime of the JS process. Within a single JS process lifetime, subsequent calls to `locationEngine.start()` (e.g., after a token rotation that changes `user.id`) use `setConfig()` not `ready()` — correct behaviour.

The defect would only manifest if the native Transistor module is torn down and re-initialized while the JS process remains alive (`isReady` stays `true`, so `setConfig()` is called instead of `ready()`, which may fail or silently not start the engine). This scenario is rare on Android — native module teardown typically kills the JS process too.

**Distinguishing evidence in production:**

| Log source | Event to look for |
|---|---|
| Engine log | `setConfig_ok` logged without a preceding `ready_ok` in the same session |
| Engine log | `setConfig_ok` followed by no `started_ok` |

---

### PATH 12 — Engine marked as booted despite silent start failure

**Source:** `_layout.tsx:858–867` and `locationEngine.ts:579–591`

**Mechanism:** `locationEngine.start()` never throws. It catches every internal failure and logs it, then returns normally:

```typescript
// locationEngine.ts:579–591
try {
  const state = await lib.start();
  await logEvent('started_ok', { ... });
} catch (e: any) {
  await logEvent('start_error', { ... });
  // ← no re-throw; function returns void
}
```

The layout code that calls `start()` treats the absence of an exception as confirmation that the engine is running:

```typescript
// _layout.tsx:858–867
await locationEngine.start({
  backendBaseUrl,
  memberId: me.id,
  jwt,
});
try { leonidas.start(); } catch (_e) {}
engineBootedForUserIdRef.current = user.id;  // ← always reached
```

Because `engineBootedForUserIdRef.current` is set to `user.id` unconditionally, the idempotency guard at line 833 will prevent any further boot attempt for this session — even if the underlying SDK never started. Leonidas also starts and begins classifying health, but its first patrol will immediately find `engine_enabled: false`, classify `engine-not-enabled` (critical), and invoke the `restart-engine` action — which leads directly into Path 9's stop-without-restart loop.

**Trigger conditions:**
- `ready()` succeeds but `lib.start()` throws (SDK returns an error after initialization)
- Native module enters a bad state between `ready()` and `start()` — e.g., OS kills the foreground service slot between the two calls
- `start()` returns a state with `enabled: false` (possible SDK behaviour on some Android versions when the foreground service slot is already occupied by another app)

**Consequence:** The engine is believed by the JS layer to be running. Leonidas starts patrolling. On the first patrol, `engine_enabled: false` → `restart-engine` → `locationEngine.stop()` (no-op since it never started) → still disabled → loop. The upload path is permanently broken for this JS process lifetime.

**Distinguishing evidence in production:**

| Log source | Event to look for |
|---|---|
| Engine log | `start_invoked` → `ready_ok` or `setConfig_ok` → `start_error` |
| Engine log | `started_ok` with `enabled: false` |
| Leonidas recovery log | `patrol-tick` with `engine_enabled: false` starting from the first patrol |
| Leonidas recovery log | Immediate `engine-restart-attempted` on the first patrol cycle |
| Ingest log | Zero entries from the start of the session despite `started_ok` being logged |

---

## Summary table

| # | Path | Trigger | Engine state after | Recovers automatically? | Primary log evidence |
|---|------|---------|-------------------|------------------------|---------------------|
| 1 | Explicit stop on sign-out | `user?.id` → null | Stopped | Yes, on re-login | `stop_ok` in engine log |
| 2 | Member row unlinked | `/members` has no `user_id` match | Stopped, stays stopped | No — requires DB fix | `stop_ok`, no `start_invoked` |
| 3 | JWT or URL missing at start | `getCurrentToken()` null or bad URL | Never starts | No — requires env fix | No `start_invoked` after login |
| 4 | `ready()`/`setConfig()` failure | SDK internal error | Not started/reconfigured | No — requires JS process kill | `ready_or_setConfig_error` |
| 5 | Permission WHEN_IN_USE | User grants foreground-only | Runs foreground only | No — requires OS permission change | `requestPermission_ok` status:2 |
| 6 | Stationary mode (by design) | No movement for >5 min | GPS suspended, heartbeat active | Yes — via heartbeat | `sdk_onMotionChange` isMoving:false |
| 7 | App Standby Bucket throttle | Days of app inactivity | Heartbeats throttled/stopped | Yes — on next foreground | Gaps in ingest log; no `sdk_onHeartbeat` while backgrounded |
| 8 | Leonidas patrol stops on background | App backgrounds | Patrol suspended | Yes — on next foreground | `patrol-stopped` in recovery log |
| 9 | Leonidas stop-without-restart | Upload stale >10 min while moving | Stopped, **stuck** until JS process kill or re-login | **No** — idempotency guard blocks restart within session | `engine-restart-succeeded` note + subsequent `engine-not-enabled` |
| 10 | JWT expiry / 401s | Token expires, refresh fails | Running but uploads rejected | Partial — depends on auth refresh | `sdk_onHttp` success:false status:401 |
| 11 | `isReady` flag on native reinit | Native module tears down mid-session | `setConfig()` fails silently | No — requires JS process kill | `setConfig_ok` without prior `ready_ok` |
| 12 | Boot-without-confirmation | `lib.start()` fails silently | Believed running, actually stopped | **No** — idempotency guard locks session into Path 9 loop | `start_error` + immediate `engine-not-enabled` patrols |

---

## Production-evidence decision tree

Use this to diagnose a specific gap in the ingest log without making code changes first.

```
STEP 1: Is the ingest log gap correlated with Joyce opening the app?
  YES → The Transistor engine is not the primary path; she only uploads on
        foreground (foreground refresh + Transistor foreground tracking).
        → Suspect PATH 7 (App Standby throttle) combined with PATH 5 (WHEN_IN_USE).
        → Check engine log: requestPermission_ok status field.
        → Check engine log: sdk_onHeartbeat events — present or absent?

  NO  → Engine may be completely stopped or permanently broken.
        Proceed to STEP 2.

STEP 2: Does the engine log show stop_ok without a subsequent started_ok?
  YES → Engine was stopped. Determine why:
        → If stop_ok follows a patrol entry with engine-restart-succeeded:
             PATH 9 — Leonidas stop-without-restart defect.
        → If stop_ok follows no engine log context:
             PATH 1 — sign-out triggered; check if user auth state was disrupted.
        Note: PATH 3 (missing JWT/URL) does NOT produce stop_ok — the bail
        happens before locationEngine.start() is ever called. Do not infer
        PATH 3 from stop_ok.

  NO  → Engine may never have started or may have booted but failed silently.
        Look for start_invoked:
        → start_invoked present, followed by start_error:
             SDK start() failed (PATH 4 variant — distinct from ready()/setConfig()
             failure; the engine log has both ready_or_setConfig_error AND
             start_error as separate event types).
        → start_invoked present, no ready_ok or setConfig_ok:
             PATH 4 — ready()/setConfig() error before start() could run.
        → start_invoked present, ready_ok and started_ok both present, but
          engine_enabled=false on next Leonidas patrol:
             PATH 12 — start() succeeded in JS but native engine did not activate.
        → start_invoked absent entirely after login:
             PATH 3 — JWT or URL missing (silent bail before start); confirm by
             checking if getCurrentToken() returns a value from the Diagnostics
             screen.
        → Neither start_invoked nor stop_ok present:
             PATH 2 — member row unlinked; fetchAll() found no user_id match.
             Check MongoDB members collection.

STEP 3: Does the engine log show sdk_onHeartbeat but no sdk_onHttp?
  → PATH 10 — JWT expired; the PUT is being rejected.
  → Check setAuthToken_ok events for already_expired: true.
  → OR: GPS acquisition failing inside getCurrentPosition; check
        heartbeat_getCurrentPosition_error events.

STEP 4: Does the engine log show no sdk_onHeartbeat after app_backgrounded?
  → PATH 5 — WHEN_IN_USE permission (most likely with PATH 7 confirming).
  → PATH 7 — App Standby throttle (confirm with gap duration and app-open history).
  → These two can coexist.
```

---

## Diagnostic data that does not currently exist

Three failure paths have incomplete or missing observability:

**1. Headless task invocations are invisible.**  
The headless task runs in a separate Android JS context with no AsyncStorage access. There is no log entry when the headless task fires or when `getCurrentPosition()` is called from it. The `registerHeadlessTask_ok` entry only confirms registration, not execution. This means Path 7 can only be diagnosed by the *absence* of heartbeat evidence — not by positive proof.

**2. App Standby Bucket is not logged.**  
The current codebase does not query or log Android's App Standby Bucket assignment. The bucket is readable via `android.app.usage.UsageStatsManager` from native code but is not accessible from JS. Knowing the bucket at the time of a gap would convert Path 7 from a deduction to a confirmed fact.

**3. Path 3 has no log entry.**  
When `_layout.tsx` bails at the `if (!jwt || !backendBaseUrl)` check (lines 854–857), no diagnostic event is written. The silence is indistinguishable from Path 3 without inspecting the token store directly.

---

*Report complete. No code changes are proposed or recommended in this document.*
