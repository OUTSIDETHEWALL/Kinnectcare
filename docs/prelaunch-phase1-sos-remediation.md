# Pre-launch remediation tracker — Phases 1–3

Baseline: `1f83570b3145a5bec441d46f9dc0b21e0fbdbca0`.

Phase 1 implementation scope was SOS safety only. The owner subsequently merged
PRs #196, #197 and #198, accepted Phases 1 and 2, and authorized Phase 3's
family-code, account-deletion and SOS-retention corrections with separate draft
PRs and independent reviews. Agent merges, deployments, OTA, AAB, live
pushes, production data/index/configuration changes and billing changes remain
unauthorized. Rotation is implemented in a reviewed unmerged draft. Account
deletion's three High findings and a subsequent SOS compatibility regression
are corrected and independently closed at code re-review. The owner approved
minimum delivery coordination; final guarded regression evidence is pending.
Retention and the consolidated report remain separate downstream work, after
reporting deletion results and remaining risks to the owner.

## Current phase status

| Phase | Status / evidence | Remaining gate |
| --- | --- | --- |
| 1 — SOS safety | [PR #196](https://github.com/OUTSIDETHEWALL/Kinnectcare/pull/196) owner-merged at `0396e5b9b168699ca0e1baa7952b7afa08548a12` | Deployment/physical acceptance pending certification; do not infer acceptance from a merge. A newer Railway deployment was observed read-only, but Phase 1 runtime behavior was not certified here. |
| 2 — Medication/check-in reliability | [Medication #197](https://github.com/OUTSIDETHEWALL/Kinnectcare/pull/197) and [check-in #198](https://github.com/OUTSIDETHEWALL/Kinnectcare/pull/198) owner-merged; both passed independent adversarial re-review with no unresolved Critical/High findings in their affected implementations | Separately approved rollout/physical acceptance; stage/refill decisions remain unapproved |
| 3 — Family/deletion/SOS retention | [Rotation draft #199](https://github.com/OUTSIDETHEWALL/Kinnectcare/pull/199) implemented, independent PASS. [Deletion draft #200](https://github.com/OUTSIDETHEWALL/Kinnectcare/pull/200): approved corrections implemented; independent code re-review PASS, all four High findings closed; final regression evidence pending. Existing retention draft #190 untouched | Final evidence review and results/risk report before retention/consolidated report. Unknown interrupted sends fail closed pending controlled review. No merge/release authorization |
| 4 — Google Play Billing | Pending | Architecture approval before implementation/configuration |
| 5 — Security and automated checks | Pending | Triage confirmed risks and repair test causes; baseline failures are not green |
| 6 — Final Android AAB/Play verification | Pending | Approved reviewed corrections, separate build/upload/physical acceptance authorization |

Phase 2 reports:
- `docs/prelaunch-phase2-report.md`
- `docs/prelaunch-phase2-medication-midnight.md`
- `docs/prelaunch-phase2-checkin-reliability.md`
- `docs/prelaunch-phase2-medication-stages-review.md`
- `docs/prelaunch-phase2-refill-review.md`

Phase 3 evidence:
- `docs/prelaunch-phase3-family-code-rotation.md`
- `docs/prelaunch-phase3-account-deletion.md` — deletion implementation, review,
  test evidence, recovery/rollout limitations and rejected-request incident;
  not the final consolidated Phase 3 report.

## Phase 1 corrections

| Finding | Severity / root cause | Correction | PR / tests / independent review | Remaining evidence | Eventual delivery |
| --- | --- | --- | --- | --- | --- |
| Unsupported SOS success assertions | Critical: UI assumed server receipt meant all-device delivery and emergency dispatch; stored message claimed dispatch too | Require a matching, account/family/session-scoped volatile server receipt; distinguish recording, notification request, absent/unknown/GPS/last-known location, capture time/accuracy, and dialer-open versus unverified call. Remove unsupported dispatch message from both backend entrypoints. | PR #196 owner-merged. Focused regressions passed; independent adversarial review PASS after closing two findings. | Play-installed physical SOS test; no delivery or call completion claim without actual evidence | Backend deployment + Android client release; new final AAB for first install |
| Emergency dialer gated on network/GPS success | Critical: dialer intent ran only after POST success | Always expose an explicit Call 911 action through preparation, GPS, sending, failure and retry. Open only on tap; dialer rejection cannot alter SOS success. A 3-second UI timeout provides manual guidance and permits another explicit tap without automatic retry. | Same merged PR #196; pending/late dialer tests passed; independent review PASS | Physical dialer-open/rejection test; do not place a non-emergency call | Android client release; no native dependency or permission change |

The successful-send automatic dialer launch is replaced by the explicit,
always-visible Call 911 action requested for this phase. No emergency call is
placed automatically. A delayed/failed HTTP response is described as unconfirmed,
not proof that the server failed to save the alert.

Receipt metadata is process-local, excludes coordinates, is scoped to the account,
family and session epoch, and follows current route/store changes reactively.
It is cleared at sign-in/sign-out, membership changes, a new send, an abandoned
handoff and when leaving confirmation; it is not reconstructed from deep links.
Existing SOS creation, family fanout, boost, acknowledgment and resolution
implementations are otherwise unchanged. No tracking, authorization, consent
generation, incident location fallback, or retention/index implementation changes.

## Remediation findings and deferred work

| Audit finding | Severity / root cause | Proposed correction / decision | PR / tests / review | Remaining blocker | Eventual delivery |
| --- | --- | --- | --- | --- | --- |
| Midnight medication escalation | Critical safety reliability: only today's slots evaluated; related High DST acknowledgment mismatch | Bounded prior-day family window and UTC/first-fold identity consistency; preserve existing arbitration/deduplication | Owner-merged #197; re-review PASS; implementer 86 passed/1 baseline failure plus 2 real Mongo tests; reviewer 100 passed/1 baseline failure | Approved delivery and physical acceptance | Backend deployment only for this correction |
| Missed check-ins require polling | Critical safety reliability: detection runs from read requests; no durable fanout recovery | Independent startup worker, family-fenced per-device outbox and versioned schedule lifetime | Owner-merged #198; re-review PASS; 40 real Mongo tests passed; relevant baseline fixtures 34 passed/32 failed unchanged | Startup indexes and approved delivery/physical acceptance | Backend deployment; additive outbox/revision data and indexes, no destructive migration |
| Three-stage/refill scope mismatch | High product-scope gap: only two automatic medication stages; refill workflow absent | Separate source-based reports complete; recommend minimal designs without choosing timing/thresholds/recipients | Documentation in merged #198; no new product behavior implemented | Owner decisions/implementation approval required | Backend/client scope depends on design; native delivery requirements not assumed |
| Family-code rotation unreachable | High, reproduced: client URL returned 404; dormant write lacked family fence; review additionally found Medium auth provisioning before rotation | Register endpoint; current-owner check and replacement share admission's fence; read-only rotation auth prevents implicit family creation; preserve memberships/INV tokens | Draft #199; independent closure PASS, no C/H/M remaining; 29 new + 113 existing Mongo passed, 126 offline passed, 21 skipped; 3 baseline permission-fixture failures unchanged; see Phase 3A report | Owner review/merge, approved backend delivery and acceptance | Backend deployment only; no migration/index changes |
| Ordinary care history blocks deletion | High: ordinary self-care history rejected; retained OTP/invite/send races identified during review | Classify verified self records, transactionally revoke original identity, fence invitations and reserve deletion-sensitive sends | Draft #200; independent code re-review PASS, four High findings closed; final regression evidence pending | Owner review; controlled unknown-send recovery, drained-worker rollout and physical acceptance require separate authorization | Backend/client delivery; additive collection/counters, separately approved performance indexes; no destructive backfill |
| Resolved-SOS expiration / policy mismatch | High: expiration/index behavior needs reconciliation | Approved rule: resolved SOS expires after 30 days; never expire active/unresolved; clear expiry on reopen | Existing draft PR #190 identified, not duplicated or modified; not validated here | Phase 3 actual index/reopen/policy verification; production migration separately approved | Backend/client and possibly approved index migration |
| Android subscription blocker | Critical release gate: Stripe-only native upgrade flow | Architecture proposal for Play purchases + unified backend entitlements, preserving legitimate Stripe use | Not started | Architecture approval before billing implementation; independent review | Backend + native dependency + AAB + Console configuration |
| Security findings/logging | High pending reachability triage | Separate real deployed risks from duplicates/conditional/dev findings; redact sensitive logs | Not started | Phase 5 investigation and focused review | Depends on confirmed findings; no broad upgrade assumed |
| Automated verification failures | High quality gate: mixed defects, stale mocks and environment gaps | Repair causes, not assertions; isolated databases/network controls | Baseline frontend: 4 failed suites/8 failures; backend incomplete plus check-in mock failures | Phase 5; focused Phase 1 tests do not declare the entire repository green | Mostly development-only; deployment if a production defect is corrected |
| Build 81 first-install outdated code | Critical release gate: embedded source predates corrected SOS; OTA launch wait zero | Final approved AAB with corrected embedded bundle and highest-versionCode evidence | Not started | All corrections reviewed/merged with owner approval; separate build approval | New AAB + controlled internal tests; owner manual upload |

## Review and release boundaries

The 30-day resolved-SOS rule is approved, but this PR does not certify the current
production indexes enforce it. Existing draft PR #190 must be inspected in Phase 3.
No blanket alerts TTL or production migration is introduced here.

Notification explainability is unchanged: user SOS activation causes the existing
family-scoped fanout; current visible/silent payloads, timing and deduplication are
not changed by these status/calling corrections. A request to send is not proof of
device receipt or family response.

No database migration, native package, runtime, permission, signing, billing,
location engine or background-motion configuration change is needed for Phase 1.
The existing public-release hold remains in effect.

## Completed verification

- Full frontend Jest: **102 suites passed, 4 failed; 1,259 tests passed, 8 failed**.
  The same baseline failures remain in deepAsyncTrace, withAndroidStartupRecorder,
  schedulingTracing and legacyArtifactRepositoryAudit. The command used
  `--runInBand --forceExit`; this is not a fix for the existing runner-lifetime issue.
- Changed-file ESLint: **0 errors, 26 warnings** (existing require/unused patterns).
- TypeScript: the same baseline `schedulingTracing.test.ts:68` TS2345 remains;
  no additional reported errors.
- Socket-blocked backend suites, each isolated in a fresh interpreter:
  optional-location SOS **7 passed**; refresh authorization **29 passed**;
  refresh trace consent **32 passed**; real loopback SOS transfer/history
  **39 passed, 2 failed**. Total **107 passed, 2 failed**.
- The two transfer failures are
  `test_resolution_change_during_transfer_retries_and_blocks` and
  `test_concurrent_dependent_insert_after_snapshot_must_block`. Their test and
  transfer implementations are unchanged from baseline. They need Phase 3
  investigation; neither was suppressed or repaired in this narrow PR.
- Independent adversarial review initially found stale cross-route/session
  evidence and a pending-dialer latch. Both were corrected with regression tests.
  Focused closure review: **PASS**, high confidence, **96 offline frontend tests
  passed**. No introduced Critical/High issue identified.
- Preview restarted and compiled. Unauthenticated screenshot reached the existing
  Important Notice gate, not the signed-in SOS UI. No claim of Android visual,
  actual dialer, actual notification-delivery, or physical-device verification.
- No live SOS, refresh push, emergency call, production database operation,
  deployment, OTA, native build, billing action or Play configuration change.

## Remaining Phase 1 physical acceptance

After separately approved integration/release delivery, test two consenting
family phones: cancel activation, successful SOS, GPS denied/pending/stale,
offline/retry, Call 911 during every send state, missing/rejected dialer,
acknowledgment/resolution and consent withdrawal during an outstanding fresh fix.
Confirm the dialer opens but do not place a non-emergency 911 call.
