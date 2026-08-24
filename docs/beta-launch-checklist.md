# Kinnship Android Beta Launch Checklist

Use this checklist immediately before publishing the Android beta. Do not mark a
section complete from memory: record the date, person, and evidence for each
release gate.

## Release gate

- [ ] PR #105 is merged cleanly into `main`.
- [ ] The deployed commit is the intended `main` commit after the merge.
- [ ] No unreviewed code, OTA, dependency, database, or configuration changes
      are included in the release.
- [ ] A named release owner has approved the final go/no-go decision.

**Release owner:** ____________________  
**Target release date:** ____________________  
**Android version / version code:** ____________________  
**Production OTA update group:** ____________________

## 1. Railway checks

- [ ] Confirm which Railway service and repository path are active in
      production. Kinnship has both root and backend deployment paths; do not
      assume the active entrypoint from the repository layout.
- [ ] Confirm the deployed service builds from the intended requirements file.
- [ ] Confirm both supported requirements files contain
      `python-multipart==0.0.30`.
- [ ] Confirm `JWT_SECRET` exists in the actual Railway production environment.
- [ ] Confirm `JWT_SECRET` is persistent, high-entropy, and at least 32
      characters long. Never paste or print its value in a ticket, log, or chat.
- [ ] Confirm the service starts without a JWT configuration error.
- [ ] `GET /api/health` returns HTTP 200 from the production URL.
- [ ] Confirm the production API is using the intended database and does not
      point at a test database.
- [ ] Confirm the production logs show no startup crash loop, database
      connection failure, authentication failure, or notification worker error.
- [ ] Verify one authenticated health/read request with a beta account.
- [ ] Verify the backend can accept a normal location/upload event and rejects
      an obviously malformed event without inflating health counts.
- [ ] Record the current deployed commit, Railway deployment ID, and health
      check result.

**Railway deployment ID:** ____________________  
**Deployed commit:** ____________________  
**Health-check evidence:** ____________________

## 2. Expo OTA confirmation

- [ ] Confirm the EAS project, owner, and production channel are the intended
      Kinnship values.
- [ ] Confirm the OTA runtime version matches the installed Android beta.
- [ ] Confirm `EXPO_PUBLIC_*` variables are present in the shell environment
      used by `eas update`; values in `eas.json` build configuration alone are
      not sufficient for the OTA command.
- [ ] Confirm the OTA points at the production Railway API, not localhost,
      development, or a test service.
- [ ] Confirm this OTA does not add, remove, or change a native module. Native
      changes require a new Android build rather than an OTA-only update.
- [ ] Publish the OTA to the intended production channel.
- [ ] Record the update group ID, message, channel, runtime version, and commit.
- [ ] On a physical Android beta device, confirm the update downloads and
      launches successfully after a cold restart.
- [ ] Confirm the installed update reports the expected app version/build.
- [ ] Preserve the previous known-good OTA update group ID for rollback.

**OTA group ID:** ____________________  
**Channel:** ____________________  
**Runtime version:** ____________________  
**Previous known-good OTA:** ____________________

## 3. Google Play checklist

- [ ] Upload the signed Android App Bundle to the intended internal or closed
      testing track.
- [ ] Confirm package name, version code, version name, signing key, target SDK,
      and release notes.
- [ ] Confirm the Play listing identifies this as a beta and explains how users
      can report problems.
- [ ] Confirm the privacy policy URL is public, HTTPS, reachable without login,
      and matches the app and Play listing.
- [ ] Complete the Data safety form accurately for account data, location,
      device/battery telemetry, push tokens, and any data shared with service
      providers.
- [ ] Document the prominent disclosure and consent flow for background
      location before requesting the Android background-location permission.
- [ ] Confirm background location is clearly tied to the app’s core safety and
      caregiver-monitoring function.
- [ ] Confirm permission prompts are contextual, understandable, and not shown
      before the user reaches the relevant onboarding step.
- [ ] Confirm the app explains what happens when location, notification, or
      battery-optimization permissions are declined.
- [ ] Confirm the Play content rating, target audience, screenshots, support
      email, and tester instructions are complete.
- [ ] Add the intended beta testers and verify the correct countries/regions and
      testing track.
- [ ] Wait for Play processing and install the exact Play-delivered build on a
      physical Android device before launch approval.

**Play track:** ____________________  
**AAB version code:** ____________________  
**Play release URL/evidence:** ____________________

## 4. Website checklist

- [ ] Production website URL resolves over HTTPS with a valid certificate.
- [ ] Landing page clearly identifies Kinnship and the Android beta.
- [ ] Sign-in, sign-up, Email OTP, and invitation links use production URLs.
- [ ] Privacy Policy, Terms, support/contact, and account/data deletion
      information are reachable from the website.
- [ ] All public links work on mobile and desktop.
- [ ] No development domains, localhost URLs, test accounts, real family data,
      push tokens, API keys, or other secrets appear in public content.
- [ ] Website forms and analytics do not collect more information than the
      published privacy notice describes.
- [ ] If the website is not part of the beta release, record that explicitly
      rather than treating the development preview as production approval.

**Production website URL:** ____________________  
**Website verification date:** ____________________

## 5. Privacy Policy verification

- [ ] The policy describes account identity and contact information collected.
- [ ] The policy describes precise location and background-location collection,
      including why it is needed and when it occurs.
- [ ] The policy describes battery/device reliability telemetry and upload
      health data.
- [ ] The policy describes push notification tokens and notification delivery.
- [ ] The policy names relevant processors/providers and the purpose for each.
- [ ] Retention, deletion, correction, and account-removal behavior are
      accurate and actionable.
- [ ] Emergency/SOS and caregiver sharing behavior is explained clearly,
      including who can see location or alerts.
- [ ] The policy does not claim data is deleted if any backup, export, or
      migration process retains it.
- [ ] The policy link is visible during onboarding, in the app’s appropriate
      help/settings surface, on the website, and in the Play listing.
- [ ] Test the policy link from a signed-out device and an incognito browser.
- [ ] Confirm historic migration exports containing real-looking family data
      are not published, bundled, or required for live onboarding. Repository
      cleanup remains a separate task and must not be improvised during launch.

**Privacy Policy URL:** ____________________  
**Policy owner/signoff:** ____________________

## 6. Final physical-device smoke test

Use a clean or reset Android beta device and a separate caregiver device where
possible. Use test people and test phone numbers only.

### Onboarding and authentication

- [ ] Fresh install launches without a crash.
- [ ] Email OTP sign-up and sign-in succeed.
- [ ] Existing-account sign-in succeeds after force-closing and relaunching.
- [ ] App Lock is off by default, including for an account with an existing PIN.
- [ ] When App Lock is enabled, biometrics are attempted first and PIN fallback
      works.
- [ ] Disabling App Lock does not sign out, clear tokens, or force OTP.

### Permissions and background reliability

- [ ] Location permission explanation appears at the appropriate onboarding
      step.
- [ ] Background location behavior is correct after the user grants permission.
- [ ] Notification permission and push registration behave correctly.
- [ ] Battery-optimization guidance appears only in Diagnostics, not during
      sign-in or app launch.
- [ ] With the app backgrounded or force-closed, location and battery telemetry
      continue according to the documented monitoring behavior.
- [ ] The device comparison/diagnostics view shows a non-null last-attempt time
      after failed uploads and correct recovery state after connectivity returns.
- [ ] Simulate a long offline period, restore connectivity, and confirm the
      charging/upload status recovers within the expected monitoring window.

### Caregiver and senior safety flows

- [ ] A caregiver can view the family dashboard and current device status.
- [ ] A missed check-in produces the expected alert and recovery path.
- [ ] “Are you OK?” response reaches the caregiver and the screen can return to
      the dashboard after backgrounding.
- [ ] SOS persists before notification fanout, reaches the intended caregivers,
      and the active SOS screen can return to the dashboard after backgrounding.
- [ ] Location sharing can be disabled only after confirmation.
- [ ] A caregiver can invite a member, and canceling an invite requires explicit
      confirmation.
- [ ] Tapping “Call” uses the selected member’s phone number and fails clearly
      on a device that cannot place calls.
- [ ] Recovery notifications are sent once when both upload paths recover
      together.
- [ ] No test action sends a notification to the wrong caregiver or exposes
      another family’s information.

**Smoke-test device(s):** ____________________  
**Test accounts:** ____________________  
**Tester/signoff:** ____________________

## 7. Post-launch monitoring

### First hour

- [ ] Watch Railway health, error, restart, database, and notification logs.
- [ ] Confirm new beta installs can sign in and reach the dashboard.
- [ ] Confirm at least one real beta device produces expected location/upload
      telemetry without duplicate or malformed-event counts.
- [ ] Confirm push delivery for a controlled check-in or test alert.

### First 24 hours

- [ ] Review authentication failures, API 4xx/5xx rates, and crash reports.
- [ ] Review upload freshness, failed uploads, battery state, and recovery
      notifications.
- [ ] Review SOS and welfare-check delivery/acknowledgement paths.
- [ ] Review reports of battery drain, unexpected permission prompts, or
      background execution stopping.
- [ ] Check support messages at agreed intervals and record incidents.
- [ ] Do not use real family records as a debugging fixture or export.

**Monitoring owner:** ____________________  
**First-hour review time:** ____________________  
**24-hour review time:** ____________________  
**Incident/support channel:** ____________________

## 8. Rollback plan

### OTA-only regression

- [ ] Stop further OTA promotion and record the affected update group ID.
- [ ] Roll the production channel back to the preserved known-good OTA update
      group, following the project’s EAS rollback procedure.
- [ ] Test the rollback on a physical Android device before announcing recovery.
- [ ] Confirm the rollback is compatible with the installed native runtime.
- [ ] Keep the backend backward-compatible with both the affected and rolled
      back client until all active devices have converged.

### Native-build or Play regression

- [ ] Halt the Play testing release or staged rollout.
- [ ] Use the prior known-good Play build if rollback is needed; an OTA cannot
      remove a native-module regression from an installed binary.
- [ ] Disable or gate only the affected backend behavior if that can be done
      safely without hiding SOS, check-in, location, or upload failures.
- [ ] Preserve logs and timestamps; do not delete data to make dashboards look
      healthy.

### Incident closeout

- [ ] Identify the first affected update/build and the user-visible symptom.
- [ ] Notify beta testers with clear recovery instructions.
- [ ] Reproduce the regression on a test account and device.
- [ ] Prepare a fix, targeted regression test, and new verification record.
- [ ] Re-run the relevant smoke-test section before resuming rollout.
- [ ] Record the incident, decision, rollback time, recovery time, and follow-up.

**Rollback decision owner:** ____________________  
**Known-good OTA/build reference:** ____________________  
**Incident record:** ____________________

## Final decision

- [ ] **GO:** every required gate above is complete, evidence is recorded, and
      the release owner approves the beta.
- [ ] **NO-GO:** any missing Railway secret verification, failed physical-device
      smoke test, unresolved privacy-policy mismatch, or unexplained production
      error blocks launch.

**Final decision:** `GO / NO-GO`  
**Decision date/time:** ____________________  
**Approver:** ____________________  
**Notes:** ________________________________________________________________