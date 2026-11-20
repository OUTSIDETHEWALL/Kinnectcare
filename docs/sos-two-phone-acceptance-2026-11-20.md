# SOS two-phone acceptance — November 20, 2026

## Outcome

The owner reported a successful controlled SOS test on both Android Build 81
phones after installing replacement OTA
`01a1fa07-85a0-7173-a9e6-ab777204b111` (`fa07`).
The supplied recordings support recovery of the tested sender/recipient
workflow: active incident screens, maps, resolution and dashboard return
rendered without the previous blank-screen failure in the reviewed frames.

This is physical acceptance evidence for this particular test, not a claim
that every SOS entry path, process state or device condition has passed.

## Release attribution

- Android runtime: `1.3.1-diagnostic81`; Build 81.
- Channel/branch: `production` / `production`.
- Published source: `73db851da250f5a39ceee2b57f3fb0b11de3d506`.
- Update group: `43103019-e0f7-4d9d-9c66-3188dc8e28de`.
- Repair: PR #205, Expo Router-owned navigation/focus context.
- Both phones' installation of the update is owner-attested in the supplied
  test note. The reviewed recordings do not show Software diagnostics proving
  each phone's installed OTA ID/runtime independently.

## Supplied evidence and review method

- Sender recording: `az_recorder_20261120_104532_1795197241883.mp4`,
  approximately 89 seconds.
- Recipient recording: `VID_20261120_105002_1795197247731.mp4`,
  approximately 57 seconds.
- Owner's written report:
  `Pasted--Kinnship-SOS-Successful-Two-Phone-Test-November-20-202_1795197384848.txt`.

Reviewed timestamp-sampled frames across both recordings, with additional
frames around countdown and notification arrival. This was a visual evidence
review, not a new device test, production database inspection or instrumented
playback. Original videos remain supplied attachments; no videos, location
screenshots or generated contact sheets are added to this documentation PR.
Times below are approximate offsets within each recording.

| Evidence | Visible result |
| --- | --- |
| Sender, about 00:18–00:24 | Press-and-hold, countdown and emergency-send progress render. |
| Sender, about 00:26–00:44 | SOS-recorded feedback, active incident and location/map render. |
| Sender, about 00:48–00:60 | Resolution confirmation and resolved incident render. |
| Sender, about 01:12 through end | Normal Family dashboard is visible again. |
| Recipient, about 00:08 onward | A Kinnship notification banner appears, followed by the active incident screen. Banner text is not sufficient here to independently verify the entire emergency payload or delivery path. |
| Recipient, about 00:10–00:28 | Incident controls render while location loads, then the map appears. |
| Recipient, about 00:30 onward | Resolved status renders, followed by the normal Family dashboard. |

The owner additionally confirms emergency-notification receipt, successful
resolution, no recurrence of the blank screen and both phones remaining
functional. Taken together with the focused regression evidence recorded
before release, this strongly supports the navigation-context repair for the
tested workflow. It does not prove emergency calling, every notification entry
path, cold-start recovery or long-term reliability.

## Separate finding: old SOS alerts return after Clear All

**Existing work:** Task #281. Do not create a duplicate task.

**Severity:** Medium for resolved-alert dismissal; no loss of incident records
or failure to deliver an active emergency has been established by this finding.
Deleting SOS history or suppressing unresolved emergencies would be Critical
and is not an acceptable dismissal fix.

**Evidence boundary:** The owner reports three old cleared SOS alerts
reappearing on both phones. The supplied recordings do not show the Clear All
reproduction, and no production records were queried in this review.

**Source-supported explanation — high confidence in the mismatch:**

1. `frontend/app/(tabs)/alerts.tsx` sends `DELETE /alerts`, then unconditionally
   empties the entire displayed list and removes its local cache.
2. Its confirmation incorrectly claims that all family history, including SOS,
   will be permanently deleted.
3. `backend/server.py::clear_all_alerts` intentionally deletes only non-SOS
   records, preserving SOS incident history.
4. `backend/sos_history.py::read_family_alerts` continues to return authorized
   retained SOS records; there is no corresponding dismissal filter in the
   reviewed read path.
5. A later refresh restores preserved SOS records to the displayed list.

This explains the reported disappear/reappear behavior without requiring a
failed deletion, lost database write or new duplicate incident. Attribution of
the exact three records remains unverified.

**Separate repair boundary:** Dismissal must be distinct from incident deletion,
survive refresh/restart, have an explicit account/family visibility scope, and
never conceal unresolved emergencies. Correct the confirmation and optimistic
list behavior consistently with that contract. Do not weaken the backend's SOS
preservation guard. No implementation or dismissal-scope decision was made in
this review.

## Separate finding: location disappears after resolution

**Severity:** Low for the misleading resolved-screen wording on current
evidence; no active-emergency location failure or stored-location loss was
established.

**Evidence:** Both recordings show an active incident map, then a resolved
incident displaying “Location unavailable.”

**Source-supported explanation — high confidence:**

- `frontend/src/sosDetailLocation.ts` resets location state to `EMPTY` when
  `incident.resolved` is true. Its ongoing incident check also clears state when
  remote resolution is observed.
- `frontend/app/alert/[id].tsx` renders the generic no-location card whenever
  that state has no coordinates, without explaining that the incident ended.

Stopping live location after resolution is deliberate in the current
implementation. The wording does not distinguish stopped live tracking from
missing historical location. This is expected from the code, but does not by
itself establish the intended product experience for resolved incident history.
The UI transition alone is not evidence that stored coordinates were deleted.

**Separate repair boundary:** Clarify the resolved-state wording without
restarting location refresh or relaxing sharing/authorization rules. Displaying
a historical incident location, if desired, requires a separate decision and
review of its retained data, access and capture-time semantics. Do not silently
reuse a live/shared member cache as historical incident evidence.

## Preserved constraints and stop point

- Preserve SOS records and the approved 30-day resolved-incident retention policy.
- Active/unresolved SOS must never automatically expire.
- No application code, backend, database, native configuration or build changed.
- No additional device/SOS tests, merge, deployment or OTA publication was run.
- This documentation-only change requires owner review/merge; it requires no
  deployment.
- Keep the successful blank-screen repair acceptance separate from the two
  remaining issues. Do not mark the whole SOS system universally validated.
