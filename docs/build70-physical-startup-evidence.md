# Build 70: supplied physical startup evidence and narrow additions

## Evidence identity and boundaries

Analyzed the full text export `Kinnship_Diagnostics_2026-10-18_153132.txt`,
generated **2026-10-18 22:31:32.004 UTC / 15:31:32.004 Phoenix**.
SHA-256: `a0b68f2166c898554349776ba48044a9311679229fbaa1e4082609b59fadc4ca`.
It identifies Android, app/runtime **1.3.1**, production, active OTA
`01a150dd-f657-715b-93e5-62689530bb58`.
It is evidence for the **currently delivered code**, not the unshipped PR.
The raw export, account identifiers, contact information and location payloads
are not copied into this report or committed to the PR.

The latest complete retained launch sequence starts with Activity recreation,
not a proven fresh OS process. Application/earliest-JS events have been evicted;
the native run and JS trace span earlier Activity recreations. The launcher tap
itself has no timestamp. Thus the precise measured boundary below is
**Activity onCreate → first usable Family**, not icon tap → cold process startup.

## Exact latest retained timeline

All wall-clock times below are UTC on 2026-10-18. Phoenix is UTC minus 7 hours.
Offsets use Activity creation at **22:27:05.662** as zero.

| Event | UTC time | Offset |
| --- | --- | --- |
| Native Activity create starts | 22:27:05.662 | 0 ms |
| Native Activity create completes | 22:27:05.666 | 4 ms |
| Window focus / root coordinator | 22:27:05.719 | 57 ms |
| Auth restore starts | 22:27:05.722 | 60 ms |
| Fresh-install guard completes | 22:27:05.725 | 63 ms |
| Token read completes | 22:27:06.165 | 503 ms |
| User cache read / cached session restored | 22:27:06.166 | 504 ms |
| Background `/auth/me` starts | 22:27:06.167 | 505 ms |
| First gates-cleared observation | 22:27:06.188 | 526 ms |
| Canonical foreground `/members` starts | 22:27:06.192 | 530 ms |
| App-lock recheck settles / gates clear again | 22:27:06.238 | 576 ms |
| Dashboard mounts | 22:27:06.257 | 595 ms |
| Dashboard load starts | 22:27:06.264 | 602 ms |
| Dashboard `/members`, `/summary`, `/alerts` start | 22:27:06.267 | 605 ms |
| `/auth/me` completes | 22:27:06.522 | 860 ms |
| Auth maintenance terminal event | 22:27:06.528 | 866 ms |
| Another `/alerts` starts | 22:27:07.071 | 1,409 ms |
| Canonical `/members` completes (2,055 ms request) | 22:27:08.247 | 2,585 ms |
| Dashboard `/alerts` completes (8,761 ms) | 22:27:15.028 | 9,366 ms |
| Dashboard `/members` completes (8,762 ms) | 22:27:15.029 | 9,367 ms |
| Dashboard `/summary` completes (9,370 ms) | 22:27:15.637 | 9,975 ms |
| Dashboard trace receives / commits | 22:27:15.638 / .639 | 9,976 / 9,977 ms |
| Dashboard loader ends | 22:27:15.641 | 9,979 ms |
| First usable Family | 22:27:15.670 | **10,008 ms** |
| Second `/alerts` completes (8,620 ms) | 22:27:15.691 | 10,029 ms |

These are client-observed request lifetimes. The API timer starts before secure
token acquisition in the interceptor, so it includes token/interceptor waiting
as well as transport/server work. This export alone cannot attribute the delay
to Railway, database, geocoding, connection contention or SecureStore.

## Confirmed bottleneck and what the earlier candidate did not fix

The dominant visible block is Dashboard's request barrier: **9,370 ms** from
its dispatch to the final required response, within a 10,008 ms Activity-to-Family
interval. Cached identity and routing are ready in under 0.6 seconds. Waiting for
online `/auth/me` is **not** the blocker in this cached-session launch.

The earlier candidate's independent member rendering removes the **608 ms**
tail from Dashboard members completion to summary completion. It does **not**
remove the dashboard's own **8,762 ms** members request. Claiming it removes the
dominant physical delay would therefore be incorrect.

There are two overlapping `/members` requests: RootNav's canonical foreground
sync and Dashboard's direct request. The first returns valid current data at
2.585 seconds from Activity creation. Dashboard still waits for its separate
request and then summary. The export proves duplication and unused early data;
it does **not** prove duplication caused the requests to be slow.

### Additional narrow correction

Dashboard and the existing canonical store now share only an **in-flight raw
`/members` response**. No completed-response cache or freshness policy is added.
The Dashboard receives the original status/Date header/payload or rejection,
keeps its account/request-revision checks and canonical publication, and can
render independently of summary/alerts.

Pending sharing resets on token change and store clear; an older request's
settlement cannot clear its replacement. Existing store failure fallback is
unchanged; Dashboard does not mistake cached fallback for a successful response.
Dashboard trace `t_get_sent` denotes that caller's request/join time; the API
startup trace remains the actual underlying request lifetime.

This would allow the earlier response to satisfy Family in this recorded request
ordering, but **does not establish a future physical 2.6-second result**.

The overlapping `/alerts` has separate dashboard and root emergency-monitoring
consumers. No SOS/emergency monitoring or generic API deduplication is changed.
Request contention remains a hypothesis; backend optimization is outside scope.

## Welcome flash: physical trace corroboration

Native `welcome_render_committed` occurs at **22:27:06.186** and **06.228**,
after cached identity restoration at **06.166**, before dashboard pathname
observation at **06.265**. This proves Welcome actually committed in the
authenticated launch path, corroborating the guard already in PR #169. It does
not identify every externally visible video frame or prove a full-second flash.

## Storage warning: confirmed false classification, not data cleanup

The retained audit at **22:27:27.892** flags only
`@kinnship/dashboard_load_log_v1`, with
`record_8_raw_members_expected_array`. The buffer has 15 entries; indices
**8, 9 and 13** have null raw payloads and null response/status/count/commit fields.
These are incomplete requests, not proof of corrupt storage. An interrupted
Activity can leave such an entry legitimately unfinished.

`dashboardLoadLog.startLoad` intentionally writes exactly this nullable shape;
the renderer already safely checks for a payload before mapping it. The audit
incorrectly required an array for every lifecycle stage.

Correction: allow **explicit null** only before receipt, status, count or
commit is recorded. Missing/string/object payloads and completed records lacking
an array remain invalid. No log is erased, no audit is bypassed, and genuine
storage/read/schema failures continue to warn.

## Share placement, verification and release boundary

The existing Android full-share control is now immediately below the navigation
header, before the hero health card and scrolling content. The same handler,
global export lock, busy state and focus/unmount protections are retained.
No native sharing dependency is added.

Focused tests cover raw request sharing in either caller order, original response
metadata, rejection versus fallback, session/store invalidation and replacement
settlement; actual Dashboard joining an existing request with safety still
pending; nullable incomplete journals versus malformed/completed entries; and
one top-level share action outside scrolling content. Existing export-lock and
full-export tests are reused.

Final focused verification: **13 suites / 178 tests passed**. TypeScript passed;
ESLint on changed source/test files reported **0 errors / 79 warnings**.
`git diff --check` passed. The prior full-suite baseline remains 915 passed /
one known historical-identifier audit failure; it was not rerun, as requested.

All additions are JS/TS-only. No backend/native/tracking policy, runtime,
dependency, consent/publication rule or production configuration is changed.
No merge, deployment, OTA, binary build, Play upload or phone operation is
authorized. Existing unattended moving GPS remains protected.
Physical acceptance and notification visibility/tap reliability remain open.
