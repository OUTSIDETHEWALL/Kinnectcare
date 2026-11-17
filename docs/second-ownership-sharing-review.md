# Second-stage ownership sharing: review and evidence

> **Rejected historical candidate — do not use as the current security review.**
> Independent review reproduced missed server-only consent withdrawal and owner
> replacement for a later consumer joining an older pending response. The
> second-stage sharing implementation has been removed. Current implementation,
> tests and risks are documented in `ownership-admission-review.md`.

## Scope and diagnosis

Severity: **Medium** startup-performance defect (startup eventually succeeds).
Security/GPS regressions would be safety-critical, so acceptance is deliberately
stricter than a request-count assertion.

The supplied Android diagnostic export showed 30 SDK-headless recovery consumers
sharing their initial ownership triplet, then submitting 90 second-stage native
HTTP calls in approximately 84 ms. At slow foreground authentication submission,
73 of 74 waiting calls belonged to that burst; the other was a battery update.
The members call waited 5,649 ms before dispatcher execution versus 444 ms in the
backend. Confidence is high that this amplification materially caused the queue.
This is not evidence that every startup delay has this cause.

Authorization covers development, tests and a PR only. No merge, Railway change,
OTA, EAS build, Play release, production configuration or database change.

## Minimal change

- Pass the existing engine generation into second-stage ownership verification.
- Admit that stage to the existing runtime-local pending-read mechanism.
- Add phase and explicit native authority generation to the equivalence key.
- Keep the historical helper name rather than refactoring unrelated callers.

The key includes phase, session mutation revision, token, backend, durable policy
stamp, owner, native authority generation, tracking epoch, engine generation and
known consent generation. These keys remain private in memory, never telemetry.
Unproven contexts fall back to independent reads (or reject an obsolete session).
The map still evicts fulfillment and rejection and is cleared on both sides of
token mutation. There is no new completed-response cache, grace period or global
API deduplication.

## Comparison with initial ownership sharing

The earlier design in `initial-ownership-sharing-design.md` intentionally left
second-stage reads independent. This PR explicitly changes only that boundary;
it does not reinterpret that earlier design as an implementation mistake.

| Earlier guarantee | Candidate |
| --- | --- |
| Share pending raw responses, never verdicts | Preserved |
| Token/session-mutation fences, including same-token re-login | Preserved and applied to second stage |
| Owner, policy, consent and lifecycle equivalence | Preserved; authority generation explicit in key |
| No initial response can satisfy second stage | Preserved by phase-separated keys |
| Each consumer rechecks token, policy, currentness and response ownership | Preserved |
| Cancellation of leader must not abort valid followers | Preserved |
| Revocation/shutdown/configuration mutations reject obsolete consumers | Preserved |
| Acquisition and unrelated HTTP remain independent | Preserved |
| No cache of completed ownership reads | Preserved |

`recoverUnexpectedlyDisabledTracking` already has an enabled-transport proof
cache. It is untouched: this PR neither introduces nor extends that cache.
Independent acquisition checks, the lifecycle FIFO, GPS/SDK configuration,
stationary updates, battery and SOS implementations are unchanged.

## Security review

Self-review of the diff and regression tests found no removed authority check.
Both phases run the same test matrix for logout, different-account replacement,
same-token re-login, overlapping session mutations, owner/generation replacement,
intent changes, shutdown, configuration mutation, consent withdrawal/newer
consent, malformed results, 401/403, disabled sharing, network failure and
consumer cancellation. Stale successes and stale failures cannot publish an
authorization verdict for another consumer.

Only exact overlapping contexts may share; stage or lifecycle mismatches cannot
join. Fresh second-stage loads cannot join initial loads, even while those
initial loads remain pending. Settled second-stage loads are not reusable.
No token, raw key or response body was added to diagnostic output.

This is an implementation self-review, not an independent security audit.
Physical Android acceptance remains outstanding.

## Dispatch measurements and verification limits

| Evidence | Second-stage calls for 30 equivalent consumers |
| --- | ---: |
| Original export, actual native HTTP starts | 90 |
| Candidate test, real ownership + real backgroundHttp, XHR.send handoffs with sharing disabled | 90 |
| Same transport test with sharing enabled | 3 |
| Candidate actual Android/OkHttp dispatches | **Not measured** |

The transport test un-mocks production `backgroundHttp` and counts calls to
`XMLHttpRequest.send`, not verifier invocations. XHR itself is a controlled test
double: these are transport handoffs, NOT actual Android-native dispatch counts.
No phone/emulator execution or candidate distribution was performed. The native
portion of the requested acceptance evidence therefore remains unmet, not green.

The real engine recovery test gives 30 consumers one initial triplet and one
new second-stage triplet; canceling one leaves 29 independently accepted. Its
later existing FIFO verification adds three more calls, for nine total in that
enabled-SDK fixture. The native-lifetime/headless-handler fixture additionally
checks 30 live tasks produce three second-stage sends, while tasks expired
before initial completion produce zero.

Expected impact: 87 fewer submissions (96.7%) for one fully overlapping,
equivalent 30-consumer second-stage cohort. Different contexts and later waves
correctly dispatch additional triplets. This is not a prediction of startup
milliseconds saved, nor proof of phone GPS/battery endurance.

## Why did 30 headless consumers overlap?

The pinned SDK's `HeadlessTask.onHeadlessEvent` creates a task for each received
event. `HeadlessTaskManager` explicitly supports rapid events and tasks queued
while React initializes. Its delayed queue drain invokes the queued tasks in
one pass, rather than awaiting each JS recovery. With an initialized context,
new tasks can likewise start while earlier async tasks remain pending.

Kinnship starts independent recovery before its lifecycle FIFO. Initial sharing
can release many consumers together, synchronizing their next ownership checks.
Thus concurrent consumers are supported SDK/app behavior, not by themselves
proof of 30 processes, JS boots, crashes, or a broken lifecycle FIFO.

The retained engine log has 21 terminate events alongside other SDK events;
the deep trace has 30 recovery consumers/distinct native tasks. Do not label all
30 as terminate events. This establishes delivery/overlap, not why repeated
terminate events were generated. Neither Activity destruction reasons nor OS
crash evidence establish that cause. The same native run/JS trace spans the
observed Activity recreations.

Conclusion: queueing/concurrency is an expected capability, but this particular
event volume and repeated termination source remain **unexplained**. A separate
SDK/OS lifecycle defect is neither established nor ruled out. No SDK, listener,
native-lifetime, event-filtering or Activity fix is included.

## Tests

- Focused frontend: **316 passed across 14 suites**, including real engine,
  headless lifetime, transport, ownership/session boundaries, tracking
  revocation/hardening, battery visibility/independence and SOS permission tests.
- Offline backend: **74 passed**, covering consent write/startup races,
  concurrent battery notification deduplication and optional-location SOS.
  Fixtures replace database/delivery operations; no production data modified.
- Full frontend initially exposed an obsolete headless assertion expecting the
  previous 90 second-stage calls. Updated it to the new three-call contract and
  added a native-live arm; the suite then passed in the focused run.
- Final full frontend: **1,223 passed, 8 failed across 105 suites**
  (101 passing, four failing).
- Eight other assertions across four suites fail identically on unchanged
  main in an isolated worktree: five deep-async fetch/body-fixture assertions,
  one startup-recorder API-count assertion, one Hermes transform idempotency
  assertion and one historical-identifier repository audit.
- TypeScript has an existing Jest callback-signature error in
  `schedulingTracing.test.ts:68`. The identical error reproduces on unchanged
  main; that worktree also has two generated-route-type errors absent from the
  working tree. No new type error was reported for changed files.
- Jest was run with `--forceExit` because the existing test process retains
  handles. This is not evidence of clean natural process shutdown.

## Remaining acceptance gates

Owner review, independent review if required, actual candidate Android-native
dispatch census, and physical moving/stationary/background/battery/SOS checks.
Those need separate authorization where they require distribution or release.
Do not merge or release based solely on synthetic savings.
