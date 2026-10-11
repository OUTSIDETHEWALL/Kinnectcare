# Android cold-location recovery — review and acceptance

## Scope and evidence

Severity: **Critical** background-location reliability; Google Play release blocker.
The October 8 production OTA contains the permission/startup fix. The October 10
OTA does not change its recovery paths. Diagnostics establish a termination-time
headless invocation, disabled SDK state, independent battery wakes that skipped
GPS, and reporting restored by foreground startup. The retained engine buffer
does not establish which specific call initially disabled the SDK.

This correction removes UI-unmount-driven native shutdown and adds authenticated
recovery on existing boot/termination/heartbeat/moving-event, battery and silent
notification wakes. The physical-device evidence confirms battery execution while
native tracking was disabled, followed by immediate foreground-start recovery.
No new scheduler, native module, dependency, or location transport is introduced.

## Authorization and shutdown

- Owned, successful background-ready foreground startup records durable intent.
  Legacy cold migration requires ALL of: absent (not malformed/revoked) intent;
  matching historical foreground user/member caches; no conflicting old Expo-task
  member cache (absence is normal after Transistor exclusivity); acknowledged
  background disclosure; native URL bound to that member on the configured HTTPS
  backend; native stopOnTerminate=false, startOnBoot=true, enableHeadless=true;
  current secure app session; fresh /auth/me and /members proof of that exact unique
  owned member; affirmative server sharing preference; no local sharing opt-out;
  and granted foreground/background OS location permissions. Session, epoch,
  policy and historical bindings are rechecked before the serialized intent write.
  Missing evidence fails closed; SDK-retained credentials never grant authority.
- This policy avoids requiring foreground startup for a sufficiently evidenced
  legacy installation. It does not promise every historical installation has those
  records, nor that an OTA downloads/applies itself while an old bundle stays alive.
- Recovery uses the app's secure session, a pinned backend, verified current user,
  owned member, sharing preference, and current OS location permissions.
- Every disabled-engine restart revalidates ownership with the server. An enabled
  engine may reuse an in-memory ownership proof for at most 60 seconds; token,
  intent nonce and local sharing changes invalidate its use. Remote policy changes
  are enforced on the next successful verification, not promised instantaneously.
- All native lifecycle work shares the foreground queue. Generation, durable
  intent and secure-session checks reject obsolete work before and after start.
- Sign-out revokes intent and stops native tracking without requiring a mounted
  root. Sharing opt-out stops native tracking; opt-in notifies the root to perform
  the normal owned startup, never an unguarded background start.
- Known durable revocation (including the legacy sharing-off flag) reaches native
  shutdown BEFORE permission/network/battery work and outside both FIFOs. Pending
  operations remain quarantined; late native ready/config/start/position callbacks
  reissue stop when obsolete. Location authorization does not inspect notification
  permission, so a stalled notification permission bridge cannot gate GPS/privacy.
- Battery contact is separate from GPS consent. Android battery PATCH uses a
  current, server-verified ownership receipt, rechecked before sending. It does
  not use the SDK's cached token. A legitimate owner can report battery when GPS
  permission is denied; missing/obsolete sessions or wrong ownership cannot.
- Failed native starts have a persisted five-minute cooldown. No retry timer,
  recursive recovery loop, or new SDK listener is installed. Three ownership/
  policy requests run concurrently, each with an eight-second abort bound.
- Expo's existing background notification task is registered from the package
  entry before Router. Its SDK 54 dataString payload and the mounted Android
  listener share the same guarded native recovery/acquisition. Push-supplied member
  IDs do not grant ownership. A durable 30-second acquisition gate (five minutes
  for the same request ID) prevents duplicate GPS work across listener/runtime
  reloads; duplicates still enforce current privacy state. Authorized battery
  contact remains available, including during GPS start cooldown or GPS withdrawal.
- Notification explainability: the backend initiates recovery for a stale member;
  only that device's independently verified owner/member can acquire; data-only
  delivery remains invisible; arrival depends on the existing high-priority wake;
  duplicate listeners share a native lifecycle FIFO and durable acquisition gate.
  No outbound payload, visible notification, new timer, or listener is added.
- Backend remains unchanged. The client stringifies the SDK's numeric tracking
  mode to satisfy the existing deployed string contract. A legitimate null Mongo
  write timestamp is accepted without deleting or rewriting stored snapshots.

## Verification limitations and review

### Correction of the two remaining review blockers

Android WorkManager, SDK-headless heartbeat/motion/activity, silent recovery,
and JS-alive one-shot callers now acquire with `persist:false`. The installed
SDK contract says this disables SQLite persistence; a JS check after
`persist:true` cannot undo a write or native HTTP enqueue that already happened.
No `insertLocation`, `sync`, or native offline-queue insertion is used for these
one-shot results. Existing autonomous native tracking and iOS transport remain
unchanged.

Before acquisition, a verified receipt, durable policy stamp, and authorization/
execution generation are captured. All Android one-shot native calls share the
existing quarantined lifecycle FIFO; shutdown still bypasses it. After the fix,
the client rechecks session, location permissions, revocation, policy stamp,
generation, and fresh server ownership/sharing. Confirmed server withdrawal
invokes the existing shutdown/revocation path. Only then can an explicit PUT
start, using the receipt's exact token/member and the original GPS capture
timestamp. Sampling/marked native observer events cannot publish coordinates
into the JS diagnostic buffers before that fence.

Foreground location inspection excludes notifications. Optional Android
notification inspection also runs outside the location/disclosure queue, so a
rejected or lost query cannot strand repair. Actual interactive permission
requests retain their existing shared UI-request serialization; location,
disclosure, consent, session, ownership and revocation checks remain mandatory.
An Android startup request supersedes the acquisition generation before queuing.

Tradeoffs/limits: a one-shot upload that fails offline is discarded, not queued
for a potentially different future owner. Future authorized wakes may sample
again; autonomous native tracking keeps its existing queue. Once an authorized
HTTP request has been dispatched, JS cannot retroactively undo server acceptance
if withdrawal occurs in flight. This change fences results completing after
withdrawal, not a distributed atomic consent transaction. Native SDK internals,
sampling-event metadata and real Build 68 behavior still require separately
authorized physical acceptance. No new native module, dependency, build setting,
runtime version, notification payload or backend endpoint was introduced.

Unit tests simulate root unmount, module reload, boot/termination handlers,
WorkManager wakes, consent/ownership rejection and late native callbacks. They
do not prove Android cold React-context startup, legal foreground-service startup,
OEM scheduling, reboot behavior, actual battery drain or real server acceptance.

Prior review findings included native consent shutdown, already-enabled ownership
validation and cached-token battery writes. The later physical-device analysis
also identified cold-wake privacy ordering and legacy-intent migration gaps.
This corrective pass regression-tests those cases. A fresh independent adversarial
review must name the exact final commit and return APPROVE or BLOCK; its verdict
is recorded in the PR report rather than presumed by this document.

The legacy backend SOS live-service suite is not an isolated test and must not be
used against production for acceptance. Use offline medication/SOS regressions.
The existing repository legacy-identifier audit failure is compared against the
approved baseline rather than repaired in this narrowly scoped PR.

Verification runs focused and full frontend suites against exact approved main,
TypeScript, changed-file lint, offline medication/SOS behavior and isolated backend
contracts. Actual results and the independent verdict belong to the exact-commit
PR report. Never count a live-service SOS test as isolated acceptance or run it
against production. Stalled native starts remain quarantined while explicit stop
bypasses their queue; mocks do not prove Android's native service shutdown behavior.

## Separate release-health issue (not redesigned here)

Recent battery/device contact can make the individual member "Updated" label recent
and "Tracking Healthy" visible beside severely stale GPS, while the Family location
timestamp uses actual location freshness. Treat this as a separate release-blocking
health/freshness correction; this patch does not redesign caregiver status UI.

## Physical-device procedure after separate release approval

1. Preserve the original full diagnostic export. Record binary build, runtime,
   active OTA identity, OS version, member binding, permissions and sharing state.
2. Preserve the older physical control. On a separately authorized test phone and
   test member, stage the approved Build 68/runtime 1.3.0 bundle with a legitimate
   legacy binding and unexpectedly disabled SDK; no new intent record or foreground
   startup may substitute for this test. Confirm the approved bundle actually loads
   in a cold/headless process. Observe WorkManager and a data-only silent push
   independently migrating/restarting tracking and fresh GPS server acceptance.
3. Separately open once for authorized new-intent startup, then destroy/recreate
   the activity normally; leave the UI absent. Confirm tracking
   is not stopped merely by React root teardown.
4. Test ordinary process death, then a separate reboot. Do **not** use Android
   Force stop: it intentionally suppresses background execution. Observe both
   locked/pre-first-unlock behavior and recovery after unlock.
5. Keep the UI closed. Capture native process identity, SDK state, headless or
   independent-wake recovery result, fresh authorized GPS and backend HTTP success
   (one-shot samples must not enter native SQLite before their authorization fence).
   Battery success alone and warm-process uploads do not pass this test.
6. Exercise sign-out while a recovery start is pending, permission queries that
   reject or never return, both permission-denial
   paths, permission revocation, local/server sharing opt-out, member removal/
   reassignment, missing secure session, offline ownership lookup and repeated
   wakes. Confirm no unauthorized restart or stale-owner battery write.
7. Reauthorize through the normal foreground path and repeat. Confirm no duplicate
   listeners/service notifications or repeated stop/start loop. Observe battery
   consumption and verify the five-minute failed-start cooldown.
8. Verify null-timestamp snapshots remain readable, telemetry no longer gets the
   diagnosed 422, and medication routing/acknowledgment plus SOS still work.

Use backup communication and independently monitor the phone throughout. This
document authorizes no merge, deployment, OTA publication, Android build, device
update, production mutation, or Google Play submission.
