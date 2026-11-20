# Shared SOS incident-screen investigation

## Outcome and release status

**Critical launch blocker: unresolved.** Controlled valid-data scenarios did not
reproduce the reported blank screen. They do not establish that either Android
phone can safely open, operate or resume the incident screen. Both phones still
require separately authorized real-world acceptance.

The original PR #203 changed tests, this report and the standing PR-target
instruction only. The focused continuation below adds Android-wrapper tests,
extends the existing test helper and updates this report only.
It contains **no functional application change**. No real SOS, dialer action,
production API call, incident mutation, merge, deployment, native build or OTA
was performed. The notification-dismissal correction remains separate.

## Baseline and chronology

Inspected source: `514e6fcb146547345976a59f216af014a4d1f425`, the source of the
reported Android OTA `01a1f635-2071-7a10-ba40-0ce546a0896b`.

The owner's complete sequence, not a newly reproduced result:

1. Originating phone sent SOS; recipient saw and opened its notification.
2. Recipient immediately blanked; originating phone also blanked when its
   incident was opened to resolve it.
3. Reopening either phone displayed Family for roughly two seconds, then blanked.
4. After force-close/reopen, quickly switching to Alerts avoided that transition.
5. Clearing Alerts temporarily hid the rows, then restored them.
6. Normal navigation subsequently returned. The SOS rows remained.

The prior exports establish a recipient notification route attempt, not successful
incident rendering, and have no attributable JS exception or Android crash trace.
Normal navigation now working is **not incident-screen functional acceptance**.

## Shared paths and evidence boundaries

- Push response: the real durable response queue in `push.ts` invokes the real
  root callback after launch gates, which replaces the route with `/alert/[id]`.
- Manual opening: the Family active-emergency banner pushes that same route.
  Sending itself opens a separate confirmation screen. This investigation
  exercises the destination, but does not drive the actual dashboard banner.
- Automatic opening: RootNav starts its first check after 800 ms and opens the
  newest unresolved, unacknowledged, non-dismissed SOS no more than five minutes
  old. A foreground check starts after 400 ms, subject to its cooldown.
- Alerts cards use a separate renderer. Clear All preserves backend SOS records
  and is not evidence of incident resolution or blank-screen repair.

### What the new harness actually runs

The navigation suite mounts the **production RootLayout/RootNav**, production
notification-response queue/listener, production incident component and production
location hook. It drives their real lifecycle subscriptions and asserts the
destination's mounted safety controls, not merely a `replace` spy.

**The Expo Stack/router is an explicit committing in-memory test adapter.**
It updates pathname/segments and mounts the real destination. It is not an
actual Expo navigator, native ScreenStack, Android Activity, layout/compositor,
Hermes runtime, or WebView renderer. Router commitment within this adapter does
not exclude a native navigation failure. Authentication and unrelated startup,
tracking, permissions and telemetry boundaries are controlled fixtures, not a
revalidation of those systems.

The incident suite additionally runs **real MemberMap** around an inert WebView
double, compares a substituted-map control, and executes the actual generated
HTML script in a local VM with inert document objects. No Google Maps request
is sent. This is JS/HTML isolation evidence, not browser or Android rendering.

## Controlled evidence matrix

| Area | Controlled scenario and observation | Conclusion |
| --- | --- | --- |
| Navigation | Eligible startup check does not open before 800 ms; subsequently mounts the incident banner, Return and emergency controls | Shared JS path works in the committing adapter |
| Notification | Cold and warm synthetic SOS responses pass through the real queue and mount the incident; consumed marker is recorded | Response handoff works under tested fixture readiness |
| Warm root | A new root in the same JS/module process holds a cold response while authentication is pending, then mounts the incident after readiness | Tested warm-root handoff did not reproduce blanking |
| Early tab switch | Moving to Alerts at 500 ms prevents navigation at the original deadline, but a newly scheduled check still opens the eligible incident later | Timer postponement is possible; tab switching is not a fix |
| Resume | Actual registered background-to-active listeners open the eligible incident after the foreground check | JS lifecycle path works under controlled timing |
| Eligibility | Acknowledged, resolved and older-than-five-minute incidents do not auto-open without a notification | A later reopening cannot be attributed to auto-resume without proving eligibility |
| Incident rendering | Active, acknowledged-unresolved and resolved records; sender/recipient account contexts; absent/invalid coordinates | Valid fixture cases keep expected controls and status |
| Initial fetch delayed | Destination commits while initial fetch is pending; only spinner is present; controls appear when data settles | Route selection, fetch completion and usable rendering are distinct |
| Initial fetch never settles | Spinner persists for 60 simulated seconds; no Return or emergency controls appear | No screen-local escape while loading; this deliberately bypasses real Axios timeout |
| Fetch rejected/malformed/absent | Screen renders “Alert no longer active” and requests dashboard after 1.5 s | Not a blank reproduction; errors and genuine absence are conflated |
| Member lookup | Rejected, malformed and never-settling member requests leave incident actions available | Optional member/location work did not gate basic controls |
| Disposal | Pending initial read is aborted; late completion does not issue refresh actions | Tested initial-load cancellation works |
| Map comparison | Same authorized coordinate fixture renders with substituted map and real MemberMap/inert WebView | No JS failure observed in either control |
| Map HTML | Actual script's load-error and eight-second timeout handlers display its internal fallback; outer controls remain | These HTML-level failure paths stay inside the map |
| Background/return | Map is removed on background, restored after authorized reread; Return removes it; late/malformed messages do not reopen it | Tested JS lifecycle/map messages do not reproduce whole-screen blanking |
| Injected map render throw | Deliberately throwing WebView double propagates to a **test-only ancestor boundary**, removing incident controls | No local incident/map render-error containment; **not proof a native exception occurred** |
| Malformed render field | Object-valued member name throws after successful incident read | Invalid data can fail rendering; **not evidence production returned this shape** |

## Important loading qualification

The production Axios instance has a **45-second default timeout**. Its retries
apply only to listed OTP endpoints, not `/alerts`. The synthetic never-settling
promise does not model that timeout and must not be reported as proof of an
unbounded production HTTP request. A pending initial fetch nevertheless currently
withholds the entire incident's Return and emergency actions until it settles.

The real load catch also marks this incident session-dismissed, clears the active
emergency store and uses the same “no longer active” view for a network failure.
The controlled rejection demonstrates that misleading presentation. It is a
separate, source-supported safety concern, **not the original blank-screen cause**.

## Smallest supported next changes — proposed, not implemented

1. **Data-loading safety:** distinguish request failure from confirmed absence;
   retain an incident-safe shell with Return, explicit loading/error state and an
   independent user-initiated emergency action. Provide bounded retry and do not
   session-dismiss a genuine incident merely because its read failed. Do not
   change backend incident state.
2. **Render attribution/containment:** if approved, put a narrowly scoped incident
   render boundary around the incident content and map, with a visible safe exit
   and a redacted, durable exception/checkpoint record. Record root route request,
   actual destination mount/commit, load outcome and map readiness/error
   separately. Preserve consent and scope checks. A React boundary does **not**
   catch Android native process crashes, and must not be sold as fixing those.
3. Do not change auto-resume delays, suppress legitimate incident opening or remove
   the map without an attributable failure. If controlled JS testing remains
   clean, an approved evidence build or Android system capture is still needed
   for the original native failure. No new real SOS is requested by this report.

Any functional correction needs its own explicit scope presentation/approval,
separate verification and PR targeting `main`. No such correction is included here.

## Verification

First focused run: **24 passed / 24**, two new suites, 8.417 s.
Expanded run: **90 passed / 90**, four suites, 7.063 s, comprising **31 new
investigation scenarios** plus the existing detail-return/location and push
reliability regressions.
After the final HTML-extraction test adjustment, the two investigation suites
were rerun independently: **31 passed / 31**, 2.250 s.

```sh
cd frontend
npm test -- --runInBand --runTestsByPath \
  src/__tests__/sosIncidentInvestigation.test.tsx \
  src/__tests__/sosNavigationInvestigation.test.tsx \
  src/__tests__/alertDetailReturnButton.test.tsx \
  src/__tests__/pushMedicationReliability.test.ts
npx tsc --noEmit --pretty false
```

Type checking reports only the pre-existing
`src/__tests__/schedulingTracing.test.ts:68` callback signature mismatch
(`TS2345`), also recorded before this investigation. No new-file type error was
reported. The change does not repair that unrelated issue.

All new tests use synthetic identifiers. API requests are intercepted, POST
paths are allowlisted to an inert fixture, external URLs/dialer throw if invoked,
and unexpected `fetch` use fails the suite. No native acceptance, signed-in UI
screenshot, Android process recreation or hardware map result is claimed.

## Focused continuation after PR #203

### Scope and result

Baseline: merged `main`, `025c4ed92880ea4531bcb25616655617a2079013`.
The owner's renewed authorization was limited to this blank-screen failure.
Notification dismissal, backend/retention changes and unrelated repairs were
not investigated or changed.

**Critical; root cause still unproved. No functional repair is included.**
Confidence is high in the additional JavaScript observations below, not in
attributing the original two-phone failure to a particular component.

PR #203 replaced the entire WebView with a controlled component. The added
suite instead mounts the **installed react-native-webview 13.15.0 Android JS
wrapper and its real shared loading/error logic**, inside the real incident
component, real location hook and real MemberMap. Real icons, screen-render
logging and map-observation functions also run. Only the wrapper's native
host, TurboModule, callable-module bridge and native event emitter are inert.
HTTP, storage, authentication and navigator/platform boundaries remain controlled
as documented above. No native component is instantiated, and no map request,
external link or emergency action is dispatched.

### New observations, not repeated PR #203 cases

| Added case | Observed result | What it does not prove |
| --- | --- | --- |
| Installed Android wrapper mounts | Incident status, Return, emergency call and Resolve controls remain mounted; real icon and map-props logging execute | Native view-manager availability or Android layout/composition |
| Native document-load-error event | The wrapper renders its own “Error loading page” view; incident controls remain | That the original document request failed, or that Google Maps subresource errors generate this event |
| Native HTTP-error event | Existing JS handler leaves incident controls mounted | Actual networking or successful map rendering |
| Render-process-gone, `didCrash=false` | JS callback completes without removing incident controls; no reload command is issued | That an Android renderer survived, recovered or retained pixels |
| Render-process-gone, `didCrash=true` | Same JS result; no automatic recovery handler is supplied by MemberMap | That native renderer death cannot blank or terminate the application |
| Load start/finish and background return | Actual wrapper JS mounts, is removed in background, then remounts after the authorized member reread; controls remain | Native Activity/process recreation or ScreenStack/WebView interaction |

The actual shared WebView callback forwards `onRenderProcessGone` only when an
application handler exists. MemberMap supplies no such handler. This means that
callback alone does not recover a lost map renderer. **It is not evidence that
renderer loss occurred on either phone, and a potentially unrecovered map is not
an established explanation for the entire incident screen disappearing.**

The targeted source review also confirmed:

- The screen calls its location hook before loading/not-found early returns.
  MemberMap calls its hooks before its coordinate/key/platform early returns.
  No conditional-hook-order defect was established in these paths.
- The root's full-screen startup gate renders an ActivityIndicator, rather than
  an intentional null/empty incident. Its App Lock check depends on account ID,
  not opening `/alert/[id]`. This does not certify native navigator commitment.
- Time-format helpers already reject invalid dates. Map logging catches storage
  failures; map-props observation with no member trace returns without mutation.
  The newly unmocked presentation/logging path did not produce a JS exception.

### Evidence still missing — stopping boundary

The original valid-data failure remains unreproduced. The available phone
exports and PR #203 evidence do not contain either:

1. An attributable first JavaScript exception/component stack, or Android
   Activity/native/WebView-renderer failure trace, from the actual blanking.
2. Same-run evidence distinguishing the requested route from its native
   destination commit, initial incident-read completion, component rendering and
   map-native initialization. A notification route log alone supplies none of
   those later observations.

The exact redacted response **field shapes** from the failed initial read are
also not retained; synthetic malformed-field injections cannot stand in for them.
The known f635 source baseline and the owner's chronology are already recorded;
they are not being requested again.

This workspace has no `adb` or attached Android/emulator environment. The added
event tests therefore cannot close the native-navigation/compositor boundary.
Further attribution needs either an existing failing-run native/JS trace or a
controlled fixture-only replay on the affected Android runtime with emergency
delivery disabled. Do not trigger another real SOS to obtain it. No device
capture, new binary, deployment or OTA was performed or silently requested.

Without that evidence there is no justified smallest causal correction.
Changing navigation timing, removing the map, adding blanket error suppression
or implementing unrelated loading/dismissal proposals would not establish a fix.
**The stopping result is unresolved, not CLEAN, fixed, or accepted on either
phone.**

### Continuation verification

```sh
cd frontend
npm test -- --runInBand --runTestsByPath \
  src/__tests__/sosAndroidWebViewInvestigation.test.tsx \
  src/__tests__/sosIncidentInvestigation.test.tsx \
  src/__tests__/sosNavigationInvestigation.test.tsx \
  src/__tests__/alertDetailReturnButton.test.tsx \
  src/__tests__/pushMedicationReliability.test.ts
./node_modules/.bin/tsc --noEmit --pretty false
```

**96 passed / 96, five suites, 11.615 s.** Six added cases; the other 90 are
regression verification, not 90 new findings. Type checking reports only the
same pre-existing `schedulingTracing.test.ts:68` TS2345. There are no new reported
type errors. No signed-in UI screenshot or native runtime verification is claimed.
