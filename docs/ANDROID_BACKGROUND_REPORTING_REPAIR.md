# Android background reporting repair

Status: **candidate source repair; not physical-device accepted; not authorized
for merge, deployment, OTA, or Build 80.**

## Confirmed mechanisms

1. Android denied the SDK's background starts of LocationRequestService and
   ActivityRecognitionService. Battery contact was not proof of working GPS.
2. Background authorization responses were received, but fetch's timer-based
   completion stayed pending until Activity resume hours later. Battery jobs
   still woke and timed out; this was not complete OS suspension.
3. Dashboard dots read stored health while the communication label read freshness.

## Focused changes

- Five background HTTP call sites share direct XHR with native timeout and
  abort/error propagation. No auth interceptor, retry, endpoint, consent fence,
  acknowledgment, server mutation, or data migration was added.
- Both dots use one verdict incorporating current communication, coordinate
  freshness and existing health/issues. Privacy stays neutral; missing evidence
  never becomes green. Timing thresholds are unchanged.
- An independent native Google Activity Transition PendingIntent registers
  after verified SDK configuration. It survives ordinary application-process
  death independently of the SDK's activity-recognition service.
- Native motion ENTER events, boot and package replacement are Android-documented
  foreground-service-start exemptions. SDK ready/start/changePace execute from
  those events, not after a network request or UI mount. Existing SDK native
  configuration, capture/HTTP implementation and backend consent checks remain.
- Admission requires existing fine/background location and activity recognition
  grants, non-revoked durable owner and a matching generation-bound SDK binding.
  New installs without authority cannot self-authorize. Valid legacy upgrades
  can adopt only a matching HTTPS SDK member transport and persisted lifecycle
  settings under native CAS; an absent binding alone is not authority.
- The native recovery operation holds the existing configuration quarantine
  through SDK callbacks and any stale-owner stop cleanup. Receiver timeout does
  not release a pending mutation. An unrelated late callback cannot stop a
  replacement owner. SDK acknowledgment is recorded as a request, never proof
  of fresh coordinate delivery.

No permission declarations, email-link onboarding, SOS, medication behavior,
backend code, family records, build identity or production settings changed.

## Source verification

- 303 focused JavaScript tests across transport, card/device health, battery
  wake independence, ownership/lifecycle recovery, root permission recovery,
  headless entry/lifetimes, email links, SOS and medication flows.
- Direct transport tests hold JS timers undelivered; native XHR completion,
  native timeout, cancellation, HTTP denial and invalid JSON settle explicitly.
- Production native authority code ran under the Android-API JVM harness for
  process incarnation, configuration exclusion, stale-owner CAS, revocation,
  replacement quarantine, stationary eligibility/backoff and motion replay.
  Storage/clock/recorder are test substitutes, not phone evidence.
- The complete local Android Kotlin module, including its Expo bridge and new
  receivers, compiled against installed Android 36, RN/Expo, Google location
  21.3.0 and Transistor 4.2.2 APIs. This was source compilation, not Gradle APK
  assembly, Android execution, delivered-binary inspection or an EAS build.
- Type checking reports only the unchanged `schedulingTracing.test.ts:68`
  `it.each` tuple-typing error, also present in the base revision.
- Web preview loads the public medical-notice screen. The signed-in dashboard
  was not visually verified; health verdicts were checked by unit tests.

## Android build boundary

The native receivers/module code require a new Android binary: **Build 80** when
separately authorized. An OTA cannot install this correction. Build 78/79
artifacts stay immutable. Do not start a build or publish an update from this PR.

## Required acceptance before the launch blocker can close

After source review, authorization, binary inclusion inspection and installation:

- Confirm native receiver classes, merged manifest entries, module method and
  actual vendor/GMS versions exist in the delivered binary; inspect shrinker
  output. Compilation alone is not delivered-artifact proof.
- On the affected Android 15/Samsung device, obtain legitimate sharing/permission
  grants without changing permissions or battery-optimization settings for the
  test. Confirm native transition registration.
- Overnight stationary, then travel at least five miles with the Activity absent.
  Verify transition delivery, Android-permitted native starts, fresh GPS capture
  and accepted server publication **before** opening Kinnship.
- Separately leave the phone stationary/backgrounded for at least four hours.
  Verify successful battery/contact publication and bounded GPS recovery; no
  request may wait for foreground timer delivery. Preserve movement-aware
  scheduling tolerance rather than requiring exact one-minute Doze wakes.
- Repeat ordinary process recreation and reboot while UI stays absent; include
  an authorized legacy upgrade with missing new binding. Force-stop is not an
  equivalent test: Android intentionally prevents background restart afterward.
- Withdraw sharing, deny an existing permission, sign out, replace the owner,
  and deliver a late/replayed transition or SDK callback. Verify no restart or
  publication for obsolete authority and no stale stop of a replacement owner.
- Confirm green clears on delayed contact or stale GPS, and returns only with
  fresh evidence. Recheck email links, SOS and medication acknowledgment.

Both background scenarios remain release blockers until this evidence exists.
