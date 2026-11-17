# SDK ownership transport admission: controlled candidate

## Scope and diagnosis

Severity: Medium startup-performance defect; authorization/tracking regressions
would be safety-critical. Native evidence matched 30 consumers to 28 terminate,
one activity-change and one motion-change task in the supplied Android export.
Those consumers submitted 90 independent second-stage HTTP requests. All 28
terminate tasks were queued within 17 ms and invoked in 0–1 ms in one React
context. Repeated upstream terminate delivery remains unexplained.

The earlier response-sharing candidate is rejected. This implementation restores
independent second-stage reads; no local context match can substitute another
consumer's older response for a newly dispatched verification.

No merge, Railway change, OTA, EAS build, Play release, production configuration
or database mutation is authorized. Two permits are an experimental starting
budget, not a validated production optimum.

## Implementation boundaries

- Runtime-local, two-permit admission for SDK-headless initial and second
  ownership reads and the SDK recovery-cache-miss ownership triplet.
- Every helper retains its own permit through its transport/body completion,
  including failure. Promise.all rejection does not release sibling permits.
- Initial-stage pending raw sharing remains intact. Its liveness predicate is
  the union of attached consumers so an expired leader cannot cancel a live
  follower's queued reads. Verdicts remain independently validated.
- Second-stage responses are NEVER shared, even with equivalent context.
- Initial and second queued reads recheck token, session mutation revision,
  durable policy, local consent flag, native owner/generation/mutation state,
  known consent generation and per-consumer execution/lifecycle currentness.
  Synchronous fences are repeated at the actual dispatch boundary.
- Recovery-cache-miss reads retain their existing current-owner/policy/token
  checks and additionally fence session revision around admission.
- Native generation, session and post-response checks remain fail-closed.
- Before dispatch, validation has an 8-second bounded wait. A late storage result
  cannot dispatch after that validation attempt has failed.
- Once admitted to HTTP, retain backgroundHttp's native XHR 8-second timeout.
  Do not use an early JS abort to release capacity before native termination.
  Other HTTP helpers keep their original JS timeout behavior.
- No lock/permit spans GPS acquisition, lifecycle FIFO or SDK configuration.
- FIFO within each urgency class. At most two motion-class admissions overtake
  waiting other-class work. Motion and activity triggers carry explicit priority.
  This is bounded overtaking, not a guarantee of maximum wall-clock delay.
- No event suppression, completed-response cache, grace period, global API
  deduplication, SDK source change or backend contract change.

Foreground dashboard/auth, acquisition ownership checks, coordinate uploads,
device-contact/battery transports, SOS and local revocation/shutdown bypass this
queue. Initial authorization is still required by existing headless handlers:
their downstream GPS/battery work can therefore experience INDIRECT additional
recovery latency. This is a material physical acceptance risk, not a claim that
their observed timing is unchanged.

The gate is local to one JS runtime, not a reservation enforced across Android
processes, other runtimes or unrelated HTTP producers.

## Security reproductions

Tests execute the actual verifier, gate and production backgroundHttp with a
controlled XHR boundary. A captures pre-change server data and its final response
is held. B starts after a server-only change, without any local mutation.

| Server-only change | B's result |
| --- | --- |
| Sharing withdrawn | sharing_disabled |
| Owner removed/replaced | invalid_owner |

B dispatches its own triplet. A may still return allowed for its earlier reads,
as on main. There are six actual XHR.send handoffs, never three shared handoffs.
These are controlled server-state tests, not live backend or phone observations.

Additional regressions cover queued logout/account switching/same-token login,
lifecycle cancellation, native revocation/owner invalidation, expiring execution,
initial leader cancellation with a live follower, active-transport cancellation,
HTTP/network/native-timeout failures, hung validation, late storage completion,
foreground/acquisition bypass and fairness.

## Production-path synthetic measurement

The benchmark runs 30 real recoverFromIndependentWake calls, real ownership
verification, the real admission module and real backgroundHttp. XHR, storage,
SDK and native authority are controlled doubles. One trigger is motion-related;
29 are termination-related. A verified-consent seed precedes the measured run.

At artificial 5 ms response-service waves:

| Measurement | Candidate |
| --- | ---: |
| Initial-stage XHR sends | 3 |
| Independent second-stage XHR sends | 90 |
| Existing recovery-cache-miss XHR sends | 3 |
| Total measured XHR sends | 96 |
| Peak pending XHR sends | 2 |
| Maximum recorded admission wait | 220 ms |
| First recovery completion | 245 ms |
| Last recovery completion | 280 ms |
| Queued/active permits after completion | 0 / 0 |

These numbers describe this artificial schedule, not Android performance.
No native request-count reduction is claimed. Native/OkHttp occupancy, startup
improvement and moving/stationary endurance have NOT been measured.

The legacy authority suites explicitly bypass the admission module because
their deferred fixtures settle an entire triplet at once. Admission integration
tests unmock both the gate and backgroundHttp; their dispatches are not logical
verifier counters. This separation is explicit in jest.setup.js.

## Verification and remaining risks

Full frontend: **1,197 passed, eight failed / 105 suites** (101 passing,
four failing). Offline backend: **74 passed**. Independent adversarial review:
**CLEAN for revised source and controlled tests**, with **203 focused tests**
independently passed across six suites (admission/recovery/headless lifetime,
battery independence and SOS included).

Known main failures are five deepAsyncTrace fixture
assertions, startup-recorder API count, Hermes transform idempotency and the
historical-identifier audit. The schedulingTracing callback type error is also
preexisting. No unrelated failures are fixed or hidden by this candidate.
Jest used --forceExit; clean natural process shutdown remains unverified.

The independent reviewer found no confirmed security/functional regression
against main and specifically confirmed the independent second-stage change
reproductions, per-helper permit retention, follower-aware initial liveness,
bounded overtaking and queue exclusions. CLEAN does not mean native Android
release acceptance. The eight baseline assertions and common TypeScript error
were reproduced on unchanged main during the preceding read-only review; this
candidate reports the same failures rather than suppressing them.

Release acceptance still requires separately authorized physical Android
measurement of actual native starts, native peak occupancy, foreground latency,
recovery/headless-deadline behavior, moving/stationary GPS, battery and SOS.
The absence of an implementation regression in local tests is not phone
acceptance or release authorization.
