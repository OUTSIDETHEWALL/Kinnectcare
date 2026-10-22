# Initial ownership in-flight sharing — local corrective candidate

## Evidence, severity, and boundary

High severity: native dispatcher congestion delays core startup. Confidence is
high that redundant initial ownership triplets contributed materially to Joyce's
captured queue: 21 of 30 waiting calls. Charles's historical storm lacks complete
origin retention; do not claim all of that storm has the same source.

This candidate shares raw read promises, NEVER authorization verdicts. No GPS,
dispatcher, backend, timeout/retry, scheduling, or second-verification change.

## Call-path inventory before implementation

- SDK/headless, foreground-position, patrol, WorkManager and independent recovery
  converge on recoverFromIndependentWake -> evaluateWakeAuthorization ->
  verifyWakeOwnership. Only that initial call opts in, supplying the captured
  engine lifecycle generation.
- The later second-ownership call and acquisition-ownership call remain fresh,
  independent reads. Token-update verification also remains independent.
- Engine configured startup has its own Axios preference/auth/member triplet,
  including target replacement/adoption semantics. Necessary independent scope;
  NOT folded into this candidate.
- Legacy migration, recovery-cache-miss and device-contact paths have distinct
  contracts. Necessary independent scope; unchanged.
- Dashboard members/summary/alerts, auth restoration, check-in reads and
  emergency-resume alert reads are not interchangeable ownership triplets.
  Necessary independent work in this correction. Shared foreground members
  already has its own overlap-only mechanism. Exact extra mount/refresh causes
  are unknown, not grounds to remove calls.

## Sharing key and admission

The map exists only inside one JS module/runtime (no cross-runtime/native lock).
The private in-memory key includes the exact token, a mutation revision for the
app session, backend, full intent stamp/nonce, native owner and authorization
generation, captured engine lifecycle generation, and locally known server
consent generation (including unknown). A matching durable intent must bind the
same user/member/backend as the native authority. The token is never logged,
exported, persisted, or included in diagnostic identifiers.

Only a non-revoked, mutation/shutdown-free authority is shareable. Missing,
legacy, unbound or otherwise unproven contexts keep the existing independent
read path. Unknown server consent is not permission: every consumer still
validates the returned preference, linked identity and consent tuple, and the
existing later independent checks/publication fences remain mandatory.

## Per-consumer validation and invalidation

- Each consumer captures its session revision before asynchronous reads.
  saveToken/clearToken mark mutation entry AND completion. During mutation the
  shared path is unavailable; an old result cannot pass the revision fence.
- Owner/generation, durable policy, current token and consumer isCurrent are
  rechecked after the network work. A shared consumer additionally requires its
  admitted native authority to remain mutation/shutdown-free.
- Consent generation is part of admission. If another response has since
  installed a different consent generation, an older response may not overwrite
  it. Multiple consumers accepting the same returned generation remain valid.
- Permission reads stay per consumer and existing downstream permission and
  consent fences are unchanged. No shared result starts/publishes GPS itself.
- A canceled consumer does not abort another consumer's read. If all cancel,
  the existing HTTP operations finish/fail under their unchanged 8-second
  timeouts; every canceled consumer discards its result. No side effects are
  performed by the shared loader.
- Promise success or rejection immediately removes the flight; failed/timed-out
  results are not retained. Old cleanup cannot delete a replacement flight.
  There is no cache TTL, debounce, delay, new timeout, retry or throttle.
- A new engine lifecycle or JS runtime cannot join the previous flight.

## Diagnostics and validation plan

The actual requests retain the initiating operation's Build 72 origin, numeric
RN binding and all existing HTTP/queue/task instrumentation. Followers create
no fake HTTP rows. Existing operation/wake records remain available. Local tests
count actual dispatches and exercise the real evaluate/verify path, not merely a
standalone map. Native hooks and Full Diagnostics stay intact.

Validate equivalent bursts of 2, 4, 7, 10 and 100 consumers; mixed contexts;
success, HTTP/transport failure, unchanged timeout, cancellation, logout/login,
same-token replacement, consent/authorization/lifecycle/runtime changes and late
completion. Compare baseline independent triplets against the candidate. Model
queue impact with five running slots and retain nine independent Joyce calls;
label this synthetic evidence, not phone performance.

No merge, push/release, OTA, Android binary, phone operation, Railway or Play
change is part of this local candidate.

## Local validation results

### Request reduction and synthetic queue census

The tests execute the real evaluate/verify functions and count actual fetch
dispatches with controllable responses. Baseline uses the unchanged independent
path; candidate opts in to initial sharing. All consumers receive independently
validated outcomes.

| Equivalent consumers | Independent ownership HTTP calls | Shared ownership HTTP calls |
| --- | ---: | ---: |
| 2 | 6 | 3 |
| 4 SDK wakes | 12 | 3 |
| 7 (4 SDK + 3 foreground-position) | 21 | 3 |
| 10 | 30 | 3 |
| 100 | 300 | 3 |

With five pre-existing running calls held, and nine independent calls preserved:
the Joyce-style waiting census is 30 -> 12; the 100-consumer stress census is
309 -> 12. This is a deterministic five-slot model, NOT an Android scheduling
measurement or a prediction of milliseconds saved.

### The nine other calls at the captured Joyce census

| Origin / endpoint | Calls | Classification in this candidate |
| --- | ---: | --- |
| Dashboard billing, summary, alerts | 3 | Necessary distinct dashboard contracts; independent |
| Check-in route | 1 | Necessary independent feature read |
| Emergency-resume alerts | 1 | Independent emergency-recovery contract; not removed merely because dashboard also reads alerts |
| Foreground auth | 1 | Independent session/auth response handling; not substituted with the raw ownership fetch |
| Foreground API preferences | 1 | Unknown exact initiating effect/equivalence; unchanged |
| Foreground API normalized `other` | 2 | Unknown exact endpoints from retained evidence; unchanged |

No additional unintentionally duplicated request is established by this
classification. A repeated endpoint is not proof that its contracts are
interchangeable.

### Checks and controls

- TypeScript: tsc --noEmit PASS.
- Focused new tests: 42/42 PASS (37 sharing/race/burst cases and 5 real API
  session-boundary cases).
- Full Jest run: 1,008 PASS / 2 FAIL, 88 suites (86 pass / 2 fail).
- An isolated worktree at the unchanged starting revision reproduces the SAME
  two failed assertions: startup-recorder contract expects 22 functions but
  current source has 26; historical identifier repository audit finds fixtures
  outside its quarantine. Neither source is changed by this candidate.
- Existing headless tests additionally assert the real engine entry supplies the
  initial phase and lifecycle generation. Their GPS assertions remain intact.
- Final focused rerun including those existing headless tests: 51/51 PASS across
  three suites. New/updated focused test files and the sharing module lint
  without errors or source warnings.
- ESLint: zero errors; existing warnings in the larger existing files remain.
- Production native authority plus actual evidence dependencies compile against
  the Android surface. Origin observers compile against actual RN/OkHttp APIs.
- JVM: three unchanged authority scenarios and seven origin-observer behavior
  groups PASS, including 120 real OkHttp calls, task/deadline/settlement mapping,
  process recreation, and 10,000-event observer pressure.
- The stock authority-check shell script omits its evidence dependency and does
  not compile as-is. The separate production compilation includes the real
  dependencies. Plain-JVM authority execution substitutes storage/clock and the
  verbose evidence writer; an initial attempt using real Android HandlerThread
  hit unavailable Android native functions. The clean substitute run passes.
  This is NOT full Android/Expo compilation or device execution.
- Full Jest also emits open-handle/after-teardown diagnostics; their baseline
  status was not separately established. No claim of a clean full-suite exit.
- Backend tests: not applicable / not run; no backend diff.
- Existing web workflow restarted; unauthenticated Important Notice renders.
  Signed-in screens and Android behavior were not visually verified.

## Protected behavior and remaining acceptance

No GPS acquisition/filter/publication/replay, stationary/recovery threshold,
heartbeat, scheduling, dispatcher, network timeout/retry, or backend policy is
changed. No authorization result is shared or persisted. The initial path gains
fail-closed stale-context rejection; unchanged-valid contexts still authorize.
Second/acquisition/startup/token checks remain independent.

Session mutation bookkeeping does not replace token storage, token notifications,
logout shutdown or consent/permission logic. It prevents old initial reads from
authorizing across those existing transitions.

Build 72 native diagnostics and Full Diagnostics are unchanged. Actual shared
HTTP calls are attributed to the initiating operation/wake; followers retain
their existing operation/task records but do not get fake HTTP rows or a newly
invented native parent link. Physical validation must examine both call counts
and these existing lifecycle records.

No candidate Android binary was produced. Phone startup latency, background
moving-GPS preservation on the corrected candidate, battery impact and delivered
binary behavior remain unproven until separately authorized physical validation.
The old Charles storm cannot be completely reconstructed from evicted records.

Candidate identity is supplied with the final report after the local commit;
the branch is fix/initial-ownership-inflight. No remote PR/push is performed
under this local-only authorization.
