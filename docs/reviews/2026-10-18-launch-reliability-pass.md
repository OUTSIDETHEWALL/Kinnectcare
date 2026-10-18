# Build 70 post-road-test launch cleanup — October 18, 2026

## Verdict and scope

**RED for Google Play production. Narrow corrective source implemented and
regression-checked; the reported launch delay, notification-tap incident and
overnight stationary discrepancy are not physically closed.**

The reported multi-hour, caregiver-observed, unattended moving road test is a
PASS and the protected baseline. It is not being reclassified as a failure
because local diagnostic evidence is unavailable or old.

Build 70 source: `f736fac74fcaf1ee69b10a9cac46d02b97015f2c`, app 1.3.0 /
runtime 1.3.1. The investigated functional baseline is its parent
`552b88b0b0679c7aab072540e45a41dd86f4b4c0`; their only differences are release
metadata. This pass stays on `fix/post-road-test-correctives` / draft PR #167.
The PR records the final corrective commit rather than embedding a
self-referential commit ID here.

No merge, backend deployment, OTA, EAS release build, Play upload, production
configuration/data mutation, or physical-phone operation was performed. No
production queries or new phone diagnostic exports were collected.

## A. Startup

### Confirmed source defects and repairs

**High severity, high confidence in the source defects and local repairs;
unproven attribution to the complete observed 20–25 seconds.**

1. `AuthContext` awaited optional Play Install Referrer capture before even
   reading the saved session. A lost service callback costs its configured
   two-second deadline; delayed module loading/persistence can add work.
   Existing authenticated sessions now restore independently of attribution.
   The fresh-install guard still precedes token restoration. The no-token
   signup path still settles referrer capture, preserving invite behavior.
2. Dashboard `load()` awaited diagnostic log creation and “GET sent” persistence
   before issuing family requests; it also awaited raw-response/render logs
   and alert-cache persistence before completing first load. Slow diagnostic
   storage could therefore block useful authenticated UI without a bound.
   Ordered diagnostic persistence is now separate from fetching/rendering;
   alert state is committed before its optional cache write completes.
3. Delayed log persistence must not falsify timing or cross a session/load
   boundary. The new per-load trace snapshots timestamps when events occur,
   preserves write order and rechecks the active load/session before recording
   family data, including after logger initialization. A stale load's error
   also cannot replace the current load's state.

The `/auth/me` success milestone now precedes optional cache persistence so
it measures receipt/identity availability rather than a later storage write.
The existing API milestone allowlist now includes `/alerts`: that request
joins `/members` and `/summary` on the Family load path and was missing from
per-request startup timing.

No PIN, disclaimer, permission, ownership, consent, authentication retry or
tracker-readiness requirement was bypassed. Required family/safety requests
still complete before their safety data is presented. Billing and timezone
maintenance were already non-blocking in Build 70; they were not “fixed again.”

### Evidence-based timeline and measurement limits

There is no time-matched native startup export for the new 20–25-second
incident in this authorization. Consequently **there is no defensible physical
millisecond breakdown of that incident**. Do not substitute the web preview,
Jest timing or a timeout constant for a measured phone timeline.

Use these existing milestones from one launch/run:

| Interval | Evidence | Physical duration this pass |
|---|---|---|
| Application entry → generated application initialization complete | `native_application_on_create_started/completed` | Not supplied |
| Activity entry → activity initialization complete | `native_activity_on_create_started/completed` | Not supplied |
| Native initialization → root JS checkpoint | `js_runtime_initialized` | Not supplied; includes runtime/bundle/module work, not a precise VM-create marker |
| Auth restore → fresh-install guard → token/cache → usable identity | `auth_restore_started`, `fresh_install_guard_completed`, `token_read_completed`, `user_cache_read_completed`, `session_restored` or `auth_me_completed` | Not supplied |
| Required navigation gates → committed route | `startup_gates_pending_snapshot/cleared`, `root_navigation_evaluated`, `route_stable_750ms` | Not supplied; inspect `authLoading`, not route stability alone |
| Family requests and useful render | `api_request_started/completed/failed` with endpoint/duration, `dashboard_initial_load_started/completed`, `first_usable_family_render` | Not supplied |
| Location configuration, independently | `location_authorization_configuration_started/completed/failed` | Not supplied; not proof of GPS delivery |
| Focus/visibility | `native_activity_window_focus_changed`, app foreground/background events | Not supplied |

Native intervals use monotonic elapsed realtime within the native run; JS
intervals use their own run/sequence and recorded times. Do not subtract
unrelated run IDs or imply that concurrent work happened serially. A new
Activity can belong to an already-running native/JS process.

**Controlled regression evidence, not a phone timing claim:** the logger test
records load/send/receive/commit at 1000/1100/1200/1300 ms and releases storage
only at 20000 ms. Persisted event deltas remain 100/100/100 ms, not storage-drain
delays. Real AuthProvider tests release cached and network-authenticated
identity while attribution never settles. Real Dashboard tests issue requests
and update Needs Attention while diagnostic reads/writes never settle.

Expected improvement: remove the optional referrer wait from returning-session
startup and remove unbounded diagnostic/cache storage waits from first Family
load. **A 1–3-second or under-five-second physical result is not yet claimed.**
If the delay remains, the table locates native/runtime versus auth versus
individual network request versus navigation/UI work without random tuning.
Native synchronous durability checkpoints remain in place; their overhead,
React initialization and any native `ready()`/configuration delay still need
measurement if they dominate the exported timeline.

## B. Persistent notification tap

**High-severity observation; root cause and relation to startup unresolved.**

The configured persistent notification has a fixed ID and is sticky. The
installed Transistor native implementation inspected
(`tslocationmanager-4.2.2`, notification builder `com.transistorsoft.locationmanager.a.a0`)
obtains the package launch intent, attaches an activity PendingIntent and sets
it as notification content intent. It logs failure if a launch intent cannot
be found. It is not simply missing a content-intent implementation.

This code inspection is not a physical notification-tap test or proof that
Android delivered the intent on either phone. A warm background task and a
cold/recreated process can follow different launch paths. No speculative
PendingIntent/launch-flag or native lifecycle patch was applied.

The existing real-root permission/lifecycle and notification routing suites
passed, but do **not** prove OS-level persistent-notification taps in either
warm or recreated sessions. Those two device/native cases remain release gates.
An activity/focus/foreground milestone following a tap would establish launch
delivery even if UI then stalled; absence requires Android intent/activity
evidence, not assuming a shared root cause with startup.

## C. Stationary GPS discrepancy and Leonidas

**Potential Critical reliability incident; physical cause unresolved.**

Joyce's hourly behavior is explained by the existing shared native minimum-age
gate: stationary eligibility at 60 minutes, recent-moving fallback at
10 minutes. The 60-second heartbeat and nominal 30-minute background-fetch
job supply possible executions; they are not exact hourly alarms.
Both use guarded acquisition, authorization and explicit accepted-publication
verification. The source label “workmanager” names the background-fetch path;
the installed `forceAlarmManager:false` implementation uses JobScheduler.

The production native-policy harness now directly verifies:
- denial one millisecond before 60 minutes and admission at the threshold;
- successful stationary capture resetting eligibility through three cycles;
- an eleven-hour-old capture being eligible;
- the recent-moving ten-minute one-shot fallback;
- 5/15/30-minute failure backoff, alongside the prior configuration exclusion,
  process-incarnation recovery and confirmed-revocation tests.

Thus the **60-minute age rule alone does not explain Charles's eleven-hour
gap**. Recent battery/device contact proves neither a GPS execution opportunity
nor successful GPS-specific consent/owner/permission checks. Moving native
publication also does not prove that every stationary one-shot prerequisite
was satisfied.

Remaining distinguishable causes include absent/delayed OS wake-ups; absent
headless runtime/callback registration; authorization UNKNOWN; configuration or
acquisition ownership pending; repeated acquisition errors/backoff; and
publication rejection. None is established for the reported interval by source
or the supplied prose. Android scheduling is **not** being used as an assumed
excuse, and a Kinnship-specific failure is **not** ruled out.

Use a time-matched export to correlate `sdk_onHeartbeat`,
`headless_task_invoked` with heartbeat event name, background task start,
`gps_recovery_not_due`, `trackingReliability.state/records`,
`acquisition_attempt`, `acquisition_failed`, upload result and
`verified_coordinate_publication` source/capture time. Native GPS without an
accepted receipt differs from no acquisition. Existing ring/count limits mean
an export may lack the beginning of an overnight gap; absence in an evicted
log is not proof that no event occurred.

Leonidas and its conservative gates are unchanged. Its timer pauses in
background; it is not a second guaranteed background hourly alarm. A reported
8.3-second recovery and return to standing-guard are useful positive evidence,
not proof that every earlier recovery opportunity executed successfully.
No stationary threshold, motion interval, stop timeout or recovery policy was
changed to conceal the discrepancy.

## D. Diagnostics severity and wording

**Medium severity, high-confidence correction.**

- An old location-transport success timestamp no longer becomes a red failure
  simply because it is older than fifteen minutes. Old/absent confirmation is
  informational; a recent success proves that transport observation only.
- Shared health wording is now “Location upload last confirmed,” not a large
  user-facing “HTTP upload” failure. The Me indicator consumes the same selector.
- “Background GPS evidence unavailable” describes the retained diagnostic
  window instead of implying background operation has never passed testing.
- Retained repeated background proof is shown as “Background delivery recorded
  earlier” when it cannot establish current health. A single retained delivery
  is explicitly labeled as one delivery.
- Current disabled-service evidence can still be red. Heartbeat uncertainty
  remains yellow. Gray does not assert healthy GPS or active communication.
- Green overall health still requires recent, repeated, correlated background
  capture/publication evidence and current matching native owner/generation/
  consent state. Fresh contact, one-shot fixes, foreground captures, enabled
  state or an hours-old earlier success cannot synthesize that proof.

Deep diagnostics already separate device contact, battery timestamp, verified
capture, explicit one-shot/foreground acquisition, background delivery, native
state, heartbeat and motion. Those separate facts are not relabeled as each
other. The physical road-test PASS was not hard-coded as permanent green.

## E. Headless warnings and background battery timeout

### `HeadlessTaskManager failed to find task`

The installed SDK throws this when its completion lookup cannot find the
task. Native task-finish cleanup removes records; the JS SDK wrapper explicitly
requests completion and React Native also completes headless promises. A
completion-order race is possible. The geolocation headless deadline is two
minutes; expiry before a late completion is another possible route.

Classification must be conditional: completion cleanup after already-finished
work can be benign; reaching the deadline while intended acquisition or
publication never finishes is actionable. App code does not independently call
`finishHeadlessTask`. The warning alone does not prove duplicate app completion
or successful work. No SDK/native code was modified just to suppress warnings.
The supplied message has no matching warning/task timeline to classify those
particular occurrences conclusively.

### Battery task timeout

**High-confidence source defect corrected, phone occurrence attribution pending.**
The battery task awaited optional log persistence before starting independent
battery transport and again before native completion. A stuck diagnostic
read/write could therefore consume its work budget. Execution evidence is now
queued outside that budget with call-time timestamps. Normal completion may
precede storage persistence; timeout/replacement still discards obsolete logs.

GPS recovery can still be pending after battery transport succeeds. The
background-fetch adapter has its own 30-second RN headless budget; the OS
timeout callback is a separate signal. These are not the same as the
geolocation adapter's two-minute limit. This pass does not lengthen watchdogs
or finish the task early while GPS work is active.

Tests cover accepted battery delivery with never-returning GPS recovery,
timeout followed by late recovery, single completion, lack of owner proof, and
never-settling diagnostic storage. A task timeout is not retroactive failure
of an already-accepted battery upload, but missing intended GPS work remains
check-worthy. Independent device contact was not re-coupled to GPS.

## F. Verification and adversarial self-review

| Check | Result |
|---|---|
| Full frontend Jest | **899 passed, 1 failed; 78 passing suites, 1 failing suite** |
| TypeScript `npx tsc --noEmit` | PASS |
| Changed/new frontend lint | **0 errors, 52 warnings**; no suppressions added |
| Offline-safe backend suite | **567 passed, 5 skipped, 41 warnings**; 16 live-service modules excluded |
| Native policy contract | Production authority compiles; three JVM scenarios pass, including process recreation and new policy cases |
| Full Android release compile/bundle | Not rerun: **no production native code/dependency/plugin/config changes** |
| Public web preview | Workflow running, disclaimer renders; no fatal boot error |
| Signed-in/native rendered UI and physical timing/taps | **Not verified** |

The frontend failure is the pre-existing legacy-identifier repository audit in
historical medication fixtures, not a new failing functional test. It was not
suppressed or “fixed” by changing unrelated historical family data. Jest still
requires `--forceExit`; clean teardown is not claimed. The five backend skips
are live-API geocoding cases without a test session; no live service was used
to make an offline test pass. This is not a full live-backend suite PASS.

An initial local run exposed a test-only mocked-module enumeration issue,
an expected asynchronous-log timing assertion, and a simulated moving-clock
setup that placed the observation in the future. These harness issues were
corrected; no production gate or privacy expectation was relaxed.

Adversarial self-review (not independent review):
- No source diff in native tracking authority, Android acquisition, recovery
  authorization, location publication, member provenance, backend ingestion,
  Leonidas, motion configuration or notification launch implementation.
- Existing authorization, consent-generation, stale-session, foreground
  reopening, moving/native publication and independent battery tests passed.
- Queued raw-family diagnostics are discarded when their load/session expires.
- Returning-session optimization does not skip the fresh-install guard, token
  restoration, identity or required navigation gates.
- Old evidence cannot combine with one fresh capture to claim sustained
  current background health. Fresh battery/contact is not converted to GPS age.
- GPS work is not canceled merely to make a background task finish sooner.
- Optional persistence may now finish later or be unavailable; its absence is
  not silently converted into success.

Reproduction: `cd frontend && npx jest --runInBand --forceExit`, `npx tsc --noEmit`,
changed-file `npx eslint`, `python scripts/verify-backend-offline.py --local-only`,
and `bash frontend/scripts/verify-native-contract.sh`.

## G. Short physical validation plan — requires separate authorization

Do not operate either phone or release/install anything from this report.

After explicit approval of the corrective delivery:
1. Confirm native build/runtime and embedded/OTA identity. Time one warm
   launcher open and one warm persistent-notification tap to useful Family UI.
   Record whether the activity/focus event arrives promptly.
2. Separately test one ordinary cold/recreated launch and persistent-notification
   tap. Do not substitute Android Settings force-stop for ordinary process
   death. Aim for under five seconds; preserve the slower run's milestones.
3. Leave both phones stationary/backgrounded through at least two eligibility
   windows (about 2–2.5 hours), observing capture advancement from the caregiver
   side before reopening the tracked app. Check battery/contact separately.
   A recurrence of the overnight-only problem requires overnight endurance;
   a two-hour pass does not close that part.
4. Make a short moving → 7–10-minute parked → moving check. Confirm multiple
   changing captures are visible before reopening; reopening must not regress
   the coordinate tuple. Keep the accepted multi-hour road test as the baseline.
5. Collect one full diagnostic export per phone at the end, preserving the
   slower-launch/failed-tap time and any stale-GPS interval. Use it to attribute
   the winning callbacks and warning/timeout operations. Do not repeatedly
   foreground the tracked phone merely to collect observations.

## H. Release recommendation

**RED / production HOLD.** Remaining blockers: physical startup timing and any
remaining dominant delay; persistent-notification opening in warm/cold cases;
Charles's long stationary gap; warning/timeout attribution if associated work
is missing; and corrective-version physical regression acceptance.

This pass is **JS-only in production source**. It does not inherently require a
Build 71 native binary; it may be OTA-capable for the approved Build 70 runtime
1.3.1 after explicit release authorization and release-metadata verification.
No OTA was bundled/published and no new signed Android binary was produced.
If later intent/runtime investigation requires a native repair, that separate
change would require Build 71 and full release compile/bundle validation.
