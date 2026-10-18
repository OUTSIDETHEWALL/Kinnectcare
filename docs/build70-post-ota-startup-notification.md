# Build 70 post-OTA startup and notification corrective pass

## Scope / disposition

Source baseline: merged `23f32f3c10ff899edec5192d3d050e6b2e1147c1`,
Android OTA `01a150dd-f657-715b-93e5-62689530bb58`, runtime `1.3.1`.
The user confirmed that OTA active, then measured approximately **12 seconds**
and **10 seconds** to usable Family. These are observed totals, not individual
milestone durations. The externally observed intermediate screen has not been
identified from a supplied video or route trace.

This corrective branch changes JavaScript/TypeScript and tests only, plus this
report and an audit-memory rule. No merge, Railway deployment, OTA publication,
new native build, Play submission, production configuration/data mutation or
phone operation is authorized or performed.

## Confirmed defects and confidence

1. **High — Family data has an unnecessary all-screen network barrier.**
   `Dashboard.load` awaited `Promise.all(/members, /summary, /alerts)`, including
   an alerts request whose failure was intentionally non-fatal. Store publication
   and the initial spinner release both occurred *after* that combined barrier.
   A healthy members response therefore could not render Family while either
   other request was pending. High confidence in the source defect; **not proof**
   that this interval accounted for a particular physical 10–12 second launch.
2. **Medium — Welcome can paint after authenticated gates settle.** RootNav
   returns its initial Stack before its redirect effect commits the authenticated
   Family route. The index route unconditionally rendered signup/sign-in controls
   and emitted `welcome_render_committed`. Returning authenticated identity could
   therefore see that route for an intervening committed frame. High confidence
   in this source path, but the externally recorded flash could instead be an
   Android starting-window snapshot or another route. Its identity is unproven.
3. **Medium — notification body misstates its action.** “Tap to pause” describes
   an action that the delivered SDK body PendingIntent does not implement.
   High confidence, verified against the existing Build 70 artifact.
4. **Medium — delayed alert-cache restoration can overwrite a fresh response.**
   The cache read had neither an effect-cancellation guard nor a guard against
   an already accepted network result. Fixed while preserving background loading
   and last-known alerts. Tested with cache completion after fresh alerts.

## Startup timeline: known, unknown and measured correctly

No post-OTA native/startup diagnostic export accompanied this request. The
exact per-device milestone timeline and **dominant physical interval remain
unmeasured**. Do not manufacture a timeline from the two total stop-watch times
or substitute local web/Jest timings for Android measurements.

| Boundary | Existing evidence / candidate observation |
| --- | --- |
| Process / Application initialization | Native `native_application_on_create_started` and `...completed`, elapsed realtime and wall clock |
| Activity entry / window focus | Native Activity create started/completed and window-focus records; a reused warm Activity need not emit create again |
| Earliest app JS before headless/UI dependency evaluation | New `js_entry_started`, using the recorder already in Build 70; old `js_runtime_initialized` occurs in the root layout **after** static dependency evaluation |
| Auth starts | `auth_restore_started`, JS `session_restore_started` |
| Fresh-install guard, token and user-cache reads | Existing completion events plus new matching start events |
| Identity usable | Existing `session_restored` / `auth_me_completed`; new native `auth_identity_ready` emitted at the actual loading release |
| All bootstrap work finished | Existing `auth_restore_completed`/`failed`; **not** an identity-ready timer, since optional cache persistence can delay this terminal event after useful UI |
| Navigation gates / redirect | Existing pending snapshots, gates-cleared and root-navigation decisions |
| Family mounted | Existing JS plus native `dashboard_coordinator_mounted` |
| Requests / member availability | New dispatched and member-received events; existing load trace still captures raw members response/provenance |
| First usable Family | Existing JS plus native `first_usable_family_render`; includes a successfully loaded empty family, excludes load failure |
| Safety extras | Summary/alerts independently record received/failed; neither is the all-screen spinner boundary now |

The pre-correction Family boundary is the maximum completion time of all three
requests, followed by store/render work. The candidate boundary is the members
completion and store/render work. This is a proven dependency change, **not a
claimed number of physical seconds saved**. Auth/consent/app-lock/disclaimer/
permission gates and server authorization remain required. No stale identity
is promoted to authority to meet a timing target.

## Exact delivered native notification audit

Read-only inspection used existing finished EAS Build 70
`9e74e181-67d0-45ac-a5b1-c99915a2670a`, source
`f736fac74fcaf1ee69b10a9cac46d02b97015f2c`. This retrieves an existing artifact,
not a build request. No phone was accessed.

- Existing AAB SHA-256:
  `836c16ff8833e607f540e2230f14cbc2a9f09de4c7ae5fa1fe3d17c382c9d6dc`.
- `base/dex/classes4.dex` contains the native SDK paths below and the literal
  **`TSLocationManager version: 4.2.2 (4064)`**. This matters because source and
  EAS build logs request floating `tslocationmanagerVersion: 4.2.+`; a cached
  library alone would not prove the installed implementation.
- Body launch path:
  `com.transistorsoft.locationmanager.a.a0` obtains
  `PackageManager.getLaunchIntentForPackage`, sets MAIN/LAUNCHER and the SDK's
  task flags, calls `PendingIntent.getActivity`, then
  `NotificationCompat.Builder.setContentIntent`. It does **not** invoke
  `BackgroundGeolocation.stop` or toggle consent.
- `a.k` builds the SDK service notification. `AbstractService` calls Android
  `Service.startForeground`, using native notification ID **9942585**.
  The JavaScript `notification.id: 1` comment is not evidence of the actual
  native service ID. It is left unchanged in this pass.
- `TrackingService.onStartCommand` processes start/motion/location work and
  ultimately retains its keep-alive flag when SDK enabled **and sticky true**.
  `AbstractService.f()` uses `stopSelfResult` when no work/keep-alive remains.
  A stationary path can stop continuous location updates without disabling the
  SDK. The final sticky/enabled guard means ordinary stationary movement-state
  changes are **not sufficient evidence** of an intentional permanent removal
  of this configured notification.
- Service destruction, confirmed SDK stop/revocation and recreation can remove
  and later repost a foreground notification. The SDK has a config-change
  foreground demotion path as well; the app configuration still requests
  `foregroundService: true`, `sticky: true`, `stopOnTerminate: false`,
  `startOnBoot: true`, `enableHeadless: true`. No configuration experiment,
  PendingIntent flag change or service-lifetime patch is included.
- A notification body tap is not the app's Expo medication/SOS push-response
  handler. Native body-tap dispatch and subsequent authenticated UI readiness
  are separate stages.

### What disappearance does and does not establish

The exact cause of the observed disappearance/reappearance remains **open**.
The request contains no time-matched native service log, notification-removal
reason, enabled-state transition or precise disappearance timestamp. Possible
causes include OS/user notification removal, real stop/recreation or a different
notification/service being observed. They are hypotheses, not diagnoses.
Android OS dismissal behavior also depends on OS version; do not assume it from
`sticky` alone.

No native launch-intent change was made by the delivered JS OTA; no intentional
new “pause on body tap” behavior exists in the audited path. A historical
comparison against an unspecified earlier binary cannot establish when perceived
opening behavior changed. The persistent notification and the 10–12 second UI
delay are **not proven to share a cause**.

The confirmed multi-hour unattended moving GPS observation remains valid.
Notification absence alone is not proof of GPS failure, just as current
battery/contact alone is not proof of a fresh coordinate. Correlation with
earlier unattended communication failures is not established without matched
native/service/upload timestamps.

### Five notification-explainability answers

1. **Why:** Android foreground execution disclosure for the SDK's location work.
2. **Who:** The device user with authorized sharing, not a caregiver push recipient.
3. **Visible/invisible:** SDK/Android service and channel/removal lifecycle, not a
   React visibility flag; the particular disappearance is not explained yet.
4. **Why then:** Native service start/repost/config processing; exact reported
   disappearance timing has no matched log in this request.
5. **Why one:** SDK uses a stable native notification slot and updates it in
   place. No new app-side notification or parallel service is added.

This audit answers the configured mechanism, **not** the unresolved physical
visibility incident. Notification acceptance remains open.

## Changed behavior / protected boundaries

- Welcome is neutral while auth is pending or identity already exists. RootNav
  still decides actual routing; signup remains available after genuine sign-out.
- Members publish without awaiting summary/alerts. Unknown safety counts show
  a dash and an explicit checking/unavailable message, not a false healthy zero.
  Positive last-known incidents remain accessible; resolved incidents filter
  out only on an accepted fresh response. Cache reads cannot revive newer-
  resolved incidents, and older/account-replaced loads cannot commit responses.
- Notification copy now says “Open Kinnship to manage sharing.” Nothing pauses
  or changes consent as a side effect of opening it.
- Startup observations use the existing native module. No new dependency,
  native code, manifest/plugin, Gradle, runtime or release configuration changes.
- Moving-location policy, native motion configuration, coordinate timestamps,
  60-minute stationary eligibility, Leonidas, consent-generation/publication
  fences, SOS/medication/check-in behavior and independent battery transport are
  not modified. The Family request/paint ordering is the principal regression
  surface; adversarial UI tests cover its partial-data and ownership states.

## Verification and acceptance boundary

Automated/source tests do not establish physical speed or notification reliability.
Focused tests cover real Welcome/Dashboard components with platform/network
boundaries mocked, plus the existing real AuthProvider and RootNav recovery tests.
The known unrelated historical-identifier repository audit remains failing.
Native compilation is not required or performed for this JS-only candidate.

Completed verification:

- Full frontend: **915 passed / 1 failed**, 80 suites. The only failing test is
  the same pre-existing `legacyArtifactRepositoryAudit` historical-ID boundary.
- Focused auth/navigation/startup/safety group: **113 passed** before the final
  two additional entry-order and stale-focus tests; those additional tests pass
  in the final full-suite run above.
- TypeScript: **PASS**.
- ESLint on all changed JS/TS/test files: **0 errors, 74 warnings** (including
  existing catch/import/hook warnings and mock-harness import warnings).
- `git diff --check`: **PASS**.
- Local production Android Hermes export: **PASS**,
  `index-5252fe6954fc80481afca0c51c9d2b87.hbc`. This is a local bundle export,
  not an EAS binary build, published update, or physical acceptance result.

Local preview loads the normal unsigned-in disclaimer surface; signed-in rendered
UI is covered by component tests, not a signed-in browser screenshot or phone test.

Recommended sequence, **only after separate approval/release**:

1. Confirm the newly approved candidate's active OTA ID/runtime, not the old ID.
2. Measure one normally backgrounded warm launcher opening, then a few Home/
   reopen repetitions; preserve configuration and collect one existing full
   diagnostics export to identify the longest interval.
3. While the notification is present, time body tap to Activity/UI separately.
   If absent, note the same approximate time in that export rather than declaring
   GPS failed. Do not change permissions/battery settings or clear/reinstall.
4. Test ordinary process recreation separately only after warm behavior is
   understood and Charles authorizes that physical step.
5. Reconfirm the protected unattended moving baseline before broader acceptance.

Until matched physical evidence exists: 10–12 seconds remains a launch blocker,
notification disappearance stays open, and Google Play production stays on HOLD.
