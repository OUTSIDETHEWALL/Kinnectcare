# Build 71: approved Railway deployment and Play preparation

Verified 2026-10-20 after the owner's separate deployment authorization.
The earlier artifact review remains the record of pre-deployment validation.
This document does not claim either underlying startup or stationary GPS defect
is fixed, or authorize additional phone testing.

## Railway: SUCCESS

- Deployment: `027ffe46-1116-4b3a-a0dd-30bea69b2ce1`.
- Exact source: `ed652212e66b83cfe6d25ffdf1cb6912f6d9ab70`.
- Exact Git tree: `aeab0052fa358a448a5cc2569fb2357bebde4f52`.
- Completed successfully at `2026-10-20T22:16:21.297Z`.
- Production service Online, one running replica, zero reported issues.
- Public `/api/health`: HTTP 200, `{"ok":true,"service":"kinnship-api"}`.
- Last-hour Railway HTTP sample: **0 server errors / 575 requests**.
- Source branch remains `main`; root remains `backend`. Source/build/deploy/
  networking configuration matches the pre-deployment snapshot; no staged
  configuration changes. No variable-writing operation was performed.
- Approved source was published to a separate branch; no merge or main push.

### Live correlation proof

Four unauthenticated read-only GET probes covered `/api/auth/me`, `/api/members`,
`/api/summary` and `/api/alerts`, each paired with an unmarked control.
All returned the expected HTTP 403, with identical marked/control response bodies.
All four opaque trace IDs and their actual Railway request IDs matched all three
backend stages: `backend_received`, `response_headers`,
`response_handed_to_server`. All 12 records reported zero queue drops, writer
failures and admission-budget drops. Backend final-stage spans were
0.854–1.257 ms; marked external round trips were 125–128 ms.

The accepted blocked-logger test supports nonblocking log delivery; these live
samples confirm execution and normal responses, not zero observer overhead.
No authenticated request or signed-in UI was verified. Railway labels these
Python stderr records as error severity, although the application messages are
INFO and all observer failure counters are zero.

## Play: prepared for the established manual upload, NOT Play-verified

- [Finished EAS build and AAB download](https://expo.dev/accounts/finalcut/projects/kinnship/builds/7a8ab267-7368-4513-846f-773f5d9d6f8c).
- EAS build: `7a8ab267-7368-4513-846f-773f5d9d6f8c`, still FINISHED.
- Actual source: `f7ee8479cb9f0fe9656bc84345ec1ecf43fa826a`.
- Source tree: `3b942df874670ebd40f30641b270d183ea05e38e`.
- Package `app.kinnship.client`; versionCode **71**, versionName `1.3.1`.
- Signed STORE AAB; profile/channel `diagnostic71`;
  runtime `1.3.1-diagnostic71`, unchanged from the accepted artifact.
- SHA-256: `bb3871717b39be3608db1dbb714a45f7fa5a243b9e3f3e3d530bd49337b6f2ad`.
- Static Build 70→71 package/version/upload-signer/SDK/ABI/component comparisons
  passed in the accepted review; the local AAB hash was reconfirmed.

The established next desktop step is the owner's manual upload of this exact
AAB to the existing Google Play **Internal testing** track. No automatic Play
submission, EAS Submit, service-account automation or new publishing process was
introduced. I did not upload or release the AAB to Play.

Live Play track/release/processing status and Play-reported signing,
version-code, ABI or device-compatibility errors are **unverified**. Do not
interpret static checks or an EAS STORE build as Play acceptance. Installed
Play signing lineage and actual data-preserving upgrade remain unverified.
Google Play production remains on HOLD.

## Smallest installation step, conditional on Play acceptance

Only after version 71 is accepted and available on the existing Internal testing
track: open Kinnship's Play Store listing and tap **Update**. Do not uninstall,
clear data or sideload. Stop there; no additional physical testing is requested.

No OTA, runtime/channel change, tracking/consent/ownership/scheduling/
60-minute-threshold/HTTP-policy modification, direct production-data operation,
or phone interaction was performed during this deployment step.
Ignored verification evidence: `.cache/kinnship-railway-evidence-stage/`.
