---
    name: Motion Timeline instrumentation
    description: Build 64 — onActivityChange listener + sdk_config_snapshot in locationEngine.ts; Motion Timeline section in diagnostics.tsx for motion root-cause investigation.
    ---

    ## Rule
    All future location diagnostic additions must log through `logEvent()` in locationEngine.ts and appear in the Motion Timeline via MOTION_EVENT_SET in diagnostics.tsx.

    ## What was added (Build 64)

    ### locationEngine.ts
    - `lib.onActivityChange` listener → logs `sdk_onActivityChange` with `{ activity, confidence, isMoving }`. Deduplicated via `_lastActivityType` / `_lastActivityIsMoving` module-level vars (only logs on type or isMoving change). Prevents ring-buffer flood at 10 s polling cadence.
    - `sdk_config_snapshot` entry → fires after `ready_ok`. Captures SDK's actual resolved config from `lib.getState()` including any persisted SQLite values that differ from what JS passed. Fields: distanceFilter, stationaryRadius, stopTimeout, heartbeatInterval, activityRecognitionInterval, minimumActivityRecognitionConfidence, locationUpdateInterval, fastestLocationUpdateInterval, motionTriggerDelay, disableStopDetection, elasticityMultiplier, preventSuspend, pausesLocationUpdatesAutomatically, autoSync, batchSync, maxBatchSize.

    ### diagnostics.tsx
    - `MOTION_EVENT_SET`, `formatMotionEvent()`, `fmtTime()` helpers above the component.
    - `motionEvents` / `lastActivityEvt` / `lastHeartbeatEvt` useMemos derived from engineLog.
    - `onCopyMotionTimeline` — copies ISO-timestamp plain text for side-by-side comparison.
    - Motion Timeline CollapsibleSection — before Engine section, default expanded, oldest-first.

    **Why:** Joyce's stationary→moving transition never fired during a shared 3-mile drive. onActivityChange was never subscribed to — zero visibility into whether Android Activity Recognition was delivering events to the SDK.

    ## Investigation protocol (next drive test)
    1. Both users clear engine log in Diagnostics
    2. Drive together 5+ minutes
    3. Both copy Motion Timeline → compare
    4. No sdk_onActivityChange on Joyce → Android suppressed the event (Doze / battery restriction)
    5. sdk_onActivityChange present but no sdk_onMotionChange → SDK rejected it (conf < threshold, or config mismatch in sdk_config_snapshot)
    6. sdk_onMotionChange present but sparse uploads → GPS acquisition failing post-transition

    ## OTA
    Build 64 published. Update group c4bdac5c-d1bc-4732-b2ad-74cded489102 (Android 019f70e4 / iOS 019f70e4).
    