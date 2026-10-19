# Build 70 current-OTA startup A/B investigation

## Disposition

**First-render dependency proven; underlying latency cause NOT YET PROVEN.**
Severity: **High**, core startup usability. Confidence is high in the measured
members-to-render dependency, not in an attribution to secure storage, client
scheduling, native HTTP queuing, network or backend execution.

The candidate adds bounded JS-only observation, **not a performance repair**.
No merge, deployment, OTA, binary build, Play action, production configuration/
data mutation or phone operation is authorized or performed.

## Evidence identity

Both supplied exports identify Android, production, runtime `1.3.1`, current OTA
`01a155ac-bca3-73e6-b0ce-6c0360156185`.

| Export, Phoenix time on 2026-10-19 | SHA-256 |
| --- | --- |
| 15:17:06, user-observed approximately 12-second slow launch | `827dbf27e36ab607d4de18e6a84bb42815faa1ee379af52e7af4ce0000eace88` |
| 15:20:11, user-observed approximately 5-second warm return | `e30fe2471746bd4b6a553d590b7c3f221157219a6c8719e2f3168445c166968c` |

Raw exports and identifying payloads are not committed.

The second file contains **two Activity/root recreations**, not just a retained
screen's AppState resume. All three relevant sequences retain the same native
run identity and JS trace identity. They do not establish fresh process/JS
initialization. No launcher-tap timestamp exists. The difference between the
external approximately 12 seconds and the measured 7.58 seconds must remain
unattributed; do not manufacture an additional four-second initialization stage.

## Measured critical paths

Times are UTC on 2026-10-19. Entries below are milliseconds from each Activity
`onCreate` start; native elapsed-realtime confirms the total intervals (within
1 ms of the corresponding JS wall-clock event).

| Boundary | Slow 22:16:41.600 | Later 22:19:27.139 | Later 22:19:52.332 |
| --- | ---: | ---: | ---: |
| Activity creation starts | 0 | 0 | 0 |
| Root coordinator mounted | 68 | 49 | 57 |
| Token restoration finishes | 148 | 96 | 110 |
| Cached identity ready (native checkpoint) | 149 | 98 | 111 |
| Canonical `/members` request timer starts | 163 | 106 | 124 |
| Final app-lock recheck / gates clear | 286–287 | 172 | 186 |
| Dashboard mounted | 302 | 181 | 201 |
| `/summary`, Dashboard `/alerts` timers start | 310 | 190 | 211 |
| Notification initialization completes | 405 | 282 | 305 |
| `/auth/me` completes | 1,004 | 2,160 | 1,767 |
| Route-stability timer still executes | 1,789 | 952 | 971 |
| `/members` completes | 7,556 | 5,530 | 4,173 |
| Dashboard accepts members | 7,557 | 5,530 | 4,174 |
| First usable Family (JS) | **7,579** | **5,554** | **4,197** |
| Dashboard `/alerts` completes | 7,713 | 5,682 | 4,551 |
| `/summary` completes | 7,916 | 5,912 | 4,760 |

In the slow sequence, the fresh-install guard takes **19 ms**, initial token
read **53 ms**, and user-cache read **1 ms**. The last sequence's corresponding
durations are 5, 39 and 1 ms. Early read-start events for the middle sequence
have fallen out of the 120-entry JS buffer; do not infer their exact durations.

`/members` lifetimes are **7,393 / 5,424 / 4,049 ms**. Their completion-to-first-
usable-render tails are only **23 / 24 / 24 ms**. Before the API wait, all three
reach Dashboard in under 0.31 seconds. The first large measured divergence is
inside the foreground request lifetime, not the auth/navigation gates or final
render. The source proves why its duration tracks visible loading: Dashboard
still needs the first accepted members result; it no longer awaits summary/alerts.

The canonical members call is shared in all three sequences. There is no second
Dashboard members dispatch in those batches. Separate emergency-monitoring alerts
remain separate and are not changed.

Native `welcome_route_suppressed` is present; there is no Welcome commit in the
three measured startup sequences. Notification initialization and online auth
complete well before members. These are not direct completion barriers here.
The route-stability events show JS could run during part of the wait; they do not
rule out intermittent stalls, native queues or later scheduling delays.

## Separating the API interval honestly

The existing API timer starts **before** secure-token acquisition. Its success
event is emitted **after** response interceptors await refreshed-token storage
and synchronous token-change subscribers. Thus the old number is not a wire or
server timer.

Read-only Railway edge logs were inspected for the two exact time windows using
the existing successful production deployment. This is **window-level evidence,
not request-ID correlation**; logs contain other requests and devices, and the
first window's returned sample is limited.

| Edge observation | Slow window | Later window |
| --- | ---: | ---: |
| `/members` edge durations in returned sample | 264–424 ms | 256–415 ms |
| `/auth/me` edge durations | 131–222 ms | 128–216 ms |
| `/summary` edge durations | 667 ms | 640 / 643 ms |
| `/alerts` edge durations | 343–347 ms | 344–352 ms |

These edge durations do not explain the multi-second client total as backend
processing. They also do not measure phone token access, dispatch delay, DNS/TLS,
native connection/dispatcher queuing, or JS callback delivery.

The exact raw members payloads carry server `members_response_at` values:

| Launch | Server payload timestamp | Client receipt |
| --- | --- | --- |
| Slow | 22:16:49.016160 | 22:16:49.157 |
| Later first | 22:19:32.517091 | 22:19:32.670 |
| Later second | 22:19:56.361285 | 22:19:56.506 |

Those approximately 141–153 ms cross-clock differences are consistent with prompt
post-response delivery, **assuming phone/server clocks are aligned**. They are
not a measured token-persistence duration or a precise network decomposition.
The inspected backend members route does not mint a refreshed token; the auth
route can do so conditionally. No exported refresh token is read or retained.

There are repeated preferences/auth/members requests in the edge windows.
Without per-request/device correlation, their origin or contribution to the
startup delay is not proven. Do not tune protected recovery/tracking work or
declare server contention from this observation.

## Narrow candidate: timing only

- `startupApiTiming.ts`: observe only the first `/auth/me`, `/members`, `/summary`
  and `/alerts` in the first 15 seconds of each mounted Android AuthProvider.
  At most four requests are claimed. Eligibility and 250-ms timer sampling are
  bounded; unmount/replacement stops probes. Requests are never canceled or held.
- `AuthContext.tsx`: start/clean up that observer alongside the existing mount
  effect, Android only. No identity, auth retry, cache or loading decision changes.
- `api.ts`: retain the existing adapter, config, response, rejection and awaited
  token persistence. For claimed requests, timestamp token-read start/end,
  adapter invocation/settlement, response-interceptor entry and refresh persistence.
  Existing request/completion events remain intact.
- One `startup_api_stage_timing` summary per settled claimed request goes into
  the already-exported startup ring. No new storage buffer, native dependency,
  backend request, token cache, release setting, header or payload is introduced.

Interpretation:

- `preTokenMs`: request-observer entry through the existing synchronous pre-read work.
- `tokenReadMs`: awaited token retrieval, including its native completion/JS scheduling.
- `tokenToAdapterMs`: remaining client request work before adapter invocation.
- `adapterMs`: adapter lifetime, **including native queuing, network, edge/server
  work and JS callback delivery**. It is not renamed to "server duration."
- `adapterToResponseMs`: adapter settlement through Axios response transformation/
  response-interceptor entry.
- `responseTokenPersistenceMs`: existing awaited refreshed-token save, including
  synchronous change listeners; null if no save is attempted.
- `responseTailMs`: remaining response-handler work.
- `maxJsTimerDelayMs`: observed timer-delivery delay, not proof of JS CPU work;
  OS suspension/backgrounding can also delay a timer. `timerSamples`,
  `probeLimited`, `probeCoveredWholeRequest` expose coverage limits.

Only allowlisted endpoint labels, numeric timings, status/outcome and booleans
are recorded. No authorization/token contents, accounts, coordinates, arbitrary
URLs, response bodies or error messages enter the new record.

This instrumentation is compatible with the existing Build 70/runtime `1.3.1`
binary. It cannot observe native DNS/socket/HTTP dispatcher stages directly;
if adapter time dominates without JS timer lag, native transport evidence or
separately approved instrumentation may still be needed. Stop rather than
claiming that an unknown interval has become a proven cause.

## Verification and physical acceptance

Focused real-API tests exercise delayed secure reads, delayed adapter completion,
delayed refreshed-token persistence, unchanged response/header identity, original
rejection/cancellation identity, no members retries, persistence failures, and
no adapter replacement outside eligible startup requests. Observer tests cover
budgets, deadlines, cleanup/recreation, timer lag and logging failures.
Existing AuthProvider, Welcome/Dashboard and members-sharing tests are reused.

Results: **98 tests across 7 focused suites passed**; TypeScript passed; targeted
ESLint completed with 0 errors (20 warnings). A local production Android/Hermes
export succeeded (no native binary build or release). The existing web preview
restarted successfully and rendered its unsigned medical-disclaimer gate. The
signed-in Android UI and physical performance of this candidate are **not verified**.

No protected location/tracking, native service, consent, GPS timestamp/publication,
moving/stationary/recovery/heartbeat/battery, SOS, medication or check-in code is
changed. There is no claimed speed improvement. After separate source/release
approval, one immediate full export following a slow launch on the candidate,
with its OTA identity confirmed, can identify the next latency stage. No phone
operation or release is included in this task.
