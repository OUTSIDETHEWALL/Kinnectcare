# Android reliability hardening — pre-merge review

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
