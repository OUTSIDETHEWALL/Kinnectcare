# Android cold-location recovery — review and acceptance

## Scope and evidence

Severity: **Critical** background-location reliability; Google Play release blocker.
The October 8 production OTA contains the permission/startup fix. The October 10
OTA does not change its recovery paths. Diagnostics establish a termination-time
headless invocation, disabled SDK state, independent battery wakes that skipped
GPS, and reporting restored by foreground startup. The retained engine buffer
does not establish which specific call initially disabled the SDK.

This correction removes UI-unmount-driven native shutdown and adds authenticated
recovery on existing boot/termination/heartbeat/moving-event and battery wakes.
No new scheduler, native module, dependency, or location transport is introduced.

## Authorization and shutdown

- Only owned, successful background-ready foreground startup records durable
  tracking intent. Previous installations require one successful foreground
  startup after applying this OTA; native cached credentials do not grant intent.
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
- Battery contact is separate from GPS consent. Android battery PATCH uses a
  current, server-verified ownership receipt, rechecked before sending. It does
  not use the SDK's cached token. A legitimate owner can report battery when GPS
  permission is denied; missing/obsolete sessions or wrong ownership cannot.
- Failed native starts have a persisted five-minute cooldown. No retry timer,
  recursive recovery loop, or new SDK listener is installed. Three ownership/
  policy requests run concurrently, each with an eight-second abort bound.
- Backend remains unchanged. The client stringifies the SDK's numeric tracking
  mode to satisfy the existing deployed string contract. A legitimate null Mongo
  write timestamp is accepted without deleting or rewriting stored snapshots.

## Verification limitations and review

Unit tests simulate root unmount, module reload, boot/termination handlers,
WorkManager wakes, consent/ownership rejection and late native callbacks. They
do not prove Android cold React-context startup, legal foreground-service startup,
OEM scheduling, reboot behavior, actual battery drain or real server acceptance.

The initial independent adversarial review was BLOCK: native consent shutdown,
already-enabled ownership validation and cached-token battery writes were
inadequate. Those findings were corrected and regression-covered. The subsequent
adversarial check is a main-agent read-only review, not a second independent review.

The legacy backend SOS live-service suite is not an isolated test and must not be
used against production for acceptance. Use offline medication/SOS regressions.
The existing repository legacy-identifier audit failure is compared against the
approved baseline rather than repaired in this narrowly scoped PR.

Final verification against the approved clean main:

| Check | Result |
| --- | --- |
| Focused recovery/startup/teardown/diagnostics/transport suites | 9 suites, 124 tests passed |
| Full frontend suite, approved baseline | 621 passed, 1 existing audit failure |
| Full frontend suite, correction | 663 passed, same 1 audit failure; no new failures |
| Isolated backend medication and deployed tracking-mode contract | 48 passed |
| TypeScript | Passed |
| Changed-file lint | 0 errors, 93 warnings, matching baseline count |
| Web preview | Unauthenticated disclaimer rendered; signed-in/native UI not visually verified |

**Final main-agent read-only adversarial verdict:** APPROVE for PR code review in
the tested paths; **BLOCK for Google Play release** until physical acceptance.
No recurring retry timer or duplicate native listener was added. Late starts,
secure-session read races, local/server sharing disable, enabled-engine ownership,
and both independent/headless battery transport are guarded. An SDK promise that
never settles is not proved safe by these tests: the existing serialized native
queue awaits its completion. Include stalled/late native callbacks in acceptance.

The rejected legacy live-SOS run is not counted as passing coverage. All observed
remote responses were authentication failures; no successful mutation was observed.

## Physical-device procedure after separate release approval

1. Preserve the original full diagnostic export. Record binary build, runtime,
   active OTA identity, OS version, member binding, permissions and sharing state.
2. On Build 68/runtime 1.3.0, apply the separately approved OTA and open once.
   Confirm owned background-ready startup and successful location/battery uploads.
3. Destroy/recreate the activity normally; leave the UI absent. Confirm tracking
   is not stopped merely by React root teardown.
4. Test ordinary process death, then a separate reboot. Do **not** use Android
   Force stop: it intentionally suppresses background execution. Observe both
   locked/pre-first-unlock behavior and recovery after unlock.
5. Keep the UI closed. Capture native process identity, SDK state, headless or
   independent-wake recovery result, fresh persisted GPS and backend HTTP success.
   Battery success alone and warm-process uploads do not pass this test.
6. Exercise sign-out while a recovery start is pending, both permission-denial
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
