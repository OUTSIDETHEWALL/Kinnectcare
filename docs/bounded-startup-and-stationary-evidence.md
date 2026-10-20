# Evidence-only candidate: startup transport and stationary acquisition

## Status / release boundary

Local investigation candidate, not a fix. No merge, backend deployment, OTA,
native build, production configuration/data mutation, or phone operation is
included. Google Play production remains on HOLD. Preserve moving/background
GPS, native owner/consent fencing, acquisition options, and the 60-minute
stationary threshold. No new dependency, request, retry, timeout, dispatcher
limit, connection pool, DNS resolver, SDK listener, or recovery policy is added.

Native compilation, delivered-artifact inspection, signed-in Android UI,
physical overhead and unattended behavior are **not verified**.

## What existing evidence proves

The October 19 19:10 export identifies the current diagnostic OTA. Its slow
sequence has adapter lifetimes of 8,601 ms (`members`), 8,504 ms (`alerts`),
8,977 ms (`summary`) and 408 ms (`auth/me`). The usable Family render follows
members completion by 28 ms. Sampled JS timer delay is at most 19 ms. No refresh
persistence occurs. This is adapter-dominated delay, not a backend diagnosis.

A read-only 30-second Railway window contains 291 HTTP records, including 77
client-closed requests and repeated ownership reads. These are **window-level
records**, not exact startup-request correlations. Queue congestion is a
hypothesis; neither the source of every request nor its causal contribution to
the startup delay has been established.

The October 20 noon native SDK log retains heartbeat timer firings overnight
but no logged acquisition work from 22:00 to approximately 05:34. Acquisition
resumes around 05:34–05:35, before the separately logged 05:38 foreground event.
The reported roughly ten-hour gap and healthy control remain physical
observations; neither the recovery's exact lifecycle cause nor device-specific
failure is established. Native timer firing is not callback/React readiness.

## Startup HTTP: smallest additional boundaries

Only the first four existing allowlisted startup requests are eligible, under
the existing 15-second observer. A new native capability check gates an opaque
32-hex request ID. Build 70 has no capability, adds no new header and remains
usable. IDs contain no account, installation, session or location identity.

| Boundary | Candidate / interpretation |
| --- | --- |
| JS adapter entry | Existing timer plus opaque request ID |
| Native `callStart` | Entry to the existing OkHttp call, plus queue/running counts |
| Application interceptor entry | Dispatcher worker has begun executing; entry gap brackets client queue/admission time, not an exact OkHttp queue-only metric |
| DNS start/end | Native lookup interval; absent for reused connections / some cached routes |
| Connect and TLS start/end/failure | Each attempted connection, including retries already performed by the original client |
| Connection acquired | Existing connection ready; absent DNS/connect is not missing instrumentation when reused |
| Request headers/body start/end | Native write boundaries; GETs normally have no body |
| Backend received / response headers / final body handed to server | Opt-in ASGI logs with the same ID, endpoint and monotonic durations; no body/token reads, buffering or response modification |
| Response headers/body start/end | Native response read boundaries; not remote server execution timers |
| Native call end/failure → JS adapter settlement | **Residual upper bound:** native response handling, bridge/event delivery and JS/XHR scheduling remain combined |

The observer wraps the existing listener and passes the original request
through unchanged, apart from the opt-in correlation header. Its builder
snapshot shares existing client resources; it does not replace transport policy.
The installed application currently has no other custom NetworkingModule builder.
If one is introduced, this single global hook must be composed rather than
silently overwritten.

Backend instrumentation is in the active `backend/` tree only. It admits at
most 32 traced requests per monotonic minute per middleware instance; excess
requests proceed normally without trace logs. No backend deployment occurred.
Railway request ID is recorded only when an actual syntactically valid header
is available. Otherwise client ↔ backend correlation still uses the opaque ID;
individual edge matching is not promised.

### Exact remaining native-to-JS boundary identified, not implemented

For a strict split inside the residual, instrument the *delivered* React Native
NetworkingModule immediately before ResponseUtil emits response headers,
response data and completion, and record the corresponding XHR callback entry
before Axios settles. The mapping needs the native networking request ID plus
the opaque ID. This requires source-built RN networking or another verified
equivalent hook; editing a workspace source beside a precompiled AAR is not
proof it ships. Do not force a full RN source-build merely for an unproven
substage. First inspect the above span evidence; add this boundary only if the
residual dominates.

Wall clocks from separate machines do not prove one-way transport durations.
Use native monotonic spans and backend elapsed spans; request/response network
residuals and framework/edge queues must retain their uncertainty. A packet-level
one-way split needs separately approved capture/clock evidence.

## Stationary GPS: native and JS decision trail

Existing native SDK timer logs remain the scheduled-opportunity evidence.
No scheduler, JobScheduler, native SDK service or motion configuration is
changed. Source hooks observe existing callback/task paths, without subscribing
a new listener:

1. Native headless event receipt (heartbeat/boot/terminate/motion/activity only)
   or WorkManager headless entry; assign an opaque wake ID.
2. Native task queued; context requested/ready; task invocation; SDK headless
   completion/error. Context request/ready counters are manager-wide, not
   invented per-wake completion timestamps.
3. JS wake entry with the same ID; ownership/authorization decisions. A wake
   may pass several checks; a successful check is not publication authority
   for later generations.
4. Native acquisition decision, under the **existing authority lock**:
   revoked, generation mismatch, owner mismatch, pending mutation, pending
   shutdown, active lease, backoff, recent capture, or allowed. Configuration
   claims are a separate stage. Record numeric generations/ages, not owners.
5. Actual native `getCurrentPosition` entry and its existing success/error
   callback; acquisition ID passed only as diagnostic extras on guarded,
   nonpersisting Android one-shots.
6. Existing explicit upload attempt/result and acquisition completion.
   Headless heartbeat and WorkManager paths link wake ID → acquisition ID.
   Other callers can still be correlated by acquisition ID and stage clocks;
   they do not acquire a fabricated parent wake.

If scheduled firings continue but native event receipts disappear, investigate
SDK dispatch/registration/runtime admission. If native receipts queue but never
invoke, investigate context/task delivery. If JS entry appears but authorization
or claims deny, inspect the exact decision. If allowed claims reach native GPS
but no callback, investigate provider/timeout delivery. If callbacks arrive but
publication fails, inspect the receipt/admission result. These are decision
rules for **future evidence**, not current diagnoses.

The SDK's internal timer callback is inside its vendor binary; this candidate
does not patch that binary. Timer timestamps are joined by time/process and
event type, not a fictional shared ID before callback dispatch.

## Retention, privacy and failure limits

Full Diagnostics adds `boundedNativeEvidence`:

- Separate from startup/authority rings: 512 HTTP rows, 2,048 sampled GPS rows,
  48 wall-clock-hour counter buckets; source/stage/reason keys are closed sets.
- GPS detailed wake sampling: first wake per source per 15 monotonic minutes;
  linked acquisition spans follow that sampled wake. Counts include unsampled
  observer events, so busy startup cannot erase the fact a stage ran overnight.
- Each row has process-random identity, sequence, wall and native elapsed time.
  No token, URL, error message, payload, owner, coordinate or raw location enters
  this store. Optional edge/parent IDs are validated, opaque strings.
- Disk writes run on one dedicated observer thread with a one-second delay.
  Export includes the live in-memory snapshot. Abrupt death may lose the final
  unflushed second. Disk failure has no tracking side effect. Counts reflect
  observer events, not exact-once tasks. Wall-clock changes affect hour buckets.
- Native and JS source tests cannot prove hook delivery in an installed binary.
  Missing rows alone are not proof of a missing callback without confirmed
  observer installation/retention and the native timer coverage.

## Compatibility and smallest next step

| Piece | Delivery requirement |
| --- | --- |
| Optional JS IDs/export/entry/publication markers | JS is OTA-compatible but unavailable native capability is reported explicitly; no OTA is authorized |
| OkHttp spans; native task/callback hooks; detailed claim decisions; durable counters | **New native binary required. Build 70 cannot gain these via OTA.** |
| Backend ID/ASGI spans | Separately authorized Railway deployment required; not an OTA |
| Precise RN event-emission/XHR handoff | Identified conditional extension; not implemented or source-built |

Local tests cover optional-bridge failures, original HTTP/error identity,
unchanged protected recovery scenarios, native-source transform drift and
idempotence, privacy inventories and backend stream identity/cancellation.
They do not constitute native compilation or physical acceptance.

Verification on 2026-10-20: 189 tests across eight focused JS suites passed;
six backend observer tests passed; TypeScript passed; targeted ESLint had zero
errors and 33 warnings (including an existing parser/TypeScript-version
compatibility warning). The unsigned web disclaimer gate rendered after a
development-preview restart. This is not signed-in or native Android UI
verification. No production export, prebuild or native build was run.

Smallest next step: review this evidence-only diff, then separately authorize
compile-only native validation and inspection of the produced hooks. Do not
publish it, deploy the backend, or operate phones as part of that authorization.
Only after separate release approval collect a naturally slow startup and an
unattended stationary interval with the healthy control. Compare moving capture
advancement as a protected regression baseline. Neither defect is called fixed.
