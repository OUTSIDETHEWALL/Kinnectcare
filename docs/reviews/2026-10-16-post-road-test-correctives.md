# Post-road-test corrective release review

**Historical narrow review.** Superseded by
`2026-10-16-build70-full-launch-blocker-sprint.md`; its results and release gate
are the current handoff. The earlier failed-run evidence below is retained.

## Status and authority

Implementation and review only. No merge, deployment, OTA, Android build, Play
submission, production configuration/data mutation, or phone operation was performed.
The October 16 physical test remains **FAILED**, despite confirmed background GPS
movement. This branch is not a physical-acceptance or release approval.

Source baseline: approved Build 69 commit `8cf33fb`. The two unrelated local
documentation commits above that baseline are deliberately excluded.

## Changes and severity

1. **Critical — GPS integrity/privacy:** atomic unknown-age publication guards
   protect both capture fields and coordinates. Timestamp ordering, replay,
   ownership and sharing checks remain enforced. Battery/presence remain separate.
   Check-in/welfare side effects cannot erase verified GPS.
2. **Critical — acquisition lifetime:** missing request consent generation means
   legacy generation zero, never the server's current consent lifetime. Native
   SDK extras persist the generation with each capture; explicit one-shots capture
   the verified generation before GPS. Native replay cannot inherit renewed consent.
   Dashboard/resume publishers use the guarded Android contract; foreground iOS
   retains provider capture time with session/member/policy checks. The retired
   Expo background fallback retains actual provider time and legacy generation zero.
3. **High — diagnostic truth:** immutable per-event storage avoids shared-array
   overwrite; independent quotas protect motion, heartbeat and delivery evidence
   from operational polling. A short legacy array is a compatibility cache only.
   HTTP contact does not certify coordinates. Accepted native receipts correlate
   capture UUID/time, native owner/generation and server consent lifetime with a
   background capture observation. Repeated captures and a current native state
   are necessary for a green claim. A one-shot does not establish sustained tracking.
   Native state, capture, background delivery, explicit acquisition, heartbeat,
   motion and contact are displayed separately.
4. **High — lifecycle:** configuration has independent native mutation exclusion;
   GPS acquisition failure/backoff cannot gate required runtime registration.
   Genesis adoption precedes runtime registration; `ready(reset:false)` runs even
   for an already-enabled tracker. Configuration-recovery start throttling remains
   separate. No stop-first recovery was introduced; revocation/shutdown quarantine
   and UNKNOWN behavior remain protected.
5. **High — export:** process-wide JS locks cover collection through sharing.
   A pinned prebuild patch fixes Expo Sharing exception cleanup, operation-scoped
   results, lost-result return to the foreground, and explicit cancellation on
   Activity/AppContext destruction. Stale cleanup cannot release a subsequent
   request. No timer resets an active chooser.
6. **High — startup evidence:** instrument root/gates, restoration, authorization,
   configuration, dashboard load, API completion and first usable non-error Family
   render alongside existing native checkpoints. No speculative shorter timeout.
   Confirmed Motor Future scheduling uses `asyncio.ensure_future`; no attribution
   of the observed startup delay to geocoding is made.

## Adversarial review

The independent review initially returned FAIL for omitted consent generations,
callback-time background classification, duplicate-as-delivery evidence, unreliable
sharing fallback restoration, and a usable-render marker on failed loads.
These findings were corrected and covered by subsequent focused tests and
self-review. No second independent PASS is claimed.

Health tests that explicitly required HTTP/contact alone to turn the card green
were replaced with the corrected evidence contract, including negative contact,
clock-skew, owner/generation, replay, callback-origin and persistence cases.
Existing RootNav, acquisition, native-fence and recovery regression suites pass.

## Verification

- Backend: **95 passed**, 40 warnings, across coordinate integrity, adversarial
  road-test sequences, consent write races, check-in/welfare consent, SOS optional
  location, medication occurrences, and location-name persistence.
- Frontend full suite: **867 passed, 1 failed; 74 suites passed, 1 failed**.
  The remaining `legacyArtifactRepositoryAudit` failure is pre-existing medication
  fixture content already present at the approved baseline; not introduced or
  suppressed here. Historic-data cleanup remains separate.
- TypeScript: `npx tsc --noEmit --pretty false` passed.
- `git diff --check` passed.
- Jest used `--runInBand --forceExit`; this does not establish clean timer teardown.
- Web development preview restarted and public disclaimer rendered. Signed-in
  Diagnostics UI and Android behavior were **not** visually/device verified.
- Native configuration checks use the contract model. Expo Sharing checks verify
  the installed source patch, not execution on Android. No Android compilation
  or Activity-recreation device test was performed.

Backend command:

```sh
PYTHONDONTWRITEBYTECODE=1 python -m pytest -q \
 backend/tests/test_coordinate_capture_integrity.py \
 backend/tests/test_road_test_provenance.py \
 backend/tests/test_location_consent_write_race.py \
 backend/tests/test_checkin_location_consent.py \
 backend/tests/test_sos_optional_location.py \
 backend/tests/test_medication_occurrence_reliability.py \
 backend/tests/test_task101_location_name_persistence.py \
 --disable-warnings --tb=short
```

Frontend command:

```sh
cd frontend
npx jest --runInBand --forceExit --silent
npx tsc --noEmit --pretty false
```

## Release surfaces and compatibility

- **Backend-only code:** atomic GPS provenance guards, additive accepted receipt
  fields, consent admission and geocoding Future correction in `backend/server.py`.
- **JS-capable code:** guarded foreground publication, immutable diagnostic journal,
  evidence classification/UI, JS export locks, startup milestones and tests.
  These capabilities do not make the combined patch safe to send to Build 69.
- **Build 70 binary required:** native configuration lifecycle and Expo Sharing
  Android patch. Source config prepares versionCode **70**, version/runtime
  **1.3.1** (appVersion policy). No binary was created.
- **Coordinated protocol required:** old clients without capture generation are
  intentionally generation zero. After consent has renewed they cannot publish
  GPS under the new lifetime; presence/battery can still update. The legacy
  check-in/Expo fallback cannot adopt renewed consent either. Release review must
  plan compatible client/backend rollout rather than enabling strict admission
  blindly on an old-client population. Native receipt correlation also requires
  the additive backend receipt fields.

Confidence is high in the locally tested backend/JS invariants, moderate in the
uncompiled native lifecycle correction pending separately authorized binary and
device validation. This is review material, not a claim of production readiness.

## Preserved physical acceptance test

Only after separately authorized release:

1. Record exact departure/background time; use Home to background the tracked phone.
2. Drive to a clearly different location.
3. Before reopening the tracked phone, verify changing coordinates and advancing
   `coordinate_captured_at` from the caregiver phone.
4. Park approximately seven minutes; inspect stationary/heartbeat behavior and
   continued truthful freshness/status.
5. Reopen the tracked phone; foreground activity must not erase/regress that tuple.
6. Test process recreation/recovery separately.
7. Repeat export success, cancellation, rapid taps, failure/retry and Activity
   recreation/lost-result cases on the native binary.
8. Use startup milestones to measure the observed delay; do not infer a cause
   from an unrelated fixed exception.
