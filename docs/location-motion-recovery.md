# Targeted location recovery and independent GPS freshness

## Severity and evidence

**Critical:** a phone can communicate normally while its map position stays
stale and the stored stationary flag prevents fallback GPS for an hour.

The Build 82 diagnostic comparison establishes the failure sequence: native and
JavaScript heartbeats continued; the affected phone produced no trip-time motion
events; the native gate rejected acquisitions as `capture_recent`; hourly
headless one-shots acquired and uploaded successfully. It does not establish why
activity-recognition events stopped. Android battery optimization is **not** a
proven root cause.

Confidence is high in the admission/display corrections. Re-registration is a
bounded mitigation for missing motion delivery, not proof of its Android cause
or a guarantee that Google Play services/OEM firmware will deliver transitions.

## Delivery decision made before implementation

**The complete correction requires a new Android binary, not an OTA to Build 82.**
The installed native `TrackingReliability.claim` API cannot distinguish an
explicit request from periodic stationary housekeeping. Its cross-runtime lease,
authority and backoff must not be bypassed with JavaScript state, fake movement,
or a configuration-only claim.

The native module gains `trackingClaimPurpose` and `motionRecoveryMaintain`.
These extend the existing StartupDiagnostics/Transistor SDK integration; there
is no replacement location engine, dependency, permission, service, or backend
change. Old binaries retain their conservative existing native policy and log
`new_binary_required` for intent-specific acquisition. They cannot silently
pretend that the full recovery correction is active.

The GPS warning alone is JavaScript/UI logic and could be delivered separately
by OTA, but this PR does **not** authorize or publish one. A future authorized
binary must use a new diagnostic build identity/runtime, never reuse
`1.3.1-diagnostic82`. No build profile/version or release was started here.

## Targeted behavior

All GPS purposes first pass the existing native owner/generation, revocation,
shutdown/mutation, single-flight lease and shared failure-backoff checks.

| Purpose | Admission after those checks |
| --- | --- |
| Ordinary periodic | Existing capture-age interval: moving 5 minutes, stationary 60 minutes |
| Watchdog on an existing heartbeat/WorkManager wake | Capture at least 5 minutes old moving, 15 minutes otherwise; attempt spacing uses the same interval even if a probe is discarded |
| Justified motion/patrol/focus recovery | Capture at least 5 minutes old; shared intentional-request attempt spacing of 60 seconds |
| Explicit fresh-location request / refresh push | Does not inherit capture-age suppression; shared intentional-request attempt spacing of 60 seconds |

The foreground dashboard's automatic focus polling uses **recovery**, not
explicit admission. Patrol likewise identifies itself as recovery. The public
explicit-refresh entry point and receipt-bound refresh push identify their
intent at the trusted caller, not by interpreting an untrusted payload string.

SDK acquisition remains `persist:false`, limited to 20 seconds, with the existing
8-second explicit HTTP timeout. Fresh ownership/permission/consent checks and
receipt matching remain in place before and after asynchronous acquisition.
Shared failure backoff remains 5 / 15 / 30 minutes. No purpose resets backoff or
turns a successful one-shot into proof of sustained tracking.

On already-authorized wakes, motion maintenance can re-register the **existing**
Google activity-transition PendingIntent when GPS is overdue. The native
authority lock reserves a durable, owner-scoped 15-minute maintenance budget
before contacting Play services, including when a callback never arrives.
Physical-activity and existing location grants are required; no permission
dialog is opened. Maintenance does not stop/start the SDK, start an FGS, or force
`changePace(true)` from a heartbeat/JobScheduler event. Only a real fresh activity
transition may invoke the existing exempt native recovery receiver.

### Battery and timing limits

The deliberate tradeoff is up to four short stationary watchdog probes per hour
when ordinary location delivery remains absent, rather than the previous one.
That includes a genuinely stationary phone: quiet stationary operation and a
failed motion event stream cannot reliably be distinguished by silence alone.
Moving fallback remains five minutes. A healthy stream of accepted coordinates
suppresses probes. This does not keep GPS running continuously or add a wake
timer; probes share one native lease across foreground/headless/WorkManager
requests. Permission loss, sharing OFF, sign-out, replacement and failure
backoff can all prevent work.

Fifteen minutes is an **eligibility threshold**, not an Android delivery SLA.
Doze/OEM restrictions, process scheduling, absent wakes, unavailable GPS and
network failures can still delay a result. Registration success, fresh one-shot
delivery and sustained tracking remain distinct evidence.

## Independent caregiver warning

At accepted `coordinate_captured_at` age **>= 15 minutes**, the family card shows
“GPS location stale — last known location,” independently of motion. Its
communication badge still uses device contact alone and can correctly remain
“Device communicating.” Battery/contact responses cannot clear GPS staleness.

A new accepted capture clears the warning. Missing/invalid or excessively future
timestamps remain unknown, not green; the existing five-second clock-skew
tolerance and sharing-OFF privacy neutrality are preserved. Existing prolonged
GPS-outage danger escalation is retained; this change does not weaken it.
Operational recovery reporting also stops calling a 43-minute-old stationary fix
fresh.

A one-shot **display** deadline updates the card at the boundary without a server
or store update. It is rescheduled for a new capture, cancelled for sharing OFF
or unmount, and re-evaluated on resume. It performs no GPS/network work.

## Focused verification

**Result:** 165 focused Jest cases across eight files passed. The native contract
harness passed, as did changed-source syntax/whitespace checks. The signed-out
preview rendered the existing Important Notice screen without a fatal error.

- Targeted Jest coverage: family-card status, mounted GPS freshness deadline,
  native-purpose bridge, delayed authorization/revocation races, tracker lifetime,
  real headless heartbeat/motion caller wiring, independent battery wakes, and
  receipt-bound Android publication paths.
- `frontend/scripts/verify-native-contract.sh` compiles the production authority
  and acquisition policy against Android API classes and executes those actual
  Kotlin sources with fake storage/clock. It checks exact intervals, concurrent
  admission, shared failure backoff, mutation/shutdown/replacement fences,
  registration budgeting and revocation. It is **not** an APK/EAS/Gradle build.
- Changed TypeScript/TSX syntax and whitespace checks.
- Preview smoke check can reach only signed-out routes; authenticated card
  behavior is checked by the focused helper/hook tests, not a signed-in
  screenshot.

The publication fixture deliberately left GPS unresolved during its shutdown
assertions. It now resolves/awaits that work **after** those assertions, so its
20-second timeout does not run after Jest teardown. This is local fixture
cleanup, not a wider test-runner change. The publication check exits successfully
but still reports Jest's lingering-open-handles warning; broader runner cleanup
is not part of this correction.

## Remaining acceptance and authorization

No physical-device, Google Play services registration, Android FGS lifecycle,
full Expo/native application compilation, or measured battery acceptance is
claimed. After a separately authorized binary, verify one closed-app departure
and return with contemporaneous motion/GPS/upload evidence, and compare a bounded
stationary battery interval. This PR does not perform those steps.

No merge, OTA publication, native build, or backend deployment is authorized.
