# Android reliability hardening — pre-merge review

**Latest correction: SOS OPTIONAL-GPS BLOCKER CLEARED.**
The authorized bounded-location correction and deterministic regressions pass.
The iOS shutdown correction remains cleared. Remaining source review resumes
after the SOS correction push. Read the final supplement for the final verdict;
earlier verdicts are historical evidence.

**Status: STOP BEFORE MERGE. Draft review only; no release authorization.**

This is the initial implementation record for head
`3bc5a29f1d4f65303ed4eeb4179ddc146a4ee94e`, followed by the B1 and backend consent
correction supplements below. The initial record is not independent approval. A resumed
adversarial review is required on the corrected delivery commit.

Severity: **Critical** (tracking reliability, privacy, and caregiver freshness truth).
Confidence: high in the exercised JavaScript contracts and offline coordinate update
logic; **not established** for Kotlin compilation or real Android background behavior.
The original observed stop initiator remains unresolved. This is architectural
hardening, not a claim that a particular historical caller caused that incident.

## 1. PR number/link

The dedicated draft PR's actual number and verified URL are supplied in the
delivery report and PR description. They are not guessed from the authorization
document's historical PR number.

## 2. Branch

`fix/android-location-reliability-hardening`

## 3. Head commit SHA

The immutable delivery SHA is supplied in the delivery report and PR description.
This document is included in that commit; embedding its own SHA would change it.
Obtain it locally with `git rev-parse HEAD`.

## 4. Base/main SHA

`247c93ffa4ec8a3406de8bacb2ba99b7542a7c19`

The GitHub connector rechecked remote main at this exact SHA before delivery.
Initial baseline: 872 frontend tests passed and one legacy repository-audit test
failed (873 tests, 70 suites). No unrelated local changes were included.

## 5. Exact changed-file list

42 files, including this review:

```text
.agents/memory/kinnship-engineering-rules.md
backend/server.py
backend/tests/test_coordinate_capture_integrity.py
docs/android-reliability-hardening-review.md
frontend/app/(tabs)/dashboard.tsx
frontend/app/_layout.tsx
frontend/app/alert/[id].tsx
frontend/app/member/[id].tsx
frontend/jest.config.js
frontend/jest.setup.js
frontend/modules/startup-diagnostics/android/src/main/java/expo/modules/startupdiagnostics/StartupDiagnosticsModule.kt
frontend/modules/startup-diagnostics/android/src/main/java/expo/modules/startupdiagnostics/TrackingReliability.kt
frontend/src/__mocks__/trackingNative.ts
frontend/src/__tests__/androidLocationPublication.test.ts
frontend/src/__tests__/androidPermissionStartup.test.ts
frontend/src/__tests__/androidTrackingRecovery.test.ts
frontend/src/__tests__/devicePresenceContracts.test.ts
frontend/src/__tests__/familyCardStatus.test.ts
frontend/src/__tests__/headlessActivityWake.test.ts
frontend/src/__tests__/heartbeatSnapshot.test.ts
frontend/src/__tests__/missedCheckinReturnButton.test.tsx
frontend/src/__tests__/presenceMinimumFreshness.test.ts
frontend/src/__tests__/pushMedicationReliability.test.ts
frontend/src/__tests__/rootLocationPermissionRecovery.test.tsx
frontend/src/__tests__/task107BatteryVisibility.test.ts
frontend/src/__tests__/task108ChargingRecovery.test.ts
frontend/src/__tests__/trackingReliabilityHardening.test.ts
frontend/src/__tests__/triggerDeviceSnapshotNow.test.ts
frontend/src/__tests__/withAndroidStartupRecorder.test.ts
frontend/src/androidLocationAcquisition.ts
frontend/src/androidNativeShutdown.ts
frontend/src/androidTrackingRecovery.ts
frontend/src/api.ts
frontend/src/backgroundLocation.ts
frontend/src/batteryTask.ts
frontend/src/deviceStatus.ts
frontend/src/diagnosticsFull.tsx
frontend/src/familyCardStatus.ts
frontend/src/leonidas/patrol.ts
frontend/src/locationEngine.ts
frontend/src/tracking/TrackingStatusPill.tsx
frontend/src/trackingReliability.ts
```

## 6. Diff summary by subsystem

- Authorization/lifecycle: affirmative tri-state evidence; preserve valid tracking
  through unknown reads and obsolete operations; only confirmed withdrawal or
  replacement enters destructive shutdown.
- Cross-runtime coordination: synchronous Expo native authority, owner generation,
  process incarnation, mutation quarantine, shutdown groups, acquisition lease,
  durable backoff and bounded diagnostic journal.
- Recovery: enabled state is configuration evidence, not location health. Shared
  bounded non-persisting GPS acquisition, explicit authenticated upload and exact
  accepted-coordinate receipt checks.
- Backend: nullable coordinate tuple capture timestamp, atomic with accepted
  coordinates; sharing-off clears it.
- Caregiver UI: separate device communication and coordinate freshness; missing
  tuple time is not replaced with battery, last-seen, or legacy capture time.
- Verification: deterministic native-contract model, regression fixtures and
  condition-based FIFO waits; no dependency/SDK version changes.

## 7. Complete native stop/shutdown caller inventory BEFORE and AFTER

These are executable call-site inventories, not an attribution of the historical
incident. Lines refer to the base and reviewed working tree respectively.
Comments mentioning stop and `leonidas.stop()` are excluded: the latter stops the
JavaScript patrol timer, not the native tracking service.

### BEFORE (verified base)

| File | Executable sites / purpose |
|---|---|
| `frontend/app/_layout.tsx` | 1151 user transition; 1179 and 1190 permission reconciliation; 1209 missing startup ownership; 1250 sign-out; 1342 member removal — all call `locationEngine.stop`. |
| `frontend/src/api.ts` | 104 session clear calls `engine.stop('signout')`. |
| `frontend/src/backgroundLocation.ts` | 52 consent-off calls `engine.stop('consent')`. |
| `frontend/src/leonidas/patrol.ts` | 213 calls `locationEngine.restart`, historically stop/start. |
| `frontend/src/androidNativeShutdown.ts` | 15 raw `sdk.stop`; 41, 46, 55 late/failed fence paths invoke interrupt. |
| `frontend/src/androidTrackingRecovery.ts` | Raw `sdk.stop` at 308, 318, 340, 354, 375, 386, 394, 406, 418, 428, 432, 440: revocation/permission, lookup failure, disabled recovery and obsolete callback paths. |
| `frontend/src/locationEngine.ts` | 816 interrupt wrapper; raw `lib.stop` 1634, 1793, 1856, 1877, 2020, 2148; `stopConfiguredEngine` calls 1889, 2053, 2058. Startup cancellation/permission and restart paths could stop a shared service. |

### AFTER

| File | Executable sites / authorization boundary |
|---|---|
| `frontend/app/_layout.tsx` | 1151 confirmed user replacement; 1180 confirmed OS withdrawal; 1253 confirmed session end; 1345 confirmed member removal. Unknown initialization/lookup no longer calls stop. |
| `frontend/src/api.ts` | 104 explicit session clear, caller `clear_session_token`. |
| `frontend/src/backgroundLocation.ts` | 52 explicit settings sharing-off. |
| `frontend/src/leonidas/patrol.ts` | 213 still calls public restart, but Android's implementation performs non-destructive operational recovery, not stop/start. |
| `frontend/src/androidTrackingRecovery.ts` | Single raw stop at 95 and purge at 96, inside `shutdownConfirmedRevocation` and the native shutdown-group barrier. Other recovery branches defer/discard or invoke confirmed revocation. |
| `frontend/src/androidNativeShutdown.ts` | Raw stop at 16; late completion interrupt 58 and purge 59 only when confirmed revocation still holds, inside shutdown-group barrier. The mutation gate remains held through cleanup. |
| `frontend/src/locationEngine.ts` | Interrupt wrapper 832; confirmed binding replacement cleanup 1723–1724; interrupted cold shutdown cleanup 1815–1816; public stop cleanup 1976–1981; independent-wake revoked cleanup 2015–2019. All Android destructive groups are fenced against rebind. Raw `lib.stop` 2140 belongs to `stopConfiguredEngine`, entered at 1963 only for non-Android. |

Additional engine entry points that invoke the public confirmed stop boundary:
owner-verification callback (867), OS fence withdrawal (886), sticky consent
(1660), verified owner loss (1711), authoritative sharing-off (1730), local
sharing-off (1737), denied startup foreground/background permission (1743/1749),
session-endpoint rejection (1758), independent acquisition's confirmed-revocation
callback (2121), token refresh's confirmed revocation (2244),
independent-wake denied permission and confirmed owner/session/sharing loss
(2034/2046). Non-Android restart retains public `stop()` at 2189 after the Android
early return. Base restart also called public `stop()` after its cached-config
check. Final source is authoritative if later line numbers move.

`batteryTask` uses the independent wake/recovery boundary; it does not own raw
native stop. No new SDK stop-on-terminate or Android Force Stop mechanism is added.

## 8. Authorization tri-state

`AUTHORIZED`: affirmative current session, uniquely owned member, sharing enabled
and required grants. `REVOKED`: explicit consent withdrawal, confirmed OS denial,
session rejection on the session endpoint, or verified owner removal/replacement.
`UNKNOWN`: unavailable/corrupt/transient storage, network/bridge failures,
undetermined grants, obsolete reconciliation or generic endpoint failure.
UNKNOWN defers new work without stopping an already authorized tracker. Missing
native extension cannot authorize new Android recovery.

## 9. Owner generation versus operation lifetime

Native persisted generation fences ownership across React/headless runtimes.
Revocation increments it and removes old-owner freshness/backoff. Operation IDs
only fence a particular GPS/configuration attempt; cancellation discards that
attempt without revoking the owner or manufacturing acquisition failure.
Configuration quarantine survives the GPS lease until the native promise and
post-callback checks/cleanup settle. Shutdown groups block rebinding until
destructive work settles. Dead-process mutations are cleared by process
incarnation; a revoked interrupted shutdown requires cleanup before rebind.

## 10. Recovery state machine

Report separates authorization, configuration, acquisition, coordinate acceptance,
Android restriction and sustained-tracking evidence. States:
`CONFIGURED_UNVERIFIED`, `RECENT_LOCATION_VERIFIED`, `LOCATION_DUE_STALE`,
`ACQUIRING`, `FRESH_FIX_DELIVERED`, `DEGRADED`,
`BACKGROUND_START_BLOCKED`, `REVOKED`.
Concurrent foreground, SDK, push and WorkManager attempts share the native gate.
GPS and receipt work are bounded (GPS maximum 20 seconds, upload abort 8 seconds).
Failures defer 5, then 15, then at most 30 minutes. Fresh stationary/unknown
captures defer repeated forced GPS for 60 minutes; recent movement uses 10 minutes.
Successful configuration does not reset GPS failure backoff.

## 11. Enabled-but-dead detection

`enabled=true` is never sufficient. Authenticated current-owner member reads
observe accepted `coordinate_captured_at`; stale/missing capture remains due or
unverified despite battery/contact/HTTP events. Patrol uses coordinate time rather
than last-seen. A bounded due acquisition can verify one fresh capture; it does not
prove longitudinal service health. Android SDK HTTP events lack generation
correlation: they record contact but do not upsert response coordinates or declare
GPS recovery.

## 12. Android FGS denial

Foreground-service-start-not-allowed errors are classified as
`BACKGROUND_START_BLOCKED`, recorded and subjected to bounded backoff.
They do not revoke authorization, stop a valid existing service, invent delivery,
or trigger an immediate repeated restart loop. Real OS error forms and cold
background execution still need device validation.

## 13. One-shot versus sustained recovery

An exact accepted forced fix yields `FRESH_FIX_DELIVERED` / one-shot-delivered.
Subsequent accepted current-owner tuple observation yields
`RECENT_LOCATION_VERIFIED`, not sustained recovery.
`sustainedTracking` is always `not_proven`; no automatic sustained-health verdict
is invented. Physical time-series evidence is required.

## 14. Backend coordinate_captured_at

Nullable UTC-serialized model field; updated in the same guarded MongoDB update
as latitude/longitude using the incoming capture time. Replay/older/future or
missing timestamps do not fabricate capture recency. Presence-only updates do
not refresh this field. Existing rows remain unknown until a valid accepted fix;
no timestamp backfill is invented. Consent-off clears coordinates and tuple time.
Only the active `backend/` server is changed; the stale root server is untouched.

## 15. Caregiver UI semantics

Dashboard, family card, member and alert views use the coordinate tuple's own time
for GPS recency; device communication remains separately described. Labels
include “Device communicating”, “Location delayed”, and “Location stale”.
Presence-only contact cannot make a stale map fix fresh. Missing coordinate time
is conservative rather than falling back to last-seen. Intentional sharing-off
takes precedence. Existing live-versus-frozen-alert coordinate selection remains
unchanged; source inspection found no need for another association rewrite.

## 16. Diagnostics

Existing Diagnostics includes native reliability state and a bounded persistent
100-record metadata journal: authorization, stop intent/caller/reason, native
enabled observation, acquisition/upload outcome, coordinate acceptance, capture
time, backoff and FGS classification. Closed metadata allowlist excludes tokens,
payload bodies and GPS coordinates. Unattributed native disabled events explicitly
retain UNKNOWN caller attribution. Evidence failure must not be treated as new
authorization.

## 17. Tests added/updated

New `trackingReliabilityHardening` covers tri-state failures, operation cancellation,
late callbacks, mutation cleanup quarantine, overlapping shutdown groups,
generation/owner receipt rejection, 5/15/30 backoff, movement freshness, missing
extension, FGS classification and one-shot versus subsequent observations.
New offline backend coordinate integrity tests cover fresh/replay/older/missing/
future captures and clearing. Existing startup, root, headless, heartbeat,
publication, battery/presence and caregiver contracts use the new semantics.
Native tests inspect source and exercise a deterministic JS contract model:
**they do not execute Kotlin or prove native durability/concurrency**.

## 18. Focused test results

10 frontend suites, **348 tests passed**, exit 0:
`trackingReliabilityHardening`, `androidTrackingRecovery`,
`androidLocationPublication`, `androidPermissionStartup`,
`rootLocationPermissionRecovery`, `familyCardStatus`, `headlessActivityWake`,
`heartbeatSnapshot`, `devicePresenceContracts`, `presenceMinimumFreshness`.
Command: `npm test -- --runInBand --forceExit` plus those patterns.
Native Expo autolinking discovery passed; not a native compile.

## 19. Full frontend results

`npm test -- --runInBand --forceExit`: **909 passed, 1 failed, 910 tests;
70 passed suites, 1 failed suite, 71 total**, exit 1.
Only failure is pre-existing `legacyArtifactRepositoryAudit`, also failing at
the verified main baseline because existing historic identifiers remain in
tracked backend test fixtures. It is not fixed or suppressed by this PR.
Jest requires `--forceExit`; an existing open-handle cleanup task covers that.
Web workflow restarted; disclaimer renders without fatal browser errors.
Existing web warnings remain. **Signed-in caregiver UI was not visually verified.**

## 20. Backend results

**215 distinct isolated offline tests passed** across 15 passing selected backend
files plus 57 medication occurrence tests. New coordinate integrity: 6 passed.
Files cover escalation, battery lifecycle/atomicity/dedup, billing reconciliation,
phone-field/backfill, presence/snapshot, family removal, JWT configuration,
missed-medication summary, location-name persistence and stationary battery.
The selected legacy ensure-self-member suite did not produce a passing result.
Full backend suite is **not verified**: legacy real-Mongo requirements and ambient
event-loop contamination prevent treating the combined run as acceptance.
One earlier attempted baseline included legacy external HTTP tests; that was not
a hermetic baseline and is not reported as passing. No production database was
queried and no production data was mutated.

## 21. TypeScript

`npx tsc --noEmit`: **exit 0**, no diagnostics on the final code.

## 22. Lint versus baseline

`npm run lint`: final **exit 1, 1 error and 511 warnings**.
Verified-main archive with identical dependencies: **exit 1, 1 error and
512 warnings**. Same existing error:
`frontend/src/__tests__/reminderRoleGate.test.tsx:14:34`,
`react/display-name`. No new lint error. No unrelated lint cleanup.

## 23. Medication/SOS regression results

Full frontend run passes the medication push/action, missed-check-in notification
routing and alert/call suites, including their existing SOS cases.
Three FIFO medication tests now wait for the actual condition rather than a fixed
number of microtasks; exact routing/deduplication assertions remain.
Backend medication occurrence suite: **57 passed**, isolated offline.
Real Android medication notification tap and SOS delivery remain unverified;
these automated results do not imply end-to-end delivery acceptance.

## 24. Android/native build implications

Extends the already-linked local Expo StartupDiagnostics Android module with
synchronous Functions and SharedPreferences `commit()` state/journal.
No SDK upgrade or dependency/lockfile changes.
Java/Gradle/ADB are unavailable in this environment; **Kotlin compilation,
CNG-generated build, FGS semantics and physical lifecycle are not verified**.
No production Android build or release was run.

## 25. New Android binary required?

**Yes.** Native authority functions require a normal new Android binary.
An OTA-only delivery to existing binaries is not an acceptable rollout.
The explicit missing-extension guard is not a substitute for that binary.

## 26. Deviations and why

- Model/static native tests instead of native/device acceptance because required
  toolchain and approved physical build are unavailable; limits are explicit.
- No sustained-success state is asserted from subsequent tuple reads: longitudinal
  acceptance is the missing evidence, not a heuristic to invent.
- No API token-getter rewrite: current source already reads shared storage.
- No alert tuple-association rewrite: current live/frozen selection already pairs
  the relevant values.
- Offline coordinate fixtures mock geocoding; unrelated disabled-geocoding logging
  defect is not expanded into this PR.
- No unrelated legacy repository-audit, backend Mongo or lint repair.

## 27. Unresolved risks

- Historical initiating stop caller remains unknown.
- JS model tests do not prove native cross-runtime races, process-death durability
  or Kotlin/API compatibility. Failed disk writes require physical fault evidence.
- Lost native mutation callbacks intentionally quarantine rebinding until callback
  settlement or process recreation; this favors privacy over speculative restart.
- Initial binary upgrade/legacy ownership adoption needs actual-device coverage.
- SDK already-dispatched HTTP cannot be retroactively withdrawn by JavaScript;
  non-persisting forced acquisition fences late result publication, not earlier
  native transport that has already dispatched.
- Android/OEM Doze, service denial, cold headless bootstrap, reboot, and sustained
  driving/stationary delivery are not proven by warm-process tests.
- Existing rows without tuple capture time will display conservative unknown/stale
  location until a valid new capture.
- Full backend suite, signed-in visual UI, and physical medication/SOS remain gaps.

## 28. Proposed physical acceptance test — approval required, not executed

1. After separate merge/build/release authorization, compile the new native binary,
   inspect CNG/autolinking and install/update the approved beta phone. Record exact
   build/runtime/active update and synchronize device/server clocks.
2. Verify disclosure and background grants; establish legitimate owner/sharing.
   Record authority generation, SDK state, coordinate tuple/time and device contact.
3. Foreground then background; remove the task normally. **Do not use Android
   Force Stop as the normal reproduction.** Keep the app closed throughout tracking
   observations; read caregiver/server evidence without reopening the member app.
4. Stationary for at least two hours, then real driving/movement for at least
   30 minutes, then stationary again; retain a timestamped capture/delivery series.
   Confirm due captures and movement-aware recency, not merely enabled=true.
5. Continue overnight; charge and unplug. Confirm battery/device contact does not
   disguise stale/missing GPS and medication events do not interfere with tracking.
6. Trigger an approved data-only silent recovery push while closed. Check no
   Android notification is rendered; identify acquisition, receipt and backoff.
   One accepted fix is recorded only as one-shot; require later ordinary captures.
7. Exercise temporary network loss, location-unavailable/timeout and background
   start denial where feasible. Verify bounded/coalesced attempts and 5/15/30
   backoff rather than repeated restart; recovery does not require reopening.
8. Exercise explicit sharing-off, OS withdrawal, sign-out, owner removal and
   replacement during acquisition/configuration. Verify late results are discarded,
   old queued fixes are purged and new binding waits for destructive settlement.
   Contrast unknown lookup/storage errors: valid tracking must not be stopped.
9. Reboot without Force Stop if approved; verify cold bootstrap and durable owner/
   cooldown/shutdown evidence, including first-upgrade legacy adoption.
10. Test medication notification acknowledgment and an approved SOS scenario;
    verify correct occurrence/recipient/action, no duplicate alert, and continued
    background tracking. Follow the product's safe beta test procedure.
11. Export complete diagnostics and compare device capture, upload acceptance,
    server tuple and caregiver labels. Acceptance requires repeated appropriate
    fresh coordinates across the closed-app lifecycle. If only contact, enabled
    state or one fix is observed, **do not declare sustained recovery**.

**No merge, backend deployment, OTA, production build/release, Play submission,
or production mutation is authorized or performed by this delivery.**

---

# B1 correction supplement

## Scope and corrected behavior

The adversarial review found that permission/consent evidence obtained by A
could unconditionally revoke replacement B after an await. This correction
addresses that ownership race, without changing SDK/dependencies or scheduling.

The native `trackingRevokeIfCurrent` Function compares owner and generation under
the process-wide lock, invalidates only a match, and reserves a shutdown token
in the same critical section. A mismatch returns false without changing authority,
health, generation or shutdown state. A successful CAS reserves the barrier
before the lock is released, so another runtime cannot rebind between revocation
and SDK stop/purge. Conditional revocation persists reason and revoked owner in
native state; it deliberately queues **no revoked-intent AsyncStorage write**
that could arrive late against a replacement.

Native consent remains sticky until explicit, generation-conditional rearm.
Revoked battery transport can still authenticate the prior binding without
treating GPS consent as battery consent. Explicit signout remains supported.

Acquisition, owned-SDK permission callbacks, recovery initial/late/final consent
checks, and analogous startup/reconciliation/refresh-token withdrawal decisions
carry the captured authority into the conditional stop boundary. Recovery uses
an immutable local verification record rather than converting absent mutable
verification into consent-off or dereferencing a cleared cache.

## Exact B1 changed files (relative to the blocked head)

```text
.agents/memory/kinnship-engineering-rules.md
docs/android-reliability-hardening-review.md
frontend/app/_layout.tsx
frontend/modules/startup-diagnostics/android/src/main/java/expo/modules/startupdiagnostics/StartupDiagnosticsModule.kt
frontend/modules/startup-diagnostics/android/src/main/java/expo/modules/startupdiagnostics/TrackingReliability.kt
frontend/src/__mocks__/trackingNative.ts
frontend/src/__tests__/heartbeatSnapshot.test.ts
frontend/src/__tests__/trackingRevocationAuthority.test.ts
frontend/src/__tests__/withAndroidStartupRecorder.test.ts
frontend/src/androidLocationAcquisition.ts
frontend/src/androidTrackingRecovery.ts
frontend/src/locationEngine.ts
frontend/src/trackingReliability.ts
```

13 correction files; cumulative PR includes the original 42 files plus the new
race-test file (43 total). The heartbeat fixture's native owner now matches its
authenticated owner; assertions were not removed. Native Function inventory
assertion reflects the two supporting synchronous Functions.

## Deterministic race evidence

New suite: 16 tests. Covers delayed acquisition denial, delayed acquisition
consent, recovery denial with verification present/cleared, three recovery consent
phases, verification cache replacement, actual ownedNativeSdk permission callback,
replacement at the last instant before native CAS, four legitimate withdrawal
reasons, sticky consent/rearm and static native lock/lease placement.

Separate isolated JS policy modules share one native-contract model and storage.
Tests assert B's entire authority/health snapshot and intent remain unchanged,
tracker remains enabled, no stop/purge occurs, and no revoked-intent write occurs.
The acquisition consent case additionally asserts no upload after replacement.
The original delayed-denial sequence now rejects without touching B.

These are JS/model/static tests, **not Kotlin compilation or native concurrency/
process-death proof**. A normal new Android binary is still required.

## Verification

- Focused: **336 passed**, 8 suites, exit 0.
- Full frontend: **925 passed, 1 failed**, 926 tests, 72 suites (71 passed);
  exit 1 solely for the unchanged legacy repository-audit failure.
- TypeScript: `npx tsc --noEmit`, exit 0.
- Lint: exit 1, **1 error / 511 warnings**. Same baseline display-name error;
  blocked head also had 511 warnings, main baseline had 512.
- Medication/SOS-containing frontend regression suites pass in the full run.
  Physical delivery/routing remains unverified.
- Backend unchanged by B1; no backend rerun claimed. Initial isolated offline
  result remains 215 passing tests; full backend suite remains unverified.
- Android native compilation and physical lifecycle acceptance: not performed.

No merge, deployment, OTA, production build/release, Play or Railway/production
mutation is part of this correction. The resumed adversarial verdict is reported
separately against the corrected commit; passing B1 tests do not make the PR GREEN.

---

# Backend consent/write race correction supplement

## Root cause, confidence and scope

Critical privacy issue; high confidence from actual committed-function replay
and deterministic endpoint tests. An admitted upload checked consent before
asynchronous work, then wrote using a timestamp-only predicate. Withdrawal could
clear the pin first, and the old request subsequently restored it. This missing
fence predates this PR; it was not introduced by B1.

The blocked-head replay used the actual committed endpoint functions and a
predicate-enforcing offline DB model: sharing remained false while latitude,
longitude and coordinate_captured_at were restored. No HTTP service or database
was contacted.

Six correction files:

```text
.agents/memory/kinnship-engineering-rules.md
backend/server.py
backend/tests/test_location_consent_write_race.py
backend/tests/test_task101_location_name_persistence.py
backend/tests/test_task107_stationary_battery.py
docs/android-reliability-hardening-review.md
```

Cumulative PR: 46 files (43 previously, plus the new race suite and two existing
backend fixture files newly touched). No frontend, native, dependency, SDK or scheduling changes.

## Atomic publication contract

The location endpoint captures the member's consent generation before async
work. Its final coordinate write requires affirmative member sharing AND that
same generation, in addition to the unchanged identity/timestamp/replay filters.
Preference changes atomically mirror the sharing flag, increment generation,
and clear the displayed coordinate tuple when disabled. This fence is written
before the user preference mirror; propagation failure returns 503 rather than
claiming success. Old requests cannot revive after OFF -> ON; only a request
admitted under the new generation may publish.

Legacy missing generations mean zero. A missing member sharing flag is initialized
without coordinates only after a successful read of the existing legacy policy
(whose documented unset default is ON). Initialization requires both flag and
generation still absent; a concurrent toggle prevents it. Lookup failure is not
treated as proof for this initialization. Existing explicit member consent is
always required by the final publication predicate.

Latitude, longitude and coordinate_captured_at remain in the same guarded write.
Neither rejected consent nor replay advances the visible coordinate timestamp.
Rejected uploads may record device presence/last_seen, not location freshness.

## Response compatibility

The location endpoint still returns HTTP 200 and the current FamilyMember-shaped
record for a consent/timestamp rejection; genuinely missing members remain 404.
An endpoint-specific response subtype adds location_write_accepted and
location_write_rejection_reason without persisting them or changing other routes.
Withdrawal rejection returns false/sharing_disabled; generation mismatch after
re-enable returns false/consent_changed. Replay returns false/replay_suppressed;
older timestamp returns false/older_timestamp. Successful coordinate publication
returns true. Older clients can continue reading the existing member fields.

## Deterministic tests and verification

New race suite: 11 cases through real endpoint functions and an offline atomic
predicate model. It covers fresh and timestampless requests paused at the final
mutation, actual preference withdrawal, stored tuple clearing, receipt rejection,
normal writes, timestamp order, replay, already-off requests, OFF -> ON both with
and without a new upload, legacy initialization racing withdrawal, and propagation
failure. Assertions inspect DB effects, not only response codes.

Commands/results:

- python -m pytest -q backend/tests/test_location_consent_write_race.py
  backend/tests/test_coordinate_capture_integrity.py
  backend/tests/test_task101_location_name_persistence.py:
  **19 passed**, exit 0.
- Selected existing offline backend tests run file-by-file, including stationary
  battery and medication occurrence: **192 passed** in 16 files. Together with
  the new 11 cases: **203 distinct passing backend tests** in 17 files.
- Combined attempt including stationary tests: **19 passed / 3 failed** due to
  legacy ambient-event-loop absence. Stationary suite alone: **3 passed**.
  This is not reported as a passing combined suite.
- Full backend: **UNVERIFIED**, not run. Legacy integration tests perform external
  API/database mutations and are outside the no-production-mutation authorization.
- python -m py_compile backend/server.py and git diff --check: passed.
- Frontend B1/location regression command targeting trackingRevocationAuthority,
  androidTrackingRecovery, androidLocationPublication and trackingReliabilityHardening:
  **207 passed**, 4 suites, exit 0.
- Frontend medication/check-in regressions: **44 passed**, 2 suites.
- Frontend SOS/medication acknowledgment/routing regressions: **17 passed**, 4 suites.
- No frontend edits; TypeScript/lint not rerun. Prior results are historical, not
  claimed as new verification.
- New DB tests are models, not validation against live MongoDB.

The geocoding flag is enabled in these location tests, matching the existing
coordinate tests and documented production configuration. The already-documented
disabled-geocoding logging bug remains out of scope and untouched.

## Read-only inventory and review boundary

At the upload-correction delivery head, other member-coordinate writers included create_checkin and
respond_to_checkin_request (also reached through the member welfare-check adapter).
Their final member updates lack the location endpoint's atomic consent fence.
They were unchanged at that head; the resumed review confirmed the independent
check-in blocker addressed by the next supplement.
Member editing does not accept coordinate fields; SOS/diagnostic/history coordinates
are not the displayed member tuple. Preference withdrawal/startup sweeps clear,
rather than restore, member coordinates.

Passing this correction does not clear these other paths or the interrupted
adversarial review. STOP on the next confirmed independent blocker.
No merge, Railway deployment, production mutation, OTA, Android production build/
release or Play submission is authorized or performed.

---

# Check-in / "I'm OK" consent correction supplement

## Evidence, scope and exact writers

Critical privacy issue, high confidence. Actual functions extracted from blocked
head 359a11b429957eda386e19163e4c64734ab35eca reproduced both already-OFF and
withdrawal-at-final-write failures offline for daily check-in and welfare response:
sharing stayed false, but member coordinates and receipt coordinates were stored.
The missing fences predate this PR.

- POST /checkins, create_checkin, backend/server.py: same-family lookup and self-only
  authorization; previously direct id-only member mutation of location_name,
  latitude, longitude and coordinate_captured_at=None.
- POST /checkin-requests/{request_id}/respond, respond_to_checkin_request:
  same-family request/member lookups, self-only authorization, processing claim,
  canonical receipt/idempotency and retry release; previously the same id-only
  location mutation through run_claimed_write (a failure wrapper, not consent).
- POST /members/{member_id}/welfare-check-response is an adapter to that response
  endpoint, not a third independent writer.
- Neither writer had sharing/version conditions. Both could race withdrawal and
  OFF -> ON. Raw location was also copied into receipt rows and confirmation text.

Four correction files:

```text
.agents/memory/kinnship-engineering-rules.md
backend/server.py
backend/tests/test_checkin_location_consent.py
docs/android-reliability-hardening-review.md
```

Cumulative PR: 47 files. No frontend/native/dependency/SDK/scheduling changes.

## Architecture and contract

_location_consent_condition extracts the previous upload predicate without changing
it: affirmative member sharing plus captured generation; missing generation is
zero. The normal upload retains all timestamp/replay/identity conditions.
_publish_checkin_member_location uses the request-entry member snapshot, requires
affirmative entry consent, and atomically checks current sharing, that generation,
member id, family id and linked user id when updating location. It also guards
location_name-only writes. Missing member consent is not affirmative authority;
check-ins do not initialize legacy consent or grant it from OS GPS permission.

Presence/status are independent writes, with member/family/self identity filters.
A consent mismatch is a location no-op, not a failed check-in. Both actions still
save the check-in, acknowledge missed alerts, complete welfare processing and
retain the existing notification/idempotency behavior without location text.
No location receipt fields or breaking status changes are introduced.

OFF -> ON changes generation through the unchanged preference endpoint. Old
requests cannot publish, even after a new authorized check-in publishes first.
New requests read the new affirmative snapshot and may publish normally.

An accepted complete check-in tuple writes latitude/longitude and
coordinate_captured_at=None atomically: the payload has no trusted capture time,
so no freshness is invented. Rejected location writes touch neither tuple time,
coordinates nor label; presence does not imply fresh GPS.

New receipt rows, check-in return values and confirmation messages are location-free
even while sharing is ON. This is deliberate: a consent fence on members cannot
atomically fence a different collection insert or later push. The consented live
member tuple is the sole location publication for these features. Legacy welfare
receipt recovery returns a location-free copy and sends no location text. Existing
historical rows are not migrated/deleted; unrelated history readers are unchanged.
No product exception for check-in location is invented.

## Read-only coordinate-writer inventory

| Class | Production path | Consent/version and freshness behavior |
|---|---|---|
| Normal location | update_member_location | Atomic member consent/generation plus existing timestamp/replay guards; rejected tuples cannot restore cleared coordinates. |
| Check-in | create_checkin -> _publish_checkin_member_location | Same consent lifetime; absent entry authority fails closed; accepted tuple age unknown. |
| Welfare | respond_to_checkin_request, member adapter | Same helper; claimed processing does not itself grant location authority. |
| SOS/emergency | trigger_sos | Stores supplied coordinates in emergency Alert and sends emergency push/SMS location, without ordinary sharing/generation fence. Does not write the live member tuple. Existing deliberate emergency trigger; no new privacy contract inferred and no change made. |
| Geocoding | list_members, get_member | Writes location_name only, conditional on unchanged coordinates and null label. No consent-generation predicate; cannot match the ordinary OFF-cleared tuple. In-flight response semantics need independent review. |
| Preference/internal | update_my_preferences; startup sharing backfill/sync/heal | Preference OFF atomically clears tuple and increments generation. Backfill initializes flags; sync clears tuple; heal can turn a flag ON without versioning. Read-only review target, not repaired here. |
| Creation/profile | create_member; backend/family_group.py self-member creation | New rows have no coordinates. Profile-update schema does not accept coordinate fields. |
| Diagnostics/history | update_member_location ingest log and quality-history inserts; device snapshot | Separate storage surfaces, not live tuple writes. Ingest includes supplied raw GPS even for final-write rejection; quality history follows earlier acceptance, not a new consent CAS. Snapshot is diagnostic metadata. No changes; independent privacy review required. |
| Test-only/inactive | backend/tests; stale root backend copy | Tests use offline mocks; root copy is not the documented active Railway backend. Not repaired or treated as active production evidence. |

No additional live-tuple writer was found by the read-only search of active backend
source. Above unfenced ancillary storage and startup consent mutation are explicitly
not cleared by passing this correction.

## Deterministic tests and current verification

25 new cases exercise the actual daily, welfare and member-adapter functions:
already-OFF success, withdrawal at final atomic mutation, OFF -> ON with old request
finishing before/after new publication, valid ON, missing affirmative entry consent,
legacy generation zero, location-name-only suppression, and legacy canonical/repeated
welfare receipt recovery. Assertions inspect persisted tuples/labels, unchanged
generation except intentional toggles, location-free durable rows/responses/pushes,
missed-alert acknowledgment and welfare responded state.

Commands/results:

- python -m pytest -q --disable-warnings backend/tests/test_checkin_location_consent.py:
  **25 passed**.
- python -m pytest -q --disable-warnings backend/tests/test_checkin_location_consent.py
  backend/tests/test_location_consent_write_race.py backend/tests/test_task123_welfare_check.py
  backend/tests/test_coordinate_capture_integrity.py backend/tests/test_task101_location_name_persistence.py:
  **50 passed**, exit 0 (25 new + 11 upload privacy + 6 welfare + 6 capture + 2 label).
- Sixteen existing files run individually with python -m pytest -q --disable-warnings
  backend/tests/NAME.py: **192 passed**, all exit 0:
  test_authoritative_escalation_completion (18), test_battery_alert_lifecycle (48),
  test_battery_atomic_state (6), test_battery_dedup_concurrent (9),
  test_billing_webhook_reconciliation (6), test_build48_alert_phone_backfill (12),
  test_call_button_phone_field (10), test_coordinate_capture_integrity (6),
  test_device_presence (11), test_device_snapshot_tracking_mode_contract (5),
  test_family_member_removal (3), test_jwt_secret_config (10),
  test_missed_medication_summary (9), test_task101_location_name_persistence (2),
  test_medication_occurrence_reliability (34), test_task107_stationary_battery (3).
  Distinct isolated total including upload privacy, welfare and new suite:
  **234 passed across 19 files**; duplicates between commands are not added twice.
- Combined upload/capture/label/stationary command remains **19 passed / 3 failed**
  with identical legacy "no current event loop" failures. Stationary individually:
  **3 passed**. Full backend **UNVERIFIED**, not run; existing check-in integration
  test_iter3_features.py creates external accounts/data and is deliberately not run.
- cd frontend && npm test -- --runInBand --forceExit trackingRevocationAuthority
  androidTrackingRecovery androidLocationPublication trackingReliabilityHardening
  missedCheckinReturnButton pushMedicationReliability sosDeliveryAcknowledgment
  medicationNotificationAck notificationResponseRouting: **251 passed**, 6 suites.
  Only six matching suites exist; the latter unmatched patterns do not prove coverage.
  B1/location contributes 207, medication/check-in contributes 44.
- cd frontend && npm test -- --runInBand --forceExit sosPermissionRegression
  medicationAcknowledgment medicationAcknowledgeModal medicationNotificationRoute:
  **17 passed**, 4 suites.
- python -m py_compile backend/server.py; git diff --check: passed.
- Frontend unchanged; TypeScript/lint not rerun. Native compilation, real MongoDB
  concurrency, signed-in UI and physical Android remain unverified.

Review resumes only after the correction is committed/pushed and remote/PR status
verified. Passing tests are not a GREEN verdict. STOP on the next independent
Critical/High release blocker; do not automatically repair it.
No merge, Railway deployment, production mutation, OTA, Android production
build/release or Google Play submission is part of this correction.

---

# Startup-repair consent race correction supplement

## Root cause, evidence and narrow scope

Critical privacy blocker, predating #166. The cross-user sharing heal scanned a
disabled member, read its linked user's preference asynchronously, then enabled
sharing using only the member id. A concurrent withdrawal changed generation and
cleared coordinates, but the old repair restored authority. A subsequent check-in
then published coordinates while the user's preference stayed OFF.

An offline replay extracted the actual repair from blocked head
0e37e4a69cd164f85bb91c7ff09356741a8a0f37 and used the real preference/check-in
functions. It reproduced restored authority and coordinates after withdrawal.
No external service or production database was used.

Four correction files:

```text
.agents/memory/kinnship-engineering-rules.md
backend/server.py
backend/tests/test_startup_repair_consent_race.py
docs/android-reliability-hardening-review.md
```

Cumulative PR: 48 files. No frontend/native/SDK/scheduling/dependency changes.

## Exact correction and semantics

The repair scan now projects the observed consent generation. Its final update
requires the observed member id, linked user id, creator identity, disabled sharing
state, and consent lifetime. It reuses _location_consent_condition for generation
matching, overriding the expected sharing state to False for this repair.
Missing generation retains the existing legacy-zero semantics.

Only an explicitly affirmative linked preference permits an authorizing repair.
False, missing and null preference values do not grant authority. A legitimate
unchanged legacy inconsistency can still be healed. Successful repair enables the
member flag and removes the OFF placeholder; it neither writes coordinates nor
changes consent generation. Its count reflects actual modified rows, not attempts.

The CAS itself rejects a stale repair after withdrawal, OFF -> ON, or relinking.
No second read/check is treated as sufficient. Rejection changes no state,
coordinates, labels, tuple timestamps or generation. A later check-in remains
functional but cannot publish under the withdrawn authority.

## Related production authority-writer inventory (read-only)

- update_my_preferences: atomically changes member flag/generation, clears the
  visible tuple on OFF, then updates the user mirror. Not changed here.
- update_member_location legacy initialization: only a successful linked-policy
  read can initialize an absent flag; CAS requires absent flag and generation.
  Final publication still checks consent lifetime and timestamp ordering.
- _backfill_location_sharing_flag: sets ON only where the member flag is absent;
  no generation increment, and cannot overwrite a flag created by a current toggle.
- _sync_user_sharing_pref_to_members: snapshots OFF users, then disables linked
  member rows and clears their tuple using user_id only, without generation fencing.
  Its interaction with concurrent re-enable is a resumed-review target; not changed.
- _heal_cross_user_sharing_leaks: corrected expected-state/generation/identity CAS.
- backend/family_group.py self-member creation: copies linked sharing policy while
  inserting an empty coordinate tuple; not a repair of an existing row.

No other active backend generation writer was found by the targeted read-only
search. Separate location history/ingest, emergency and geocoding surfaces remain
independent review targets. No unrelated repair or SOS behavior was changed.

## Deterministic tests and verification

22 new cases execute the actual startup repair with a projection-enforcing cursor
and predicate-enforcing atomic database model:

- Withdrawal at the asynchronous preference lookup and the final update boundary,
  with missing/zero/nonzero generations; followed by successful daily/welfare
  check-ins whose coordinates stay absent (12 cases).
- OFF -> ON with a new valid check-in before old repair resumes (2 cases).
- Legitimate unchanged repair for missing/zero/nonzero generations (3 cases).
- Nonaffirmative linked evidence cannot authorize (3 cases).
- Linked-account or creator replacement invalidates repair identity (2 cases).

Assertions inspect the entire member state after stale repair, actual CAS
acceptance/rejection, unchanged generation, absent tuple, label, projected generation,
and check-in/welfare non-location effects. This is not live MongoDB validation.

Commands/results:

- python -m pytest -q --disable-warnings backend/tests/test_startup_repair_consent_race.py
  backend/tests/test_checkin_location_consent.py backend/tests/test_location_consent_write_race.py
  backend/tests/test_task123_welfare_check.py backend/tests/test_coordinate_capture_integrity.py
  backend/tests/test_task101_location_name_persistence.py:
  **72 passed**, exit 0 (22 new + the prior focused 50).
- The same sixteen existing files enumerated in the previous supplement, each run
  with python -m pytest -q --disable-warnings backend/tests/NAME.py:
  **192 passed**, all exit 0. Including repair, check-in, upload privacy and welfare:
  **256 distinct isolated backend tests across 20 files**, without double-counting.
- Combined upload/capture/label/stationary command: **19 passed / 3 failed**,
  unchanged legacy ambient-event-loop failures. Stationary alone: **3 passed**.
  Full backend remains **UNVERIFIED**, not run; production-mutating integration
  tests remain excluded.
- cd frontend && npm test -- --runInBand --forceExit trackingRevocationAuthority
  androidTrackingRecovery androidLocationPublication trackingReliabilityHardening
  missedCheckinReturnButton pushMedicationReliability sosPermissionRegression
  medicationAcknowledgment medicationAcknowledgeModal medicationNotificationRoute:
  **268 passed**, 10 suites, exit 0. Includes 207 B1/location, 44 medication/check-in,
  and 17 SOS/medication acknowledgment/routing regressions.
- python -m py_compile backend/server.py; git diff --check: passed.
- Frontend unchanged; TypeScript/lint not rerun. Android compilation, physical
  lifecycle acceptance, live MongoDB concurrency and signed-in UI remain unverified.

After commit/push/status verification, resume adversarial release-blocker review
on the immutable new head. Stop only for confirmed Critical/High privacy, safety,
security, authority-loss or core-reliability/native-operation blockers. Ordinary
technical debt and low-impact theoretical concerns are deferred, not build gates.
No merge, Railway deployment, production mutation, OTA, production Android
build/release or Play submission is authorized or performed.

---

# Startup synchronization authority race correction supplement

## Root cause and narrow correction

High core-reliability blocker, predating #166. An OFF-user cursor supplied stale
evidence to a later user_id-only update_many. A newer ON toggle advanced member
generation, but the sweep disabled that newer authority and cleared its tuple.
Self-created rows were skipped by the cross-user heal, leaving uploads rejected.

Three correction files:

```text
backend/server.py
backend/tests/test_startup_sync_consent_race.py
docs/android-reliability-hardening-review.md
```

Cumulative PR: 49 files. No frontend/native/dependency/SDK/scheduling changes.

The sweep now observes each linked member's state, generation and identities
BEFORE asynchronously reading its user's preference. This ordering is essential:
reading stale OFF evidence first and then capturing a newer member generation
would incorrectly attach old evidence to current authority.

Only explicit OFF policy authorizes synchronization. The final update_one requires
the observed member id, linked user, creator, sharing state (or field absence) and
generation. Legacy missing generation remains zero through the shared predicate.
The policy is read separately after each member observation, never cached across
members observed at different times. Selection remains by linked user, not creator.

A legitimate unchanged OFF synchronization still disables the row and clears its
coordinates, tuple timestamp and label. A stale write changes nothing. Neither
successful nor rejected maintenance increments/resets generation; newer user
operations remain authoritative. A second startup after ON leaves the row enabled.

## Startup-maintenance family inventory — source enumeration

The audit searched all active backend startup handlers plus repair, synchronization,
backfill, migration, reconciliation, normalization and linkage helpers, then traced
the relevant delegates in backend/family_group.py. No maintenance routine below
was executed against a real database.

| Path / trigger | Observation, final mutation and preliminary classification |
|---|---|
| _backfill_location_sharing_flag / boot | Only absent flags match final update_many; existing user-toggle flags are untouched. Legacy-only initialization; no tuple write or generation change. |
| _sync_user_sharing_pref_to_members / boot | Corrected member-before-policy observation; final state/generation/identity CAS. Currently fenced, including self-created rows and legacy generation zero. |
| _heal_cross_user_sharing_leaks / boot | Disabled-member snapshot before affirmative linked-policy lookup; final identity/disabled-state/generation CAS. Currently fenced; deliberately skips self-created rows. |
| _heal_missing_self_member_rows -> fg.ensure_self_member_row / boot | Full user snapshot precedes member-existence lookups and a new-row insert. Helper copies snapshot sharing into an empty-coordinate row without a generation. Separate authority-insertion race target for independent adjudication; unchanged. |
| fg.ensure_self_member_row / login, signup, join | Same delegate outside startup; existing row returned unchanged, otherwise snapshot-based creation. Review together with missing-row maintenance, not presumed safe merely because coordinates start empty. |
| _migrate_family_groups -> fg.create_group_for_user / boot | Selects users missing family id; creates a group and updates user by id; data backfill requires owner plus absent family id. No consent/coordinate writes. Legacy group-identity maintenance; concurrent membership behavior not fully cleared. |
| fg.ensure_family_group / lazy reconciliation | Resolves group, creates if absent, backfills owned data only where family id is missing. No consent/tuple mutation; legacy group-identity concerns deferred unless confirmed release-critical. |
| fg.transfer_data_to_group / explicit join | Re-tags owned data by owner_id. Not automatic consent repair; separate membership operation. No direct consent/generation/coordinate write. |
| Signup/login name-match linkage / account lifecycle | Links matching placeholder rows; not boot consent maintenance. Related identity path for broader review, not changed here. |
| _migrate_invite_ghost_heal_v62 / boot | Old pending invites + current group-email evidence; final id/pending-status mutation changes invite status only. Does not link members or grant live publication authority. No demonstrated location blocker. |
| _migrate_iso_string_timestamps_to_date / boot | Converts check-in/alert/reminder/log date fields by _id. Does not backfill member coordinate_captured_at or invent GPS age. Outside live authority writes. |
| _purge_legacy_demo_data / boot | Deletes fingerprinted demo rows and references. Does not restore coordinates/consent; existing narrow demo-cleanup behavior, not run or changed. |
| Billing initialization/reconciliation, legacy-reminder migration, medication scheduler / boot or admin | Billing/reminder/scheduling state, not member consent/linkage/tuple mutation. Outside this maintenance authority family. |
| Geocode/history/alert indexes, recovery-receipt restart, push-token dedupe, alert/phone backfills / boot | Index, delivery, diagnostic or alert metadata. No direct member consent/generation/linkage/visible-tuple mutation found in these handlers. |
| Geocoding label normalization / member reads | Conditional label persistence against unchanged coordinates/null label. Not startup authority repair; broader asynchronous response review remains separate. |
| Tests and stale root server copy | Offline/test-only or not the documented active production backend; not treated as live maintenance paths. |

This is a complete candidate enumeration from the targeted source search, not
independent clearance of every path. Final classifications and any blocker are
reported by the resumed review. Stop deeper review at the next confirmed
Critical/High defect; do not repair any separate creation/linkage/migration path.

## Deterministic verification

26 new cases exercise actual synchronization/preference/upload functions:

- Stale OFF versus newer ON at lookup and final-write boundaries, with absent,
  zero and nonzero generation; a valid new fix exists before stale sync resumes,
  another upload succeeds afterward, and second startup preserves self-row state.
- OFF -> ON -> OFF and OFF -> ON -> OFF -> ON reject old work even when the
  boolean returns to its observed value.
- Legitimate OFF clearing for missing/False/True flags and legacy/current generations.
- New withdrawal, linked-user/creator replacement, and nonexplicit OFF policy.

Assertions inspect full member state, accepted coordinate tuple/time, exact
generation preservation, final mutation rejection and self-created-row persistence.

Commands/results:

- python -m pytest -q --disable-warnings backend/tests/test_startup_sync_consent_race.py
  backend/tests/test_startup_repair_consent_race.py backend/tests/test_checkin_location_consent.py
  backend/tests/test_location_consent_write_race.py backend/tests/test_task123_welfare_check.py
  backend/tests/test_coordinate_capture_integrity.py backend/tests/test_task101_location_name_persistence.py:
  **98 passed**, exit 0: 26 sync + 22 heal + 25 check-in + 11 upload + 6 welfare
  + 6 coordinate integrity + 2 label persistence.
- The sixteen existing isolated files enumerated in the preceding supplements:
  **192 passed**, all exit 0. Distinct total, without duplicate counting:
  **282 isolated backend tests across 21 files**.
- Combined upload/capture/label/stationary run: **19 passed / 3 failed**, unchanged
  legacy no-current-event-loop failures; stationary separately **3 passed**.
  Full backend **UNVERIFIED**, not run; external-mutating integration tests excluded.
- cd frontend && npm test -- --runInBand --forceExit trackingRevocationAuthority
  androidTrackingRecovery androidLocationPublication trackingReliabilityHardening
  missedCheckinReturnButton pushMedicationReliability sosPermissionRegression
  medicationAcknowledgment medicationAcknowledgeModal medicationNotificationRoute:
  **268 passed**, 10 suites (207 B1/location + 44 medication/check-in + 17 SOS/routing).
- python -m py_compile backend/server.py; git diff --check: passed.
- Frontend unchanged; TypeScript/lint not rerun.

Real MongoDB concurrency and Android process-death follow-ups remain deferred,
not started. No Android compilation or physical validation is claimed.
After commit/push/status verification, resume independent release-blocker review
at that exact head; no GREEN based only on pass counts or partial family audit.
No merge, Railway deployment, production mutation, OTA, production Android
build/release or Play submission is authorized or performed.

---

# Missing-self-member consent correction supplement

## Root cause and authority mechanism

The shared self-member creator copied sharing from its caller's user snapshot,
defaulting missing consent to ON. Withdrawal could complete before the row existed,
then stale creation supplied new ON authority to ordinary check-in publication.
This pre-existing creation defect was confirmed offline on the preceding head.

The correction is in backend/family_group.py:ensure_self_member_row, not just the
startup caller. Existing rows remain unchanged. Every newly created row starts:

- location_sharing_enabled=False
- location_consent_generation=0
- latitude=None, longitude=None, coordinate_captured_at=None
- location_name="Location Sharing Off"

Current ON establishment requires a fresh explicit preference operation through
the existing endpoint; that operation advances the existing member generation.
This also works when the user mirror already says ON. The user expressly permits
a fresh affirmative operation after fail-closed creation. This is not permanent
disablement: real explicit enable plus fresh upload/check-in is tested.

Another users read cannot safely auto-enable a new row: withdrawal updates
existing members BEFORE persisting its user mirror. If creation occurs between
those writes, an apparently current ON user mirror is still obsolete. No separate
consent system, user-level generation, migration or transaction was introduced.

Creation now uses a deterministic Mongo _id for the (group,user) creation slot
and update_one with $setOnInsert/upsert. The built-in unique _id prevents duplicate
rows from concurrent calls to this helper. A duplicate-key loser reads the winner;
it does not reset consent, metadata or coordinates. The public member id remains
random per insertion, so deletion/recreation cannot let an old request match a
new incarnation with a reused generation. Persisted identity is checked on return.
Missing expected persistence fails explicitly rather than returning a fake row.

Non-location membership fields, invitation role/relationship, cadence, demographics,
and existing legacy member rows are preserved. No frontend, native, SDK, package,
SOS or production configuration was changed.

## Complete direct production caller inventory

All seven current direct callsites invoke the same corrected helper:

| Callsite | Supplied snapshot / asynchronous work |
|---|---|
| server.py verify-otp, signup_invite | Newly inserted user doc after invite resolution, assignment and legacy placeholder linkage |
| server.py verify-otp, signup_solo | Newly inserted user doc after solo-group creation |
| server.py verify-otp, login_invite | Previously loaded user after invitation/group transfer and assignment |
| server.py verify-otp, login_heal | Loaded user after OTP and any family reconciliation |
| server.py _heal_missing_self_member_rows, startup_migration | Full cursor snapshot before existence checks |
| family_group.py join, join_already_member | Authenticated current-user snapshot after invite resolution |
| family_group.py join, join | Authenticated snapshot after ownership checks, transfer and assignment |

All snapshots may be stale. The corrected creation invariant does not depend on
their preference values, freshness or supplied generation. None of these helper
calls can make a NEW helper-created row ON. Existing-row linkage before the helper
and equivalent authority-establishment paths remain explicit review targets, not
implicitly cleared by this direct-call inventory. Independent read-only review
of the committed/pushed head follows verification; report its actual verdict,
including any stop or incomplete broader scope.

## Deterministic verification

backend/tests/test_self_member_consent_creation.py: **32 passed**:

- 14 caller-input/boundary cases (seven labels, lookup and final upsert). Startup
  executes the actual startup handler; remaining labels exercise the shared helper
  with stale input, not entire OTP/email/login flows.
- One member-first withdrawal/user-mirror-gap case.
- Four ON/OFF/unknown/missing cases proving fail-closed creation, location-free
  successful check-in, explicit current enable, accepted normal upload and check-in.
- One post-insertion ON/OFF/ON case preserving generation three and a valid tuple.
- Two concurrent creator cases, including a simulated duplicate-key loser.
- One deletion/recreation public-identity case rejecting old publication identity.
- Two pre-insertion ON/OFF/ON cases: stale work stays OFF; fresh enable recovers.
- One invitation metadata/member-creation preservation case.
- Six existing-row cases (ON/OFF, absent/zero/current generation) preserving state.

The existing family-removal offline collection gained only the upsert/$setOnInsert
behavior required to run its real join/reinvite regression with the corrected helper.

Focused command:

```text
python -m pytest -q --disable-warnings
 backend/tests/test_self_member_consent_creation.py
 backend/tests/test_family_member_removal.py
 backend/tests/test_startup_sync_consent_race.py
 backend/tests/test_startup_repair_consent_race.py
 backend/tests/test_checkin_location_consent.py
 backend/tests/test_location_consent_write_race.py
 backend/tests/test_task123_welfare_check.py
 backend/tests/test_coordinate_capture_integrity.py
 backend/tests/test_task101_location_name_persistence.py
```

Result: **133 passed**, exit 0 (32 creation + 3 real family-removal/reinvite
regressions + 26 sync + 22 heal + 25 check-in/welfare + 11 upload + 6 welfare
endpoint + 6 coordinate integrity + 2 label persistence).

Sixteen additional isolated runs, all exit 0:

```text
test_authoritative_escalation_completion: 18
test_battery_alert_lifecycle: 48
test_battery_atomic_state: 6
test_battery_dedup_concurrent: 9
test_billing_webhook_reconciliation: 6
test_build48_alert_phone_backfill: 12
test_call_button_phone_field: 10
test_coordinate_capture_integrity: 6
test_device_presence: 11
test_device_snapshot_tracking_mode_contract: 5
test_family_member_removal: 3
test_jwt_secret_config: 10
test_missed_medication_summary: 9
test_task101_location_name_persistence: 2
test_medication_occurrence_reliability: 34
test_task107_stationary_battery: 3
```

These runs total **192**. Without counting duplicate files/tests, current distinct
isolated backend evidence is **314 passed across 22 files**. Full backend:
**UNVERIFIED, not run**. Previous combined legacy evidence remains 19 passed /
3 event-loop failures; that combined command was not rerun in this correction.
Stationary cases independently passed again.

Frontend command (same ten patterns as preceding supplement): **268 passed /
10 suites**, exit 0: 207 B1/location + 44 medication/check-in + 17 SOS/routing.
Jest still uses --forceExit; full frontend/TypeScript/lint not claimed.
python -m py_compile backend/family_group.py backend/server.py and git diff --check:
passed. No physical/native or real-database concurrency claim follows these models.

Real MongoDB and Android process-death/across-runtime validation remain deferred
and unstarted. No Android compile/build or physical validation performed.
No merge, Railway deployment, production mutation, OTA, production Android
release/build or Play submission performed or authorized.

---

# Location-history privacy correction and focused inventory

## Correction and exact privacy contract

The pre-existing location-history write/read paths lacked a consent lifetime:
an upload accepted before withdrawal could insert history afterward, and any
same-family account could read that or previously retained precise history while
sharing was OFF. The live member CAS alone did not protect this second collection.

New accepted-upload history records carry the ORIGINAL request's captured member
consent generation and linked subject_user_id. These are never refreshed from a
later read. Family history reads require an affirmative current member flag and
valid generation, filter records by that exact generation/subject, then revalidate
the member's identity/family/state/generation after asynchronous cursor fetching.
Withdrawal atomically advances the existing member generation, invalidating every
earlier record's family visibility. OFF -> ON cannot revive old pending inserts.

This is a generation-scoped publication mechanism, NOT a claim that the separate
collection insert and member mutation form a MongoDB transaction. A delayed insert
may remain PRIVATE owner diagnostic evidence; it can never inherit a new consent
lifetime merely because the boolean is ON again. The authoritative member check
is the final family-disclosure decision, not a second pre-insert policy read.

Self diagnostics are explicitly distinguished by linked member.user_id matching
the authenticated user. Caregiver/creator/group-owner status is NOT self identity.
Self reads preserve own prior/legacy history even while sharing is OFF; explicit
records for a different linked subject are excluded. Self identity/family is also
revalidated after cursor fetch. Legacy untagged history is never backfilled into
current affirmative family authority, and remains available only to linked self.

Denied family access returns an empty list, not redacted entries containing other
precise labels/maps/nested GPS fields. Different-family and unauthenticated access
remain denied. Normal current-lifetime family history remains available while ON.
No records are deleted, TTL timestamps refreshed, retention extended, or frontend/
native/SOS behavior changed.

## Complete direct history inventory and secondary precise-data candidates

The targeted source search covered active backend Python and frontend history
calls plus equivalent GPS-history/secondary precise-location storage. Direct
location_history collection usage has one producer and one API reader.

| Writer / storage | Authority, async boundary, visibility and audit result |
|---|---|
| update_member_location -> location_history | Accepted live member CAS; original generation/linked subject now stamped immutably. Async history insertion may race withdrawal, but stale records are self-only, never family-visible under a later lifetime. Corrected. |
| update_member_location -> location_ingest_log | Raw precise diagnostic coordinates including rejected/replay evidence; writer/group/member identifiers; 24h configured TTL. Separate diagnostic storage, not returned by the history API. No normal family reader of this collection found in targeted search. Not deleted or changed. |
| update_member_location -> members.location_pipeline | Atomic live member write stores native/stored coordinates as a diagnostic echo. Withdrawal clears root tuple but not this nested object; member response paths return it. Separate confirmed privacy blocker; unchanged. |
| _trace_record_gps -> _REFRESH_TRACE_LOG | Precise last-GPS evidence attached to in-memory refresh entries; diagnostic family-reader candidate. Not changed; independent stop-rule review must explicitly classify this alongside metadata disclosure. |
| Check-in/welfare -> checkins | Current corrected writes/receipts contain no location; guarded member publication is separate. Legacy retained receipt readers are not implicitly cleared by this history correction. |
| SOS -> alerts / emergency fanout | Explicit emergency location path, not silently redefined as ordinary history. Existing semantics untouched; remaining SOS source assessment not claimed complete. |
| Lazy geocoding -> geocode_cache | Generic coordinate/address cache, not member history; conditional member label persistence. No direct family history API for this cache found. Broader async member-response assessment stopped. |
| Logs / client-local diagnostics | Server ingest/trace logging and client-local GPS/pipeline diagnostics are additional copies, not this API's family-publication authority. Local diagnostics/export does not authorize another account's server access. |

| Reader / consumer | Identity, consent and audit result |
|---|---|
| GET /members/{id}/location-history | Existing family scope preserved. Linked self may read own retained evidence; every OTHER family account requires current affirmative exact-lifetime authority, including final post-fetch check. Corrected. |
| frontend/src/diagnosticsFull.tsx | Uses the device's stored own member id to call that API; no role/creator fallback introduced. Read-only inspection confirmed existing self-diagnostic product use. |
| GET /members and GET /members/{id} | Return typed location_pipeline including retained nested coordinates. Root sharing-OFF clear does not remove this echo. Separate release blocker, not fixed under history authorization. |
| diagnostics_refresh_traces | Family-authorized in-memory GPS trace reader; consent/identity-lifetime behavior remains a separate audit target at STOP. |
| diagnostics_my_members / diagnostics_family_snapshot | Additional member/diagnostic readers identified during inventory; not blanket-cleared beyond collection/projection inspection. |
| list_member_checkins / list_recent_checkins / welfare recovery | Current check-in receipts are location-free; legacy historical payload privacy is not fully cleared after STOP. |
| Alert/SOS readers and emergency delivery | Emergency semantics unchanged, not used as an ordinary-history privacy exception. Full review remains incomplete. |
| Account reset/deletion, retention/index handlers | Delete/count/index direct history data; do not return precise history to ordinary family accounts. Existing retention/delete behavior unchanged. |
| Root stale server copy / offline tests / investigation scripts | Not counted as active production backend history routes; not executed against production. |

This inventory enumerates direct history writers/readers and the secondary
coordinate copies found in the targeted search. It is not full safety clearance
of all related diagnostics, legacy records or remaining source. The pipeline
disclosure triggers RED/STOP after completing this authorized correction.

## Verification

32 new tests in backend/tests/test_location_history_consent.py passed:

- Existing ON family history followed by real withdrawal: family empty, self
  history preserved, stored records/timestamps unchanged.
- Six upload/history races: pause before payload construction or at final insert,
  with missing/zero/nonzero initial generation. Inspect retained old-scope records
  AND denied family responses, not just upload return values.
- Two OFF/ON cycling cases: old insert cannot inherit current authority; fresh
  upload is visible under the new generation; self retains both diagnostic epochs.
- Four post-fetch family races: OFF, OFF/ON, relinking and family movement.
- Two post-fetch self identity/family races.
- Five nonaffirmative sharing cases including metadata/creator-owner spoofing.
- Four unverified generation cases, all family-fail-closed.
- Valid BSON Int64 generation remains readable under current affirmative consent.
- Legacy self-only history and explicit foreign-subject exclusion.
- Unrelated family / missing requester identity; actual no-token HTTP denial.
- Rejected live upload creates no history.
- Three limit/order/serialization/unchanged-timestamp cases; static seven-day TTL
  configuration assertion (NOT a claim about a real MongoDB index).

Focused command:

```text
python -m pytest -q --disable-warnings
 backend/tests/test_location_history_consent.py
 backend/tests/test_self_member_consent_creation.py
 backend/tests/test_family_member_removal.py
 backend/tests/test_startup_sync_consent_race.py
 backend/tests/test_startup_repair_consent_race.py
 backend/tests/test_checkin_location_consent.py
 backend/tests/test_location_consent_write_race.py
 backend/tests/test_task123_welfare_check.py
 backend/tests/test_coordinate_capture_integrity.py
 backend/tests/test_task101_location_name_persistence.py
```

**165 passed**, exit 0: 32 history + 32 self-member + 3 family + 26 sync +
22 heal + 25 check-in/welfare + 11 upload + 6 welfare + 6 tuple + 2 label cases.

The same sixteen isolated backend files enumerated in the preceding supplement
were rerun: **192 passed**, all exit 0. Distinct total without duplicate counting:
**346 isolated backend tests across 23 files**. Full backend **UNVERIFIED**.
Previous combined evidence remains 19 passed / 3 legacy event-loop failures;
that combined command was not rerun. Stationary separately passed again.

Frontend command (same ten patterns as preceding supplements): **268 passed /
10 suites**, exit 0: 207 B1/location + 44 medication/check-in + 17 SOS/routing.
Python compilation and git diff --check passed. Frontend/TypeScript/lint/native
compilation and physical/process-death validation are not claimed.

The history privacy correction, directly required tests, this supplement and
narrow privacy-contract memory update are the only changes authorized here.
After commit/push verification, return the actual read-only audit verdict and
precise remaining blocker; do not finish with only a review-resumption statement.
Real MongoDB concurrency and Android process-death follow-ups remain deferred,
unstarted. No merge, Railway deployment, production mutation, OTA, production
Android build/release or Play submission performed or authorized.

---

# Location-pipeline privacy correction

## Root cause and strategy

The accepted coordinate CAS also writes precise native/stored coordinates in
members.location_pipeline. Withdrawal clears the root tuple but deliberately
retains diagnostic evidence. FamilyMember responses previously serialized that
arbitrary nested object without a consent-lifetime or linked-self distinction.

New pipeline snapshots carry the ORIGINAL upload's consent generation and linked
subject_user_id, in the SAME guarded MongoDB mutation as coordinates. Old
snapshots are not backfilled, retagged, or refreshed into newer authority.

The shared response-only privacy fence preserves a pipeline for:

- Explicit authenticated linked self, including own retained legacy diagnostics
  while OFF; explicit foreign-subject snapshots are excluded.
- Another family account ONLY when snapshot subject/generation match the current
  affirmative member lifetime, and the response's member snapshot has the same
  identity/generation as current authority.

Otherwise the ENTIRE pipeline object is omitted (null), not four guessed field
names. Arbitrary aliases, native/provider payloads, labels and map URLs therefore
cannot bypass denial. Caregiver, creator, group-owner and family membership are
not self ownership. Unverified/malformed/legacy pipeline authority is never guessed.
Valid BSON Int64 counters remain supported; boolean counters are not authority.

GET /members and GET /members/{id} apply the fence after geocoding/presence awaits.
The list uses one final bulk authority fetch. The single route rechecks authority.
Family snapshots invalidated by withdrawal/cycling/relinking also lose their stale
root coordinates, label and capture timestamps in the returned copy.

Other ordinary responses using the SAME FamilyMember payload are fenced too:
profile update, battery patch, check-in settings and LocationWriteResponse,
including early sharing-disabled and delayed owner-assisted upload responses.
Where a full member reread is already the last await, that reread is the authority;
no redundant second DB read is added. Delayed owner-assisted uploads need a final
authority read because ingest/history awaits follow their original snapshot.
Brand-new create_member responses have no pipeline/coordinates to disclose.

No retained diagnostic data is deleted. OFF -> ON leaves old pipeline snapshots
private; a fresh accepted current-generation upload restores valid family
pipeline and live-coordinate behavior. The static "Location Sharing Off" notice
is not a precise location label. captured_at may remain an internal ordering
timestamp after re-enable, without a visible coordinate tuple/pipeline; OFF family
responses suppress capture timestamps. coordinate_captured_at remains cleared
until a fresh displayed coordinate is accepted.

## Real write boundary and deterministic tests

There is no independent delayed pipeline insert: pipeline, coordinates and
server write timestamp share the existing consent-generation + timestamp CAS.
Tests pause that actual update_one BEFORE predicate evaluation, withdraw through
real update_my_preferences(), then release the update. Both withdrawal and
OFF -> ON reject the stale request without replacing retained private metadata.
This is an offline predicate-enforcing model, NOT real MongoDB concurrency proof.

40 new tests in backend/tests/test_location_pipeline_consent.py passed:

- Both member endpoints: real accepted upload -> real OFF -> entire response
  inspection, arbitrary nested private evidence absent, stored diagnostics intact.
- Both endpoints: linked self retains own OFF diagnostics; creator/group owner
  does not acquire self access.
- Six OFF -> ON cases (missing/zero/BSON Int64 initial generation, both endpoints):
  old pipeline cannot revive; fresh upload restores current trace and live tuple.
- Four real guarded-write races (OFF or OFF -> ON, both endpoints).
- Six post-geocode family races (OFF, OFF -> ON, relinking, both endpoints).
- Two post-geocode self relink races; two family-move response denials.
- Five nonaffirmative authority cases; five unverified/foreign trace-scope cases,
  including legacy self-only evidence and explicit foreign-subject exclusion.
- Unrelated-family and no-token HTTP checks for both member endpoints.
- Owner-assisted upload response while OFF, and accepted upload delayed before
  response until after withdrawal: truthful acceptance receipt, no GPS disclosure.

One directly required existing stationary-battery test double now supplies the
additional final family-response authority read. Assertions and test count are
unchanged. Initial isolated device-presence/stationary fixture exhaustion exposed
redundant rereads; final code reuses existing post-presence/full rereads where
they already form the last await. Final isolated presence/stationary runs passed.

## Verification on the corrected source

Focused backend command:

```text
python -m pytest -q --disable-warnings
 backend/tests/test_location_pipeline_consent.py
 backend/tests/test_location_history_consent.py
 backend/tests/test_self_member_consent_creation.py
 backend/tests/test_family_member_removal.py
 backend/tests/test_startup_sync_consent_race.py
 backend/tests/test_startup_repair_consent_race.py
 backend/tests/test_checkin_location_consent.py
 backend/tests/test_location_consent_write_race.py
 backend/tests/test_task123_welfare_check.py
 backend/tests/test_coordinate_capture_integrity.py
 backend/tests/test_task101_location_name_persistence.py
```

**205 passed**, exit 0: 40 pipeline + 32 history + previous 133 focused tests.
The sixteen additional isolated files enumerated above also passed, **192 total**
(11 device-presence and 3 stationary tests included). Excluding repeated files:
**386 distinct isolated backend tests across 24 files**.

Prior regression counts remain: self-member 32; startup heal 22; startup sync 26;
upload 11; check-in/welfare privacy 25; additional welfare 6; family removal 3;
coordinate tuple 6; geocoded label persistence 2; medication reliability 34.
History's exact-lifetime/final-read/immutable-tag/legacy-self/TTL tests all passed.
No history API or retention code changed.

Frontend:

```text
cd frontend && npm test -- --runInBand --forceExit
 trackingRevocationAuthority androidTrackingRecovery androidLocationPublication
 trackingReliabilityHardening missedCheckinReturnButton pushMedicationReliability
 sosPermissionRegression medicationAcknowledgment medicationAcknowledgeModal
 medicationNotificationRoute
```

**268 passed / 10 suites**, exit 0: 207 B1/location + 44 medication/check-in +
17 SOS/routing. Existing Jest open-handle warning remains; no cleanup attempted.
Python compilation and git diff --check passed. Public preview renders the
disclaimer; signed-in UI/native behavior not visually verified.

Full backend **UNVERIFIED**. Previous combined 19 passed / 3 legacy event-loop
failures was not rerun or converted into a full PASS. Native compilation, Android
build, physical acceptance and process-death validation not performed.
Real MongoDB concurrency and Android process-death remain deferred, unstarted.
No merge, Railway deployment, production mutation, OTA, Android build/release or
Play submission performed. The read-only diagnostic disclosure audit follows
commit/push; its actual verdict must be returned before ending this run.

## Post-push diagnostic disclosure audit: RED / STOP

The pipeline correction was committed/pushed first. A read-only source inventory
and offline replay then confirmed a NEW independent Critical disclosure:
GET /diagnostics/refresh-traces returns gps_lat/gps_lon to another family account
after the target's real sharing withdrawal. This path was NOT changed.

### Diagnostic storage / reader inventory

| Candidate/storage | Precise data and retention | Reader / authority / assessment |
|---|---|---|
| members.location_pipeline | Native/stored coordinates; latest member snapshot, no separate TTL; private evidence retained | Ordinary member GET/list, profile/battery/check-in-settings and location responses now use shared final privacy fence. Linked self distinct from roles. Family exact current generation/subject required; whole object denied otherwise. Corrected and tested. |
| location_history | Precise accepted GPS evidence; configured 7-day accepted_at TTL | Existing history API unchanged: exact current family lifetime and final authority recheck; linked-self legacy/prior evidence retained. 32 regressions passed; replay confirmed family denial after OFF. |
| location_ingest_log | Raw precise diagnostic coordinates; configured 24h at TTL | No ordinary family API reader found in targeted source inventory. Admin/reset/retention operations and internal logs are not ordinary-family disclosure. Not a release blocker merely because it stores GPS. |
| _REFRESH_TRACE_LOG | gps_lat/gps_lon; process-local deque maxlen=200, no time TTL, lost on restart/eviction | diagnostics_refresh_traces admits trace requester OR any current family member. No current-sharing check, no original subject/generation, no linked-self distinction. CONFIRMED Critical while OFF. |
| diagnostics_my_members | Explicit latitude/longitude/name on rows queried by user_id=current.id | Authenticated linked-self diagnostic projection, not arbitrary family rows. No ordinary-family GPS reader found for this projection; private own diagnostics are not automatically a blocker. No blanket lifecycle/race clearance after STOP. |
| diagnostics_family_snapshot / members.device_snapshot | Projection omits root latitude/longitude/name/pipeline; declared snapshot contract is stage ages, times, SDK/device status. Stored extra fields are allowed and returned as a raw nested bag; latest snapshot, no separate TTL | Same-family reader, no sharing/generation/self distinction. Declared health/time fields do not establish precise geography. Unknown/legacy extra payload exposure remains NOT fully adjudicated at STOP, not asserted harmless or invented as a confirmed second blocker. |
| diagnostics_health | Geocoding enabled/healthy/key-present booleans and key-source NAME, not secret value or GPS | Authenticated health reader; no coordinate disclosure. Not a GPS privacy blocker. |
| Backend GPS logs / generic geocode cache | Coordinate logging and generic coordinate/address cache | No ordinary family log/cache API found in targeted inventory. Privileged operational evidence is not automatically family-public. |
| Client pipeline/local diagnostic snapshots | May contain own GPS and previously authorized family pipeline copies on the viewing device | Local Diagnostics/Copy Log, not a new server API reader for another member's hidden data. Retaining an already-received authorized copy is not proof of a fresh OFF-state server disclosure; no diagnostic redesign or deletion done. |
| Explicit SOS/emergency alerts | Emergency precise-location workflow | Classified separately from ordinary sharing; semantics untouched. Remaining emergency review is not cleared by this targeted audit. |

This is the inventory reached by the focused diagnostic search, NOT a claim that
every candidate or the broader source review cleared. Review stops on the first
corroborated independent Critical path. Legacy check-in/welfare reader assessment
also remains incomplete from the preceding review.

### Confirmed refresh-trace blocker

Exact active source:

- _trace_record_request(): creates member/requester trace with empty GPS fields.
- update_member_location(): calls _trace_record_gps() after ingest/history awaits.
- _trace_record_gps(): writes full-precision gps_lat/gps_lon to a pending trace.
- diagnostics_refresh_traces(): returns **entry to requester or another current
  family member, without target sharing or consent-lifetime verification.

Realistic sequence (race NOT required):

1. Sharing ON; a legitimate refresh creates a pending trace.
2. Target's accepted upload fills that trace with precise GPS.
3. Target turns sharing OFF through real update_my_preferences().
4. Root tuple is cleared; corrected member endpoints hide retained pipeline;
   history API returns no records to another family account.
5. Another same-family account reads /diagnostics/refresh-traces.
6. It receives the retained gps_lat/gps_lon anyway.

Offline replay used the actual committed recorder, upload, preference endpoint
and diagnostic reader. The DB cursor enforced the family predicate and projected
fields; the viewer was neither linked self nor the trace requester. Assertions
confirmed sharing OFF, denied pipeline on BOTH member endpoints, empty family
history, and precise trace coordinates in the complete JSON-serializable response.
No production/database/network action was involved in this replay.

Violated invariant: OFF forbids ordinary precise GPS disclosure to OTHER family
accounts, including diagnostic/history copies. Being the refresh requester is
also not ownership of another person's coordinates.

Provenance: the supplied base already contains the GPS recorder and the same
requester/family reader rule. This predates PR #166 and the pipeline correction.

Smallest conceptual correction, requiring separate authorization: keep useful
timings/status, but do not expose precise trace GPS to non-self without exact
current subject/consent-lifetime authority. Either omit precise fields for
non-self diagnostic readers if product behavior permits, or bind immutable
original GPS authority and revalidate it at disclosure. Never guess ownership
from requester_user_id or retroactively authorize legacy GPS after OFF -> ON.
Do not merely clear the member tuple or delete the entire trace buffer.

Required deterministic regression: actual trace request + accepted upload ->
real OFF -> diagnostic read by a DIFFERENT family account/non-requester; inspect
the entire response for coordinates/aliases. Also cover requester-not-self,
explicit linked-self diagnostics if retained, OFF -> ON stale work and fresh
valid behavior, delayed recorder/write boundaries, and changed family authority.

### Final audit / stopping point

**RED — NEW RELEASE BLOCKER FOUND.**
Diagnostic disclosure audit NOT CLEARED. No refresh-trace source was fixed.
Broader review did not resume after confirmation. Next authorized review boundary
is refresh-trace privacy, then remaining diagnostic snapshots/legacy readers,
followed by native lifecycle/authorization/FGS/recovery, medication/SOS/iOS,
native static correctness, cumulative scope and incident replay.

No compile/build, physical validation, real MongoDB concurrency or Android
process-death validation started. No merge, Railway deployment, production
mutation, OTA, Android release/build or Google Play submission occurred.

---

# Refresh-trace GPS privacy correction

## Root cause and exact correction

diagnostics_refresh_traces previously returned **entry to either the requester
or a member of the target's family. That conflated permission to inspect refresh
status with ownership/current authority for precise GPS. The buffer retained
coordinates after withdrawal and had no immutable subject/consent lifetime.

The actual upload now passes its ORIGINAL linked subject, family, consent
generation and accepted-publication result to _trace_record_gps(). This recorder
still preserves GPS receipt evidence, but never obtains newer authority from a
member read after the ingest/history awaits. Rejected publication cannot authorize
family GPS. The existing 200-entry process-local ring and 90-second pending
correlation window are unchanged; no data deletion or retention redesign.

Reader behavior:

- Snapshot trace evidence before authority awaits.
- Recheck the caller's current family relationship in users.
- Fetch authoritative linked member identities, sharing and generations AFTER
  that await, then serialize with no further I/O.
- Preserve safe status for a requester even without current family GPS access.
- Preserve safe family status for currently related members.
- Precise family GPS requires accepted original publication, verified original
  subject/family/generation, current affirmative sharing and an exact lifetime match.
- Explicit linked self can inspect own attributed diagnostic GPS while OFF,
  including private rejected/stale work. Role, creator and requester are not self.
- Unattributed legacy GPS is redacted even for a current self/requester because
  original ownership cannot safely be established. Safe legacy status remains.
- Serialize an explicit safe field list, not arbitrary **entry payloads.
  Unknown nested bags, coordinate aliases, native/provider data, map URLs and
  precise labels cannot bypass gps_lat/gps_lon denial. Internal authority tags
  are not returned.

Safe timing/status fields remain: member/request/requester identifiers, requested
time, push-sent time, push-skipped reason, GPS-received time, computed push/GPS
deltas. Current legitimate GPS visibility continues under current authority.
No refresh dispatch/throttle, SOS or native/frontend behavior was modified.

## Real delayed recording boundary

The recorder is synchronous, but runs AFTER asynchronous ingest/history work.
An upload can pass its live CAS, pause there, then record GPS after withdrawal or
OFF -> ON. Four tests pause the REAL history/ingest boundaries immediately before
this recorder, perform real update_my_preferences(), then release old work.
Old generation metadata is retained immutably and family GPS remains denied.
This is not a fabricated await inside the synchronous recorder.

## Deterministic verification

32 new backend/tests/test_refresh_trace_consent.py cases passed through actual
request_location_refresh(), upload, preferences, recorder and reader:

- Real request path, accepted upload and withdrawal: non-requester family viewer
  AND original requester lose GPS, retain status/timing.
- Linked self retains attributed private GPS while creator/group owner does not.
- Missing/zero and BSON Int64 starting generations: OFF -> ON does not revive
  old GPS; a fresh operation restores current authorized behavior.
- Four delayed-recording races at two real boundaries, OFF or OFF -> ON.
- Rejected live write cannot grant family trace authority.
- Unattributed legacy traces fail closed for family and current self, not status.
- Invalid generations and foreign/relinked subjects cannot grant GPS.
- Five asynchronous reader changes: OFF, OFF -> ON, relinking, member family move,
  and viewer family movement.
- Former-family requester retains safe status only; unrelated/missing/no-token
  requesters denied as appropriate.
- Entire JSON response checked for arbitrary precise aliases, nested payloads,
  private labels and map URLs; allowlist protects even self from unknown bags.
- Limit/filter/newest-first/pending traces and safe failure/completion timing work.

Requests use the real no-push-token branch (sent_to=0, no_tokens trace status);
no external push service is contacted. These tests do not claim device delivery.

Focused command:

```text
python -m pytest -q --disable-warnings
 backend/tests/test_refresh_trace_consent.py
 backend/tests/test_location_pipeline_consent.py
 backend/tests/test_location_history_consent.py
 backend/tests/test_self_member_consent_creation.py
 backend/tests/test_family_member_removal.py
 backend/tests/test_startup_sync_consent_race.py
 backend/tests/test_startup_repair_consent_race.py
 backend/tests/test_checkin_location_consent.py
 backend/tests/test_location_consent_write_race.py
 backend/tests/test_task123_welfare_check.py
 backend/tests/test_coordinate_capture_integrity.py
 backend/tests/test_task101_location_name_persistence.py
```

**237 passed**, exit 0: new 32 + previous focused 205.
The same sixteen additional isolated files enumerated in prior supplements also
passed: **192**, all exit 0. Excluding repeated files, **418 distinct isolated
backend tests across 25 files**.

Unchanged passing counts: pipeline 40, history 32, self-member 32, startup heal
22, startup sync 26, upload 11, check-in/welfare privacy 25, additional welfare 6,
family removal 3, coordinate tuple 6, label persistence 2, presence 11, stationary
battery 3, backend medication reliability 34.

Frontend command, unchanged ten patterns:

```text
cd frontend && npm test -- --runInBand --forceExit
 trackingRevocationAuthority androidTrackingRecovery androidLocationPublication
 trackingReliabilityHardening missedCheckinReturnButton pushMedicationReliability
 sosPermissionRegression medicationAcknowledgment medicationAcknowledgeModal
 medicationNotificationRoute
```

**268 passed / 10 suites**, exit 0: 207 B1/location + 44 medication/check-in +
17 SOS/routing. Existing open-handle warning remains; no unrelated cleanup.
Python compilation and git diff --check passed. Public disclaimer renders;
signed-in UI/native behavior not visually verified.

Full backend **UNVERIFIED**. Previous combined evidence remains 19 passed /
3 legacy event-loop failures; combined run not repeated. No integration test
known to create external accounts/data was run. Offline predicate models are NOT
live MongoDB proof. Real MongoDB concurrency and Android process-death validation
remain deferred, unstarted. No merge, deployment, production mutation, OTA,
Android compile/build/release, physical acceptance or Play submission performed.

After commit/push, adjudicate the family-snapshot extra bag through actual valid
input/write and family-read functions, then return the actual diagnostic verdict.

## Post-push related diagnostic audit: RED / STOP

The refresh-trace correction was committed/pushed before this audit. The
previously unresolved family-snapshot bag has now been ADJUDICATED, not left as
an open hypothesis: valid authenticated snapshot input can persist nested precise
GPS and the real family reader returns it after real sharing withdrawal.
No snapshot source was changed under refresh-trace authorization.

### Exact independent blocker

Severity: **Critical**, API-level ordinary-location privacy disclosure.
Confidence high in the API behavior; production occurrence/client prevalence
was NOT measured or asserted.

Active backend/server.py:

- DeviceSnapshotUpdate: ConfigDict(extra="allow").
- put_device_snapshot(): linked-self writer stores data.model_dump(exclude_unset=True)
  verbatim as members.device_snapshot. The family/linked-self write predicate
  properly prevents writing another person's snapshot, but does not constrain the
  contents of this caller's legitimate own diagnostic payload.
- diagnostics_family_snapshot(): family-authorized projection omits root GPS,
  but returns the retained device_snapshot bag including unknown nested fields.
- update_my_preferences(): OFF clears ordinary root coordinates, not this bag.

Realistic supported-input sequence:

1. Target's device submits its own diagnostic snapshot while sharing ON. A valid
   accepted extra field contains native_location.coords latitude/longitude plus
   diagnostic label/map URL. This uses the real Pydantic model and own-device PUT,
   not raw database seeding or a caregiver writing someone else's data.
2. Target withdraws sharing through real update_my_preferences().
3. Root tuple clears and generation advances. Stored diagnostic bag is unchanged.
4. A different authenticated family viewer reads diagnostics_family_snapshot().
5. Entire nested GPS, private label and map URL are returned.

The offline replay asserted precise values in the stored bag, real OFF state,
unchanged retained snapshot, viewer != subject and viewer != creator, and all
precise coordinates/label/map URL in the JSON-serializable family response.
No external service, real DB, production action, push, or native runtime involved.

Important limit: the checked-in locationEngine.ts pushDeviceSnapshotToBackend()
builds a fixed health/timing payload and does NOT currently include these GPS
extras. We do NOT claim this publisher automatically emits the enriched payload,
or that production contains it. The finding is the existing API contract's
accepted coordinate-bearing diagnostic input and subsequent unauthorized reader,
including retained input from compatible diagnostic/older/future clients.
This is a real write/read route, not an invented coordinate in an internal store
with no family reader.

Control replay then submitted only declared stage-age/SDK/timestamp fields,
through the same actual writer while OFF. The family reader returned useful
health metrics with NONE of the private GPS/label/map strings. Health/timing
fields themselves are NOT classified as precise location or release blockers.

Violated invariant: withdrawing ordinary location sharing prevents another family
account from retrieving retained precise location through diagnostic nested bags.
The subject having previously uploaded private diagnostics while ON is not
indefinite family-publication authority.

Provenance: supplied base already contains extra="allow", verbatim snapshot
storage, and the raw family-snapshot reader. Predates PR #166 and this correction.

Smallest conceptual correction REQUIRING SEPARATE AUTHORIZATION:

- Return a deliberate safe health/timing schema for family snapshot readers,
  rather than arbitrary retained extras; protect EXISTING bags as well as future
  writes. A new-write-only unknown-field filter is insufficient.
- Constrain supported future snapshot input where appropriate, without breaking
  stage ages, SDK state, string tracking mode, device identity or presence.
- Do not delete diagnostics wholesale. Any retained raw self-only data must be
  distinguished by linked subject identity, never caregiver/requester/creator.
- If precise diagnostic fields intentionally become a family feature, require
  original subject/current exact lifetime authority instead of raw bag forwarding.

Required regression: actual own-device PUT with valid extra nested native GPS
while ON -> actual OFF -> family-snapshot read by a DIFFERENT account; inspect
all JSON for coordinates, aliases, private labels and map URLs. Also cover
retained legacy extras, OFF -> ON, safe fixed-field health snapshots, authentication/
family isolation, self distinction if preserved, tracking-mode and comparison UI
compatibility. No broad snapshot redesign or production cleanup authorized here.

### Related response inventory / actual verdict

| Surface | Precise data / reader / assessment |
|---|---|
| diagnostics_refresh_traces | Corrected: safe status distinct from exact-lifetime family GPS or attributed linked-self GPS. Legacy GPS private/unattributed denied. 32 new cases passed. |
| diagnostics_family_snapshot | CONFIRMED independent Critical via accepted retained device_snapshot extras; root projection alone is insufficient. No sharing/lifetime/self fence on nested bag. STOP, not fixed. |
| Normal member/pipeline responses | Existing whole-pipeline subject/generation/final-authority fence unchanged; 40 regressions passed. Fresh valid behavior and linked self preserved. |
| location-history API | Exact current family lifetime and final check unchanged; 32 regressions passed, retention untouched. |
| diagnostics_my_members | Explicit user_id=self query, not arbitrary-family data. No new family disclosure established for this self projection; not called a blocker merely for own GPS. |
| diagnostics_health | Health/key-source-name flags, no GPS or secret value. No precise-location disclosure. |
| location_ingest_log / server logs / geocode cache | No ordinary family reader established in targeted inventory; internal coordinate retention alone is not a blocker. |
| Client-local diagnostic copies | Local storage or already-authorized received data, not proof of a new OFF-state server disclosure. No new blocker inferred. |
| SOS/emergency | Separate intentional semantics; untouched. No mechanical ordinary-sharing rule imposed on emergency data. |

**RED — NEW RELEASE BLOCKER FOUND.**
Family-readable diagnostic location audit NOT CLEARED. Family-snapshot bag concern
is explicitly confirmed at the API level, with the current-publisher limitation
above. No further independent source search or automatic snapshot fix.

Broader review did not resume after this confirmation. Resume first at snapshot
response privacy, then any remaining related readers/legacy check-in history,
then outstanding native lifecycle, authority, FGS/recovery, medication/SOS/iOS,
native static correctness, cumulative scope and incident replay.

Real MongoDB concurrency, Android process-death/across-runtime, Android compile/
build and physical acceptance remain deferred/unstarted or unverified as applicable.
No merge, Railway deployment, production mutation, OTA, Android build/release
or Google Play submission occurred.

---

# Family device-snapshot privacy correction

The confirmed extra-bag disclosure is corrected narrowly in backend/server.py.
The original server contract accepted arbitrary coordinate-bearing extras and
forwarded the retained device_snapshot verbatim to another family reader.
Confidence in cause and repair is high at the API boundary. No claim is made
that the current fixed-field frontend publisher emits GPS, or that production
contains such snapshots.

## Deliberate read schema and compatible write strategy

_family_device_snapshot() explicitly permits only these 18 health fields:

```text
at stored_at device_model ota_update_id ota_channel app_state
listeners_attached sdk_enabled sdk_is_moving sdk_tracking_mode
activity_age_ms motion_age_ms location_age_ms hb_js_age_ms
hl_inv_age_ms hl_hb_age_ms http_att_age_ms http_ok_age_ms
```

String, boolean, and finite numeric fields are type-checked; arbitrary nested
objects/lists cannot be hidden under an allowlisted scalar key. Null retains
its meaning. BSON timestamp datetimes normalize to UTC without mutating storage.
Invalid fields are omitted individually rather than losing the whole useful
snapshot. Non-object legacy snapshots become null.

diagnostics_family_snapshot() ALWAYS applies this projection, including while
ON and for the linked self. It is a shared family-health endpoint, not an
explicit raw-self endpoint. No new raw-self exception or role-based privilege
was introduced. Existing distinct self-diagnostic APIs remain unchanged.

DeviceSnapshotUpdate now ignores unknown input fields rather than accepting/
persisting them. This preserves successful writes by older/future callers that
include extras, rather than introducing an extra-field 422. All fields emitted
by the current checked-in publisher remain supported, including string tracking
mode, explicit nulls, timestamps and all eight stage ages.

Read-side protection is independent of input filtering: existing retained bags
are safely projected without deletion or mutation. No withdrawal cleanup,
retention changes, generation backfill or raw diagnostic redesign.

## Deterministic evidence

51 new backend/tests/test_family_snapshot_privacy.py cases:

- Actual DeviceSnapshotUpdate -> put_device_snapshot -> actual preference OFF ->
  actual different-account family reader. Safe fields persist; unknown nested
  native coordinates, aliases, labels, URLs and provider/pipeline data do not.
- Legacy pre-correction stored representation tested with sharing ON, OFF and
  OFF -> ON, against family viewer, linked self and creator/group owner.
  Storage is unchanged; every family response is safe.
- Actual current publisher field shape writes/reads while ON and OFF, retaining
  all supported metrics, battery/movement/GPS-quality and contact-age context.
- Missing, zero and BSON Int64 generations: old extras cannot revive; fresh
  safe replacement works.
- All 18 allowlisted keys tested with a nested private object in place of their
  declared scalar value. The poisoned field is omitted, others preserved.
- Non-object bags, invalid/nonfinite numeric ages, BSON timestamps, partial old
  clients, explicit nulls and absent snapshots.
- Unrelated family sees no target; caregiver cannot write target telemetry;
  wrong-family writer denied; both HTTP endpoints require authentication.
- Assertions inspect the COMPLETE JSON response and independently enumerate
  allowed keys/scalar shapes, not just a GPS-name blacklist.

## Verification at correction

Focused command: prior twelve focused backend files PLUS
backend/tests/test_family_snapshot_privacy.py.
**288 passed**, exit 0 = prior 237 + new 51.

The same sixteen additional isolated files enumerated previously:
**192 passed**, each successful exit 0. The first batch exceeded its shell time
budget after eleven files; only the unfinished five were resumed, not a
redundant rerun of passing files.

Deduplicated total: **469 distinct backend tests / 26 files**.
Preserved counts: refresh traces 32, pipeline 40, history 32, self creation 32,
startup heal/sync 22/26, upload 11, check-in/welfare 25 plus additional welfare 6,
family removal 3, coordinate tuple/label 6/2, presence 11, stationary battery 3,
backend medication reliability 34.

Compilation and git diff --check passed. Full backend remains UNVERIFIED.
Previous combined evidence remains 19 passed / 3 legacy loop failures; combined
backend and real-service integration tests were not rerun.

Frontend command: prior ten patterns PLUS deviceComparison:

```text
cd frontend && npm test -- --runInBand --forceExit
 trackingRevocationAuthority androidTrackingRecovery androidLocationPublication
 trackingReliabilityHardening missedCheckinReturnButton pushMedicationReliability
 sosPermissionRegression medicationAcknowledgment medicationAcknowledgeModal
 medicationNotificationRoute deviceComparison
```

Initial invocation hit its shell time budget. Completed background invocation:
**292 passed / 3 failed, 11 suites passed / 1 failed, 295 total**, exit 1.
Failures were in pushMedicationReliability.test.ts: two mocked listener arrays
were empty after un-awaited renderer creation plus 10ms sleeps, and one timed
queue-drain assertion saw 11 rather than 21. A teardown/late-require warning
also appeared.

Isolated --runTestsByPath src/__tests__/pushMedicationReliability.test.ts:
**15 passed / 2 failed / 17 total**, exit 1. Queue drain passed; the two
callback-not-a-function assertions remained. No frontend source/test/config
changed from starting HEAD; no independent repair or repeated retry loop.
This is NOT a fully green frontend run and NOT the earlier 268-pass claim.
Across completed runs, 293 distinct cases passed and two remain failing.
B1/location 207 passed; SOS/routing 17 passed; Device Comparison 27 passed.
Medication/check-in: combined 41 passed / 3 failed, isolated evidence improves
one of those failures; two remain unresolved. These test-harness failures do
not by themselves establish a new production Critical/High defect.

No live MongoDB concurrency or Android process-death validation, Android build/
compile, physical acceptance, merge, Railway deployment, production mutation,
OTA or Play submission occurred. Read-only diagnostic audit follows commit/push;
its actual verdict is recorded separately, not assumed from test success.

## Post-push family-readable diagnostic audit: CLEARED

The narrow correction was pushed as ef00d26748470c58e87a71a4c90b97227b038f03
before continuing this read-only audit. Remote ref independently matched after
a notebook capture reset; no blind second ref write or force-push.

The active backend's diagnostic GET routes and equivalent location projections
were inventoried, including additional router registration in family_group.py.
No additional ordinary-family diagnostic GPS reader was established:

| Writer/storage -> reader | Authority / precise payload / verdict |
|---|---|
| DeviceSnapshotUpdate -> members.device_snapshot -> diagnostics_family_snapshot | New input ignores extras; existing raw bags always get the explicit scalar health schema. ON is not raw-extra permission. Corrected, 51 tests. |
| Accepted/private GPS recorder -> process trace ring -> diagnostics_refresh_traces | Status separate from GPS. Original subject/family/generation and accepted publication plus final current authority required for family GPS; attributed linked self distinct. 32 preserved tests. |
| Coordinate upload -> members.location_pipeline -> ordinary member list/single and write receipt | Whole-object family fence plus exact subject/generation/final authority; no raw arbitrary pipeline escape. 40 preserved tests. |
| Coordinate upload -> location_history -> location-history API | Exact lifetime and final authority; legacy/private self distinction retained. 32 preserved tests. |
| Member roots -> diagnostics_my_members | Explicit authenticated user_id=self query. Own coordinates can be diagnostic evidence, not arbitrary-family disclosure. No raw device snapshot forwarded. |
| Geocoding configuration -> diagnostics_health | Boolean health/key-presence and key-source NAME only, not GPS or credential value. |
| Ingest/native/provider evidence -> location_ingest_log, server logs, geocode cache | Internal retained coordinates, but no ordinary family-facing reader established in active routes. Storage alone is not a release blocker. |
| Family membership -> family-group public projections | Deliberate account/group fields, not raw member location/diagnostic bags. |
| Medication history/summary projections | Counts, compliance, receipt/contact times and operational details, not raw check-in GPS payloads. Distinct check-in readers reviewed next. |
| Client-local diagnostic/cached copies | Not a new OFF-state server disclosure by themselves; no claim that retained local data can be retroactively revoked. |
| SOS/emergency evidence -> incident/alert flows | Separate intentionally authorized emergency semantics, untouched. No mechanical ordinary-sharing rule imposed. |

**FAMILY-READABLE DIAGNOSTIC LOCATION AUDIT CLEARED.**
This is the targeted diagnostic/metadata audit, not a claim that the entire
family API or full Critical/High source review is clear.

## Next boundary: legacy check-in readers — CONFIRMED Critical / STOP

**RED — NEW RELEASE BLOCKER FOUND.**

Current location-free check-in/welfare writes protect new receipts but retained
old check-ins still have two real ordinary-family readers with no current
location-sharing/lifetime redaction:

- backend/server.py list_member_checkins(), GET /api/checkins/member/{member_id}:
  query scopes family/member, then returns CheckIn(**d).
- list_recent_checkins(), GET /api/checkins/recent:
  query scopes family/current local day, then returns CheckIn(**d).

CheckIn explicitly serializes latitude, longitude and location_name.
Thus response-model validation does NOT remove these precise fields.

### Actual deterministic reproduction, not a hypothetical retained record

An offline replay AST-loaded the exact create_checkin function body from the
supplied base (decorator removed solely to avoid registering an old route), using
the compatible current model and predicate-enforcing CheckinHarness. DB/push
services were isolated; neither production nor MongoDB was contacted.

1. Linked subject sharing ON calls that actual pre-PR writer with valid precise
   coordinates and a precise location label.
2. Real legacy writer inserts the actual CheckIn receipt in db.checkins.
3. Current update_my_preferences() performs actual OFF. Root location clears and
   current generation advances. Saved check-in remains unchanged.
4. A DIFFERENT current family principal calls each current reader above.
5. Both JSON-model-serialized responses retain the exact latitude, longitude and
   precise location_name from that record.
6. Unrelated-family control returns no record, proving this is same-family
   field-level disclosure rather than a mock that ignores tenant predicates.

The storage was produced by the real old writer, NOT manually seeded. This
reproduces retained data that is genuinely accepted by the supplied production
base. Production prevalence was not measured. No claim is made that the newly
corrected current writer emits location-bearing receipts.

Violated invariant: another family account must not obtain retained ordinary
precise location after current withdrawal through check-in history/recent APIs.
Non-location check-in success, time, source and confirmation remain legitimate.

Provenance: base already has that coordinate-bearing writer and the two
unredacted readers. The PR's new-write privacy correction did not sanitize
those readers. It predates this snapshot correction.

Confidence HIGH: actual old write -> actual current OFF -> both actual current
readers, with exact complete serialized coordinate/label assertions.

Welfare assessment reached: current daily/welfare receipts are location-free,
and both daily/welfare history use the shared CheckIn storage/read model.
The executed legacy reproduction used the daily writer; a separate old welfare
writer was not executed or claimed after the stop condition was established.

### Smallest conceptual correction — separate approval required

Protect existing retained records at BOTH family read paths. Prefer an explicit
non-location family receipt projection that preserves check-in history, times,
source and confirmation while withholding ordinary precise coordinates/labels
from other family accounts. Any self-only historical detail needs verified
linked subject identity, not role/creator/requester privileges.

Do not delete receipt history, change SOS semantics, or backfill old records with
a new consent generation. Fixing only future writes is already known insufficient.

Required deterministic regression: reproduce a legacy daily/welfare record with
valid precise data, call actual OFF, then inspect complete JSON from both readers
as another family account. Cover ON/OFF/OFF->ON legacy handling, safe fresh
location-free receipts, useful status/time/source preservation, linked-self
semantics if explicitly retained, unrelated-family/authentication, and final
authority boundaries if any family precise-history exception is retained.

No check-in reader, historical store, or other independent source was changed.
Review STOPPED immediately after confirming this path; no further independent
source investigation or automatic repair.

## Actual final review/validation boundary

The family-snapshot blocker is fixed and the targeted family-readable diagnostic
location audit is clear. Overall verdict is RED because retained legacy check-in
coordinates/labels are still disclosed by ordinary family readers.

Next review boundary after a separately approved repair: finish remaining
legacy request/history readers, remaining location writers/readers, native
lifecycle/authorization, FGS/recovery, native static correctness,
medication/SOS/iOS, cumulative scope and original incident replay.
Do not infer completion of those areas from the snapshot tests.

Frontend's two isolated notification-listener readiness failures remain unresolved
verification concerns, not silently converted into passes or a production defect.
Existing open handles/--forceExit, legacy backend loop failures and unchanged
diagnostics UI copy are non-blocking debt absent an actual Critical/High path.

Web preview was restored and the public disclaimer rendered after an initial
capture disconnect; no frontend/code/config workaround was introduced.
Signed-in Diagnostics UI was NOT visually verified. Offline endpoint/schema and
27 Device Comparison frontend tests are not physical-device validation.

No real MongoDB concurrency or Android process-death/across-runtime validation
started. No Android compile/build or physical acceptance occurred.
No merge, Railway deployment, production mutation, OTA, Android release or
Google Play submission occurred.

## Current-run final adjudication supplement

No completed snapshot work was redone, no suggested task started, and no new
application/test source correction was made. The legacy disclosure already
reproduced above remains **Critical / confirmed**, so broader review stays stopped.

### Legacy sharing, lifetime, race and retention

The two current readers scope family/member or family/day and serialize
CheckIn(**d). Neither reads the target's current sharing state nor checks its
consent lifetime/generation before returning retained latitude/longitude and
location_name. A DIFFERENT family principal received them after actual OFF.

No race is required: write while ON, complete withdrawal, then ordinary read.
The real old writer body came from supplied committed base
247c93ffa4ec8a3406de8bacb2ba99b7542a7c19, not fabricated storage.
Current writers being location-free does not remove old records.

The committed TTL configuration retains checkins for 90 days after created_at.
Member history returns up to 100 rows; recent returns up to 200 from the current
local day. A recent legitimate legacy receipt is within these normal windows.
Actual production indexes/prevalence were not queried. The reproduction confirmed
that withdrawal leaves the saved receipt unchanged. Waiting for TTL expiration
is not read authorization and does not close the immediate disclosure.

### Medication test classification: B — TEST-HARNESS / TIMING FLAKINESS

Exact isolated failures:

- does not enqueue or consume a tap when pending storage fails:
  callbacks[0] is not a function.
- replays a pending record after a crash before enqueue/flush:
  callbackHandlers[0] is not a function.

These exceptions occur BEFORE the mocked response invokes the production
handler. Both tests use create() outside awaited act(), then assume a 10ms sleep
committed effects. Source inspection shows response-subscription registration
is synchronous inside the hook effect; async durable replay is launched
separately, not awaited before subscription. Elapsed 10ms is not a React
effect/subscription readiness guarantee.

Controlled experiment outside the repository:

- Generated two temporary copies of the existing 17-case file. Relative module
  paths were redirected to the unchanged checked-in source, with identical
  production code, mocks, inputs and semantic assertions.
- Control retained fixed-delay mounts; the variant changed only three mount
  sites in the two failing cases to awaited act(), used the existing bounded
  readiness helper, and waited for observable replay completion.
- Two-case comparison: 4 passed, 30 skipped, exit 0.
- Full comparison: control 17/17 passed, readiness variant 17/17 passed;
  34 passed total, exit 0.
- Both variants recorded one response subscription, one received subscription
  and two storage reads before invoking each tested callback.
- Generated inputs, source digest and logs remain in
  /tmp/pr166-medication-adjudication.EKE3OA; not committed or counted as new tests.
- Tracked frontend source/test/config remained byte-for-byte unchanged.

The fixed-delay control itself passing on another execution supports
intermittent scheduling/readiness, not a deterministic production failure.
Together with the failure location before handler dispatch and the passing
effect-ready semantic checks, confidence in classification B for these observed
exceptions is high. This does NOT certify all medication/native delivery paths.
No production medication code or checked-in test was changed.

Historical results are NOT replaced:
combined 292 passed / 3 failed / 295, isolated 15 passed / 2 failed / 17.
The queue-drain failure had already passed in isolation; it also passes in both
full temporary copies. The original combined command is NOT called all-pass.
Temporary duplicate cases do not increase the 295 distinct frontend denominator.

### Actual final verdict

**RED — NEW RELEASE BLOCKER FOUND.**
Family-snapshot correction remains verified. **FAMILY-READABLE DIAGNOSTIC
LOCATION AUDIT CLEARED.** Retained legacy check-in location disclosure remains
confirmed and UNFIXED. Medication's observed test failures are classified B,
not a newly established production regression.

Backend evidence remains 51 new snapshot, 288 focused, 469 distinct isolated/
26 files; full backend remains UNVERIFIED. No source changed that invalidates
those passing checks. Static compilation/diff checks remain as recorded.
Remaining source-review boundary and all prohibited/deferred actions are
unchanged. No real MongoDB or Android validation, build, merge, deployment,
production mutation, OTA, release or Play submission was started.

---

# Legacy check-in history reader correction

## Evidence, severity, and narrow correction

Critical ordinary-location privacy defect, high confidence. The exact supplied
base writer persisted latitude, longitude and a precise location_name in
db.checkins. Real withdrawal cleared the member but neither family history
reader redacted the retained receipt. No race was necessary.

Both list_member_checkins and list_recent_checkins now call the same deliberate
safe projection. Only id, owner_id, family_group_id, member_id, member_name,
confirmed_by, source and created_at are copied from storage. CheckIn retains its
existing response shape, with latitude/longitude/location_name always null.
Unknown stored fields, maps, aliases and nested GPS are never copied.

This applies while ON, OFF and OFF->ON. No current consent generation is
assigned to legacy GPS. These receipt endpoints intentionally expose no private
linked-self location detail either: self receives the same useful location-free
event. No caregiver, creator or owner exception is introduced. A separate
private location-history API is not created or redesigned here.

Family query predicates, authentication, ordering, limits (member 100, recent
200), local-day filtering and useful event semantics remain unchanged.
Stored records, timestamps and configured 90-day retention are unchanged.
No migration, deletion, production query or prevalence claim is involved.
Current daily/welfare writes and all notification/SOS semantics are untouched.

## Exact narrow correction files

```text
backend/server.py
backend/tests/test_checkin_history_privacy.py
backend/tests/fixtures/legacy_create_checkin.py.txt
docs/android-reliability-hardening-review.md
```

The fixture is the exact undecorated create_checkin function from supplied base
247c93ffa4ec8a3406de8bacb2ba99b7542a7c19, executed only with isolated services.
Its AST was independently compared to git show of that base and matched exactly.
It is not an invented raw database insert or a dependency on production access.

## Current correction verification

New reader regressions: **38 passed**, exit 0. Cover historical writer -> real
withdrawal -> both readers, ON/OFF/OFF->ON, equal endpoint behavior, self and
privileged-family fail-closed behavior, current daily/welfare/adapter receipts,
complete JSON field/value inspection, nested arbitrary extras, unrelated family,
missing HTTP authentication, both actual HTTP serializations, order/limits,
local-day filtering and unchanged stored history.

The first development invocation had 34 pass/4 fail because the new test looked
up welfare receipts by their public ID rather than the existing harness's
canonical MongoDB key. Only that test lookup was corrected; no welfare production
change or weakened privacy assertion was made. The completed new suite is 38/38.

All previously selected 26 backend files were rerun separately, each exit 0:
**469 distinct passing tests**, plus new 38 = **507 / 27 files**.
Counts: snapshot 51, refresh 32, pipeline 40, history 32, upload 11,
check-in/welfare 25+6, self creation 32, startup heal/sync 22/26,
family removal 3, coordinate integrity/label 6/2, presence 11, stationary
battery 3, backend medication reliability 34. Other isolated files cover
escalation, battery, billing, phone fields/backfill, snapshot tracking mode,
JWT configuration and missed-medication summaries.

Full backend remains UNVERIFIED; it was not rerun or called passing. Earlier
combined evidence remains 19 pass/3 legacy event-loop failures.

Current unchanged frontend, same eleven requested patterns:
**295 passed / 0 failed, 12 suites passed**, exit 0. Includes B1/location 207,
medication/check-in 44, SOS/routing 17 and Device Comparison 27.
All 17 push-medication cases pass this invocation. Earlier combined 292/3/295
and isolated 15/2/17 remain historical failures classified B (pre-handler
listener-readiness timing); they are not rewritten as passing. No frontend
production/test/configuration file changed. Existing force-exit/open-handle
warning remains non-blocking technical debt.

Python compilation and git diff --check passed. No Android compilation,
real MongoDB concurrency, process-death or physical validation was performed.
Related-reader and resumed source-review verdicts follow separately.

## Directly related legacy reader audit — CLEARED

**LEGACY CHECK-IN/WELFARE FAMILY-READER AUDIT CLEARED.**

Inventory of reachable committed paths in the active backend:

| Candidate | Provenance, authority and result |
|---|---|
| GET /checkins/member/{member_id} | db.checkins; exact supplied-base writer can store GPS; same-family authenticated viewer; now explicit safe receipt projection for all sharing states and identities. No lifetime is backfilled; linked self also gets no GPS. Real historical writer + real withdrawal + actual HTTP JSON tests pass. |
| GET /checkins/recent | Same storage/provenance/authority/projection; same result, current local-day filter retained. Both endpoint outputs agree. |
| POST /checkins | Current writer and response are location-free; linked-self/family checks retained. No historical reader here. |
| POST /checkin-requests/{request_id}/respond, including duplicate/recovered responses | Historical welfare receipts can share db.checkins storage; current responses require authenticated linked member in current family and explicitly null all three declared location fields. CheckIn ignores unknown stored extras. Current writes remain location-free; no caregiver/owner self shortcut. |
| POST /members/{member_id}/welfare-check-response | Validates request/member/current-family association, delegates to the linked-self response above. No independent historical family reader. |
| GET /checkin-requests/member/{member_id} | Reads db.checkin_requests, not db.checkins; same-family authenticated access. Raw request history has no sharing/generation/self redaction, but actual supplied-base/current request creation and request updates persist IDs, names, times, status and delivery bookkeeping, not response GPS or labels. Receipt location is not embedded or joined. No realistic retained-location disclosure established. |
| GET /summary | Reads raw db.checkins but emits only checked_in_today and last_checkin_time from them; same-family authenticated scope. No precise location or self exception; sharing/generation is not required for these safe fields. |
| GET /history/member/{member_id} | Medication-log date/count/compliance aggregation, not a check-in/welfare receipt projection. No check-in GPS joined or returned. |
| detect_missed_checkins | Internal receipt-existence checks only; does not publish raw receipts into family alerts. |
| Cleanup/index/startup migration consumers | Internal maintenance, not an additional family-readable history API. Dynamic collection access was checked for exports; no extra family receipt export was identified. |

Additional offline audit invoked actual request creation, welfare response, real
withdrawal, request-history read and dashboard summary with a retained exact-base
GPS-bearing check-in. Request history/summary contained no private coordinates or
label; unrelated-family request history was empty; stored receipts were unchanged.
This audit did not mutate production or add duplicate cases to pytest totals.
The standalone audit's initial missing test-signing configuration and cursor-model
shape were corrected only in the temporary harness; no application change.

The configured retention remains 90 days; no live database/index/prevalence query
was run. A theoretical arbitrary poisoned request document is not presented as
an established historical writer or a release blocker.

## Resumed source review — independent High blocker, STOP

**RED — NEW RELEASE BLOCKER FOUND.**

### Exact defect and provenance

In frontend/app/_layout.tsx, RootNav's successful confirmed-member-absence branch
now invokes locationEngine.stop only if readTrackingAuthority() returned a value.
The StartupDiagnostics extension is explicitly Android-only
(expo-module.config.json platforms=["android"]). On iOS that optional module is
absent, readTrackingAuthority() returns null, and native shutdown is skipped.
leonidas.stop() only clears the JS patrol interval; it is not the SDK stop.

The existing iOS stopConfiguredEngine implementation still calls lib.stop().
The regression is that the shared root no longer reaches it on confirmed member
absence. This condition was introduced by the PR's B1 native-authority correction;
the supplied base called locationEngine.stop unconditionally after the same
successful ownership-absence confirmation. This continuation changed no frontend.

### Realistic sequence and violated invariant

1. An iOS installation has an already-configured native tracker for its linked
   member. Existing SDK configuration uses stopOnTerminate=false.
2. The member is removed/unlinked while the authenticated account remains; on
   root/bootstrap recreation, the native tracker may still be enabled.
3. The real root finds no linked member, waits the existing 90 seconds, then
   obtains a successful authenticated /members response with no owned row and
   matching /auth/me identity and token.
4. The confirmed-absence branch stops the JS patrol but does not invoke native
   stop, because Android authority is null on iOS.

No race is necessary. No phone was used to establish physical persistence.
The deterministic proof establishes the missing native stop invocation at the
real app root; actual iOS background duration/HTTP consequences were not measured.
No family GPS disclosure, successful removed-member upload, or physical-device
acceptance is asserted.

Severity **High — authority-loss / core tracking-lifecycle regression**.
Confidence high in the missing shutdown and base-vs-current regression. Confirmed
member loss must terminate the prior tracking binding on iOS too; an Android-only
authorization extension cannot be a prerequisite for that platform's shutdown.

### Counterfactual verification

Temporary tests outside the repository reuse the actual missedCheckinReturnButton
root harness, actual RootLayout and existing deterministic 90-second absence
scenario. Platform is iOS and readTrackingAuthority returns null, matching the
actual Android-only module boundary. Authenticated members/auth responses are
successful; the JS patrol-stop assertion passes before the SDK-stop assertion.

The same scenario and assertion run against:

- Current PR root: **FAIL**, expected native engine.stop once, observed **zero**.
- Exact supplied-base root: **PASS**, native engine.stop called once.

Only import paths in the temporary supplied-base root were rewritten so its
unchanged component body can run with the same isolated dependencies.
Two selected cases: **1 pass / 1 fail**, 52 skipped, command exit 1. They are
counterfactual duplicates, not additions to the 295 original frontend denominator.
No checked-in test or production source was changed to make this finding pass.

### Smallest conceptual correction and minimum regression

Separately authorize platform-appropriate shutdown at this confirmed-absence
boundary: Android retains its expected-native-authority CAS protection; iOS
must use its legitimate existing stop boundary without an Android module.
Do not weaken B1, treat timeout/offline as removal, or redesign iOS tracking.

Minimum regression: real root on iOS, optional Android authority absent,
previous tracker enabled, successful same-session confirmed owned-member absence
-> SDK stop; plus transient/offline/malformed lookup does NOT stop, valid owned
member does NOT stop, and Android obsolete-authority replacement still survives.

**The independent blocker is NOT FIXED. No suggested task was started or created.**

### Coverage and exact stopping point

Reviewed the new native authority implementation/Expo binding, acquisition and
shutdown wrappers, wake authorization/recovery fences, shared startup/stop/token
paths, related member/location read/write boundaries and caregiver tuple-age
semantics. Medication routing/acknowledgment and SOS payload selection received
partial source inspection, not complete certification.

Review stopped at the confirmed iOS root member-removal branch. Remaining:
finish broader native lifecycle/FGS/background/ownership/static review, complete
medication/SOS/iOS source review, cumulative scope adjudication, and full original
October 13 incident replay. Existing tests separate stale GPS from continuing
contact and enabled configuration, but are not a completed original-incident
replay or attribution of the historical stop caller.

The completed backend 507/27 and requested frontend 295/295 results remain
accurate, alongside the NEW failing adversarial root scenario. Full backend
is still UNVERIFIED. Public disclaimer preview renders; signed-in UI was not
visually verified. No additional application source changed after the narrow
reader correction push.

Real MongoDB concurrency, Android process-death/across-runtime validation,
Android compile/build and physical acceptance remain NOT STARTED.
No merge, Railway deployment, production mutation, OTA, Android build/release,
or Google Play submission occurred. Recommended next step is separate approval
for the narrow iOS confirmed-member-removal shutdown correction, not release.

## Authorized iOS confirmed-member-removal correction

**IOS CONFIRMED-REMOVAL SHUTDOWN BLOCKER: CLEARED.**

The root now explicitly separates platform stop contracts only after the existing
successful, authenticated, same-session/token ownership-absence checks:

- Non-Android invokes the existing locationEngine.stop implementation without
  requiring Android authority.
- Android still requires the captured removal authority and passes it unchanged
  into the protected stop/CAS path. No unconditional Android fallback was added.
- A non-Android linkage that changes during the pending lookup supersedes the
  old absence result. A captured pre-lookup member ID is compared to the current
  linked member before accepting the absence. Existing cancellation, session,
  identity, token and response-shape checks are retained.

No SDK implementation, native module, authority format, consent path, backend,
medication or SOS application source changed.

### Deterministic regressions

The real root harness now includes 12 additional cases (39 total in that file):

- iOS, Android extension genuinely absent, previously enabled modeled SDK:
  patrol stops once; real locationEngine.stop reaches mocked native SDK stop once,
  and the SDK enabled model becomes false.
- Existing Android confirmed-removal case additionally verifies the exact valid
  owner/generation argument.
- Android missing authority: no unconditional engine/native stop.
- Android captured stale authority: actual engine/CAS cannot revoke a replacement
  native owner, and no SDK stop occurs.
- iOS network failure, unknown response, non-list response and malformed member:
  no engine or patrol shutdown.
- iOS pending absence followed by account replacement, cancellation/unmount,
  token replacement or newer linkage: no stale native stop.
- iOS fresh positive linkage: normal bootstrap, no destructive stop.

The native SDK is mocked; this proves invocation/ordering and state-model
behavior, not physical iOS or Android execution.

### Verification

Same eleven requested frontend patterns, 12 suites:
**307 passed / 0 failed**, exit 0 (295 established + 12 new cases).
Includes existing signout/consent/permission/replacement authority, root startup,
B1/location, medication notification/acknowledgment and SOS/routing regressions.
All 17 push-medication cases passed in this invocation. Earlier timing-sensitive
failures remain historical evidence; no medication implementation was changed.

TypeScript: npx tsc --noEmit, exit 0. git diff --check, exit 0.
The native authority extension remains Android-only. Non-Android stop still
delegates to stopConfiguredEngine/lib.stop; no fake native authority was added.

Development failures were isolated test setup, not additional production bugs:
malformed /members fixtures initially also reached unrelated alert consumers;
replacement-authority setup initially attempted to authorize over a live owner,
then needed to clear its native model before subsequent root tests. Only test
setup was corrected. Final assertions retain all requested shutdown guarantees.

Backend source did not change: preserve the prior 507 distinct passing tests
across 27 isolated files, including 38 legacy-reader and 34 medication cases.
No unrelated backend rerun. Full backend remains UNVERIFIED.

Exact correction files:

```text
frontend/app/_layout.tsx
frontend/src/__tests__/missedCheckinReturnButton.test.tsx
docs/android-reliability-hardening-review.md
```

No merge, deploy, production mutation, OTA, Android compilation/build/release,
Play submission, real MongoDB concurrency, process-death or device testing.
Broader source-review verdict follows after the narrow correction push.

## Resumed review after iOS correction — High SOS blocker / STOP

**RED — NEW RELEASE BLOCKER FOUND.**
**IOS CONFIRMED-REMOVAL SHUTDOWN BLOCKER: CLEARED.**

The narrow iOS correction is committed and pushed, with local/remote/PR head
verified equal. The PR remains open/unmerged. The following finding is independent
of that correction. No SOS or medication application source was modified.

### Exact source, reachability and provenance

frontend/app/sos-sending.tsx run() awaits foreground permission and then
Location.getCurrentPositionAsync before calling api.post('/sos'). No application
deadline or parallel dispatch exists around this optional location stage.
The automatic 911 dialer is later in the same sequence, after the POST.

This is live application code: the dashboard's completed SOS countdown routes
to /sos-sending, as does the welfare response's Need Help path. It is not dead
code or a hypothetical alternative implementation.

The screen is identical to supplied base 247c93ffa4ec8a3406de8bacb2ba99b7542a7c19;
its last source change predates the current correction. This is a pre-existing
reachable safety/reliability defect discovered during the authorized SOS review,
not a regression introduced by the iOS fix or attributed to PR #166.

### Realistic sequence

1. A user completes the dashboard SOS countdown during an emergency.
2. Foreground location permission is already granted.
3. The optional current-location request remains pending. One concrete native
   route is Android location settings resolution: the installed Expo module
   waits for an activity result before requesting a fix or rejecting the request.
   Leaving that dialog unresolved leaves this Promise unresolved.
4. The screen remains at Attaching location. The healthy network is never used
   to create the SOS alert, so backend push/SMS fanout never starts.
5. The app's automatic emergency dialer is also not reached. The screen provides
   a Retry action only on error; a pending location result is not an error.

This does not assert that every Android GNSS request is unbounded. A provider
may reject/timeout normally; that settled path works. The defect is making the
emergency dispatch depend on optional asynchronous location/settings completion
without an application bound or independent alarm path.

### Deterministic proof

Temporary tests outside the repository reuse the committed
sosPermissionRegression harness and real SOSSending component. Foreground
permission resolves granted; the API mock is healthy. Mount/effects/timers are
awaited, and both permission and GPS invocation are asserted before the result:

- Pending location/settings result, advance 120 seconds: **FAIL**; expected
  POST /sos with unavailable coordinates, observed **zero POST calls**.
- Rejected optional location, same harness/network: **PASS**; SOS posts without
  coordinates and reaches confirmation.

Selected comparison: **1 failed / 1 passed / 3 skipped**, exit 1.
This is not notification-listener-readiness timing: the native location request
was already invoked and its pending result is the deliberate controlled input.
The 120 seconds demonstrate the blocked application path; they are not a claim
of a physical-device delay or a product-selected GPS deadline.

The test and control are temporary duplicates, not additional tests within the
307 passing checked-in frontend tests. No live alarm, network request or device
test occurred. No production data or location permissions were changed.

### Severity, confidence and minimum correction

**High — core SOS reliability with safety impact.** High confidence in the
reachable application dependency and blocked emergency POST. Actual device
frequency and OS-dialog behavior were not physically measured.

Violated invariant: optional/best-effort location must not prevent a genuine
emergency alert from being sent when the server is reachable. A missing or
pending fix is not emergency-send authority and must not gate dispatch.
The existing backend accepts SOS without coordinates, and existing denied/rejected
location controls demonstrate that supported behavior.

Smallest conceptual correction, separately authorized: bound or decouple the
optional location stage so the existing SOS POST proceeds with coordinates only
if available in time; otherwise send without them. Preserve the distinction
between actual server acceptance and mere send intent, single-alert/retry
semantics, explicit emergency location behavior, and truthful dialer/failure UI.
Do not reuse ordinary-sharing authority as an SOS suppression condition.

Minimum regressions: real screen with granted permission/pending GPS sends once
within a selected bounded budget; pending settings/permission completion cannot
block indefinitely; late GPS cannot send a duplicate; normal fix and explicit
GPS rejection/denial still work; network failure does not claim success;
retry and dialer behavior remain correct.

**STOP: the independent SOS blocker is NOT FIXED.**

### Review coverage and exact remaining boundary

Since the iOS push, inspected native state persistence/lock/CAS/shutdown
reservation, dead-process mutation bookkeeping, configuration/acquisition claims,
lease/cooldown/backoff, JS authority bindings, wake ownership validation,
receipt-bound bounded acquisition, native shutdown fencing, engine startup/
recovery/token/stop/restart diffs and patrol's Android recovery behavior.
No additional Critical/High defect was established in those inspected paths.
This is source inspection, not native compilation or process-death validation.

Medication inspection covered exact-occurrence resolution, acknowledgment claim
versus family escalation, durable taken-log ordering, provider completion
classification and notification action/routing portions. It did not finish the
full medication restoration/delivery/cumulative review.

SOS review traced actual dashboard/welfare entry points, real sending UI and
backend's location-optional authenticated alert creation and family fanout.
Review stopped at the proven optional-GPS/settings dependency, before full SOS
delivery/routing clearance.

Remaining: complete medication and SOS source review after separate blocker
correction; finish outstanding shared/iOS/native call-site and cumulative
interaction assessment; complete the original October 13 eight-part source
replay. Native/authority/FGS inspection above is retained, not restarted.
The original-incident archive was inventoried only in this continuation.
No completed incident replay or original stop-caller attribution is claimed.

Cleared privacy audits remain cleared and were not repeated. No changes to
backend, native implementation, medication or SOS followed the narrow iOS push.
Full backend remains UNVERIFIED; 507/27 isolated backend baseline is preserved.
The current checked-in frontend remains 307/307 passing alongside this separate
adversarial failure; earlier medication timing failures remain recorded.

Next stage: separate authorization for the narrow SOS optional-location
dependency correction, then finish the stated remaining source-review boundary.
Android compile/build is NOT yet cleared.

Real MongoDB concurrency, Android process-death/across-runtime, Android
compile/build, physical acceptance, burn-in and road tests remain NOT STARTED.
No merge, Railway deployment, production mutation, OTA, Android build/release,
Play submission or force-push occurred.

## Authorized SOS optional-location correction

**SOS OPTIONAL-GPS BLOCKER: CLEARED.**

Starting HEAD was daf93ba234eb99ee5b021c4e96d75cccfaa07067, verified against
the remote branch and open/unmerged PR before source edits; tree was clean.

The existing screen owns a single POST and the existing post-acceptance dialer.
SOSRequest already permits omitted/null coordinates, and no existing
post-send coordinate-enrichment API was found. No cached family GPS is copied.
The correction therefore uses a short **1,500 ms total permission-plus-GPS
budget**, after the unchanged 350 ms screen-settling pause. Prompt location
still enriches the original SOS POST. Denied/rejected/unavailable or pending
permission/location/settings degrades to the same locationless POST.

The deadline bounds both native requests together, not each separately.
Late permission completion cannot launch a new GPS/settings request. Late GPS
settlement cannot send or mutate another operation; rejections remain caught.
Per-screen operation identity, unmount invalidation and an in-flight guard prevent
obsolete work or rapid repeated retry from posting/dialing a second time.
Deliberate retry after server failure remains available.

Success still requires the existing server acceptance. The number remains
tel:911; missing/rejected dialer retains the manual-call warning. Post-send
location boost is preserved but no longer awaited before dialer/UI completion;
optional success haptics likewise do not gate the core path. No visuals changed.

### Deterministic verification

Real SOS screen suite: **16 passed**, previously 3; 13 added cases.
Checks pending GPS and reachable settings/provider wait past budget; pending
permission including late grant; prompt GPS payload; denied/rejected permission;
GPS rejection; late GPS resolution/rejection; rapid duplicate retry after a failed
POST; old GPS after unmount/new SOS; rerender duplication; pending location boost;
server rejection; and unavailable/rejected dialer.
Payload, single POST/dialer, confirmation/error UI and location preservation
are asserted. The formerly failing pending-GPS scenario now proceeds.

Requested frontend selection: **320 passed / 0 failed**, 12 suites, exit 0.
That is previous 307 + 13 SOS cases. iOS root remains 39 passing cases;
B1/location, medication notification/acknowledgment and routing remain passing.
All 17 push-medication tests pass this run. Historical timing failures retain
their prior classification and counts.

New isolated backend SOS tests: **6 passed**, exit 0. Actual trigger_sos with
all delivery/storage mocked verifies omitted, null and prompt coordinates,
unchanged authenticated family/recipient scope and fanout. Actual HTTP tests
verify coordinate-free/coordinate-bearing responses and rejection without auth.
No backend production source changed. Prior 507 passing tests across 27 files
remain baseline evidence, not newly rerun tests. Full backend is UNVERIFIED.

TypeScript npx tsc --noEmit: exit 0. git diff --check: exit 0.
No ordinary sharing, background-tracking authority, medication, recipient or
native-module implementation changed. Location semantics remain explicit SOS,
not ordinary background-sharing suppression.

Only the SOS screen, its existing regression suite, the new offline backend
contract suite and directly relevant review/engineering guidance change.
No live alarm, real GPS, external SMS/push or production mutation was performed.
Broader source-review result follows after push.
