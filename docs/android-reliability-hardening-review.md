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
