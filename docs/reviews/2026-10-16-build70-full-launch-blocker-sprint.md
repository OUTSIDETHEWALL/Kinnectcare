# Build 70 — full launch-blocker corrective sprint

## Decision and authorization

**RED — NOT READY FOR BUILD 70. Google Play production remains HOLD.**

The reviewed source corrects the confirmed defects below. This is not a claim
that the physical startup delay or hours-long communication failure is solved.
The required full Android/Expo native compilation was not completed; isolated
native authority compilation is not a substitute. Cold-headless bootstrap,
Android chooser lifecycle, and endurance still require native/device proof.
The source gate is therefore not GREEN. The existing failed physical acceptance
is unchanged. No newly confirmed Critical/High defect was deliberately left
unfixed in the reviewed source paths.

This work updates draft PR #167 only. No merge, backend deployment, Railway
production configuration/data change, OTA, EAS Build 70, Play action, or physical
phone operation was performed. The exact final commit is recorded in the PR
description and final handoff, rather than embedded self-referentially here.

This report supersedes the earlier narrow post-road-test review. Background GPS
did occur in the October 16 Build 69 test; that fact is not physical acceptance.

## Confirmed causes and implemented corrections

### GPS provenance, authorization, and local ordering

- Undated live-location and check-in/welfare writers could replace trusted
  coordinates or erase their capture provenance. Unknown-age publication is now
  an atomic, consent-fenced operation allowed only with no existing trusted
  capture/order timestamp, and only in legacy consent generation zero.
- Missing acquisition consent metadata no longer adopts the server's current
  generation. Native extras and explicit acquisitions retain their original
  generation; stale generations fail closed after renewal.
- Dated writes compare against **both** stored capture timestamps. Explicit null
  is an uninitialized field, not a permanently frozen tracker. A mismatch between
  legacy ordering and verified coordinate timestamps cannot regress the tuple.
  Identity, family, affirmative consent, and generation remain in the same CAS.
- Caregiver reads are tested between verified, undated, replayed, and newer
  uploads. No timestamp backfill or fabricated capture time was introduced.
- The client member store preserves a newer tuple against older/undated results
  in the same identity/consent lifetime. Older consent generations cannot revive
  sharing after withdrawal. A changed point cannot inherit the old point's name.
  Withdrawal and a new consent lifetime can still clear coordinates.

**Scope of the claim:** these are candidate source contracts with regression
evidence, not changes already deployed to production or physical end-to-end proof.

### Background execution and independent device contact

- WorkManager scheduling previously followed location bootstrap, and battery
  publication awaited GPS recovery/configuration. Android scheduling now begins
  from authenticated root state independently; each battery wake proves current
  secure session and unique self-member ownership without needing a GPS SDK.
- Battery upload runs concurrently with GPS recovery. A changed policy lifetime
  requires fresh contact proof; successful publication does not trigger a second
  upload. Timeouts finish the task rather than starting another execution.
- iOS retains its existing post-bootstrap credential ordering; Android-only
  independence was not applied unsafely to its cached-SDK transport.
- Native configuration exclusion is separate from GPS acquisition/backoff.
  Runtime registration is not skipped merely because the native service reports
  enabled. Existing shared authorization, shutdown quarantine, current-generation
  revocation, and non-destructive UNKNOWN handling remain enforced.

**Not confirmed:** this coupling is a real source defect and plausible common
failure mechanism, but does not establish the cause of the four-hour incident.
A cold React/headless bootstrap failure remains possible and unproven. No
foreground keep-alive requirement or periodic destructive reset was added.

### Startup responsiveness and session lifetime

- Authenticated startup no longer waits for optional timezone maintenance or a
  cache write before releasing usable identity. Dashboard family/safety data no
  longer waits for billing. Required identity, PIN, consent and family gates stay.
- Bootstrap, refresh, OTP, invite-transition continuations, and delayed two-401
  cleanup are fenced against a newer session. Late work cannot restore logout
  or clear a newer login merely because a diagnostic-storage await completed.
- Existing startup/request milestones remain available to measure the exact
  remaining gate on a native launch.

**Circle of Doom:** avoidable blocking paths are confirmed and corrected.
Attribution of the observed approximately 20 seconds to those paths is **not
proven**, and no physical startup-performance PASS is claimed.

### Truthful health, motion evidence, sharing, and geocoding

- Health separates device contact, battery, native configuration/state, heartbeat,
  motion, capture time, publication acceptance, foreground acquisition, and
  correlated background delivery. Foreground success/contact/enabled alone
  cannot establish sustained background health. Current owner, native generation,
  consent lifetime and revocation boundaries filter diagnostic summaries.
- Immutable per-event persisted evidence keys avoid cross-runtime array
  replacement. Separate transition/heartbeat/delivery quotas prevent polling
  noise from evicting a drive; retention is bounded to one day. Sanitization
  excludes unnecessary precise coordinates. The short legacy array is not the
  authoritative timeline.
- Export exclusion spans collection and the chooser. The native sharing patch
  reserves an operation-local request code before preparation, checks the exact
  promise before launch, handles activity results/return/destruction, and rejects
  interrupted requests. An old result/preparation cannot clear or launch a retry.
  No timer silently releases an active chooser. Old patch versions fail explicitly.
- Motor Future scheduling uses an appropriate Future-compatible wrapper with
  observed/logged exceptions. A separate undefined-name bug in the disabled
  geocoding warning was found and fixed: optional geocoding cannot crash an
  otherwise valid coordinate upload. Neither issue is claimed as the measured
  physical startup cause.
- Device Not Responding, independent presence freshness, Needs Attention, SOS
  alert-first behavior, medication acknowledgment/escalation, check-in primary
  effects and location-free receipts remain under regression coverage.

## Files and regression evidence

Production areas: `backend/server.py`; frontend root/dashboard, AuthContext,
member store, Android recovery/battery worker, evidence journal/summary,
health aggregation, location acquisition/publication and diagnostics export;
the local Android tracking authority and pinned Expo Sharing config patch.
The earlier corrective commit supplies the journal/native authority/publication
contracts; this sprint extends and adversarially verifies that resulting tree.

Added/extended tests cover real AuthProvider delayed optional work, logout/OTP/
two-401 races, real dashboard pending billing, actual root battery scheduling
under denied GPS authority, fresh self-owner contact, hung GPS with successful
battery, timeout behavior, store ordering/withdrawal, consent-boundary summaries,
actual backend handler/read sequences, null/divergent capture fields, disabled
geocoding and failed Motor Futures.

Tests formerly expecting unversioned writes to adopt renewed consent or undated
check-ins to erase a verified tuple were corrected **without restoring unsafe
production behavior**. Current-client fixtures now send current acquisition
generation; legacy check-ins still succeed but cannot replace the verified point.
The atomic fixture now models Mongo null/date comparison rather than raising a
Python comparison error. A legacy ambient-loop fixture prevents unrelated async
tests from invalidating later synchronous tests.

## Verification and failure classification

| Check | Result |
|---|---|
| Full frontend Jest | **885 passed, 1 failed**, 77 passing suites |
| TypeScript | PASS |
| Changed/new frontend lint | **0 errors, 87 warnings**; warnings retained, not suppressed |
| Full backend, network/subprocess-fenced | **577 passed, 65 failed, 106 errors, 5 skipped**; 753 JUnit results |
| Complete local/offline backend subset | **567 passed, 5 skipped**, 16 live-service modules explicitly excluded |
| Production native authority Kotlin | Compiled against an Android API classpath |
| Native authority JVM contract | Two real JVM processes passed exclusion/backoff, stale-owner CAS, dead-process incarnation recovery and revocation fencing |
| Full Android/Expo app compilation | **NOT VERIFIED** |
| Native chooser / cold ReactHost / Android scheduling | **NOT VERIFIED** |
| Preview | Restarted; public disclaimer rendered without a fatal startup error |
| Signed-in/native UI and phone behavior | **NOT VERIFIED** |
| Diff whitespace/static hygiene | PASS |

The one frontend failure is the **pre-existing legacy-identifier repository
audit**, including historical medication fixtures. It was not suppressed or
made green by rewriting historical family data in this sprint. Jest still needs
`--forceExit`; clean timer teardown is not claimed.

The final full-backend nonpassing results are classified:
- **161 environment/live-service failures:** HTTP/Mongo or external executable
  operations forbidden by the offline boundary.
- **5 environment failures:** absent historic local fixture files/executables.
- **3 test-harness failures:** two legacy async-fixture cases and one closed-loop
  case in a legacy integration module.
- **1 pre-existing test defect:** its blank-push helper contradicts its own test.
- **1 obsolete expectation:** a historical startup log marker is expected from
  an unavailable legacy log, not from the current controlled application.

No live service was redirected to production to make tests green. The runner
blocks sockets before collection and external children except the exact safe
JWT-configuration import command; unavailable Motor fixtures fail promptly.
The local subset is explicitly **not** advertised as a full-suite PASS.
The five retained skips are live-API geocoding checks without a supplied test
session; no production session was substituted.

Preserved earlier failed-run evidence: the initial whole-backend attempt had
526 passed / 111 failed / 106 errors / 5 skipped. Subsequent controls separated
ambient-loop contamination, unavailable live Mongo fixtures, unsafe old
expectations, fixture comparison errors and the real geocoding warning defect.
The final results above supersede those controls without erasing them.

Reproduce with `python scripts/verify-backend-offline.py` (whole attempt),
`python scripts/verify-backend-offline.py --local-only` (offline subset), frontend
`npx tsc --noEmit`, `npx jest --runInBand --forceExit`, and
`bash frontend/scripts/verify-native-contract.sh`.
JDK/Kotlin packages were added for local verification only.
The JVM harness substitutes storage/clock; it does not execute Android services,
Expo Sharing, ReactHost, alarms, permissions or physical GPS.

## Fresh adversarial self-review

This is **self-review**, not an independent second-party review. The final source
was challenged for stale owner/consent, null/divergent timestamps, delayed
responses, revocation, runtime recreation, GPS backoff, blocked optional startup
work, old chooser completions, device-vs-location freshness and safety flows.

Additional confirmed defects found and fixed during this pass: stale client
consent resurrection; duplicate successful contact retry; frozen explicit-null
ordering and divergence between timestamps; disabled-geocoding NameError;
late OTP/two-401 completion crossing session lifetime. A non-Android scheduling
regression was avoided by preserving iOS's original ordering. Affected checks
were rerun. No remaining known Critical/High source defect was waived.

Unclosed proof gaps: full Android/Expo compilation, actual cold-headless recovery,
repeated Android chooser lifecycle, physical startup timing and multi-hour
communication. They prevent source/release clearance; model tests are not
physical evidence.

## Exact recommended rollout — NOT executed

1. Keep #167 draft and production HOLD until review and full native source
   compilation satisfy the source gate. Obtain separate approval for every merge,
   backend deployment, EAS build, installation, OTA and Play action.
2. Validate a disposable backend/client compatibility matrix: legacy generation
   zero, renewed consent, missing metadata, explicit OFF, delayed/replayed
   captures, and independent battery/presence. Do not test writes on production.
3. After source clearance and separate permission, produce signed **Build 70 /
   runtime 1.3.1** with the native authority/sharing changes. Do not OTA this
   combined patch to Build 69. Produce the binary before the coordinated
   deployment window, but do not install it against the old backend.
4. With deployment approval, deploy the matching **backend first**: atomic
   provenance/consent guards and explicit receipts. This closes the old-client
   provenance-destruction window before the new client is installed.
5. Promptly install Build 70 on the authorized controlled cohort. Confirm fresh
   self-owner identity, actual backend consent generation and accepted receipts.
   Do not auto-toggle consent, invent capture timestamps or reset family data.
6. Legacy generation-zero clients retain compatible valid publication. After
   consent renewal, a legacy client without acquisition generation must fail
   closed for GPS; battery/contact remain independent. Do not weaken the guard
   to remove that necessary restriction. Identify and upgrade affected devices
   in the controlled window; do not promise uninterrupted legacy GPS. If that
   cannot be coordinated, keep rollout HOLD rather than deploy an unsafe bridge.
7. Perform Stage A, then Stage B, then the planned full travel day. Keep Play
   production HOLD unless the physical gate and safety regressions pass.
   Any rollback must preserve the backend's privacy/provenance guards.

## Build 70 physical acceptance plan — NOT performed

Use the separately authorized caregiver and tracked phones as distinct devices.
Record build/runtime, owner/member/consent generation, time and expected cadence.
Never use reopening the tracked app as background proof.

### Stage A: controlled road test

1. Before movement, record coordinates and `coordinate_captured_at`, device-contact
   time, battery time, native state, heartbeat and motion evidence.
2. Background the tracked app normally; do not reopen it. Drive several miles.
3. Observe only on the caregiver phone: the map must move and capture time must
   advance **before** reopening. Record contact and battery freshness separately.
   Match accepted capture receipts, not merely HTTP 200 or foreground fixes.
4. Park **7–10 minutes**. Record moving-to-stationary behavior, heartbeat,
   movement-aware freshness, and independent communication. Do not manufacture a
   heartbeat or demand an OS wake on an unsupported exact schedule.
5. Only then reopen the tracked app. Its verified tuple must not disappear,
   regress or acquire a stale name. Measure launch-to-usable-family time and
   each exported gate/request milestone; preserve evidence if it freezes.
6. Export diagnostics: open chooser, share, export again, cancel, export again,
   rapid double-tap, background/return, failure/retry, and Activity recreation
   where practical. Verify complete received file and recovery without a stuck
   pending promise. Check truthful health and retained motion evidence.

### Stage B: multi-hour endurance

1. Leave the normally powered/connected tracked phone backgrounded for multiple
   hours. Do not foreground it merely to keep monitoring alive.
2. Record remote contact and battery advancement throughout; include
   stationary-to-moving and moving-to-stationary travel with remotely advancing
   coordinates/capture time.
3. In separately controlled cases exercise temporary network/GPS loss, ordinary
   process/runtime recreation and a subsequent legitimate Android wake. Confirm
   recovery without opening the app, no stop on UNKNOWN, and no permanent give-up.
   Distinguish ordinary process death from Android user force-stop.
4. Recheck consent OFF/ON, signout, membership/owner replacement, history/trace
   privacy and independent presence alerts. Recheck medication notification
   routing/acknowledgment/escalation suppression, SOS alert-first/dialer, check-in
   with failed optional GPS, add-member/onboarding and caregiver Needs Attention.
5. Preserve full diagnostics plus remote evidence. A short drive, one fix, a
   foreground “resurrection” or successful compilation cannot pass this stage.
   The planned full travel day remains the ultimate acceptance test.
