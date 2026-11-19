# Pre-launch remediation tracker — Phase 1

Baseline: `1f83570b3145a5bec441d46f9dc0b21e0fbdbca0`.

Scope: SOS safety only. No merges, deployments, OTA, AAB, live pushes,
production data/index changes, or billing configuration changes are authorized.

## Phase 1 corrections

| Finding | Severity / root cause | Correction | PR / tests / independent review | Remaining evidence | Eventual delivery |
| --- | --- | --- | --- | --- | --- |
| Unsupported SOS success assertions | Critical: UI assumed server receipt meant all-device delivery and emergency dispatch; stored message claimed dispatch too | Require a matching, account/family/session-scoped volatile server receipt; distinguish recording, notification request, absent/unknown/GPS/last-known location, capture time/accuracy, and dialer-open versus unverified call. Remove unsupported dispatch message from both backend entrypoints. | This Phase 1 draft. Focused regressions passed; independent adversarial review PASS after closing two findings. | Play-installed physical SOS test; no delivery or call completion claim without actual evidence | Backend deployment + Android client release; new final AAB for first install |
| Emergency dialer gated on network/GPS success | Critical: dialer intent ran only after POST success | Always expose an explicit Call 911 action through preparation, GPS, sending, failure and retry. Open only on tap; dialer rejection cannot alter SOS success. A 3-second UI timeout provides manual guidance and permits another explicit tap without automatic retry. | Same Phase 1 draft; pending/late dialer tests passed; independent review PASS | Physical dialer-open/rejection test; do not place a non-emergency call | Android client release; no native dependency or permission change |

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

## Deferred tracker — no implementation authorized in this phase

| Audit finding | Severity / root cause | Proposed correction / decision | PR / tests / review | Remaining blocker | Eventual delivery |
| --- | --- | --- | --- | --- | --- |
| Midnight medication escalation | High: only today's slots evaluated | Include bounded previous-day occurrences, preserve identity and deduplication | Not started | Phase 2 authorization after Phase 1 report | Backend deployment |
| Missed check-ins require polling | High: detection runs from read requests | Independent server scheduling preserving existing rules/timezone/deduplication | Not started | Phase 2 investigation | Backend deployment |
| Three-stage/refill scope mismatch | High: implemented stages differ; refill workflow incomplete | Document current behavior and request approval for intervals, recipients and thresholds | Not started | Product decisions required before implementation | Backend/client; final AAB if native changes require it |
| Family-code rotation unreachable | High: missing endpoint registration | Owner-authorized transactional rotation; prove old code invalidation | Not started | Phase 3 investigation | Backend deployment |
| Ordinary care history blocks deletion | High: ambiguous ownership and terminal records rejected | Classify proven self records, preserve others and safety restrictions | Not started | Privacy/data-deletion adversarial review required | Backend deployment; migration only if justified and approved |
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
