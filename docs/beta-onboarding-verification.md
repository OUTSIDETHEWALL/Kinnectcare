# Beta Onboarding Verification

This checklist validates Kinnship as a first-time customer experience. Use disposable
accounts and a new family group. Do not reuse existing family data.

## Automated and repository checks

- [x] No legacy test-person text remains in shipped UI or developer diagnostics.
- [x] No legacy test-person identifiers remain in application source, tests, documentation, or
      shipped sample assets outside the quarantined historical migration exports.
- [ ] Remove or anonymize the quarantined historical migration exports. This repository-history
      cleanup is tracked separately; the exports are not bundled into the app and do not block beta.
- [x] Sample screenshot sets contain no legacy test-person text.
- [x] TypeScript compiles.
- [x] Lint completes with no errors.
- [x] Focused onboarding, invite, check-in, alert, and Diagnostics regressions pass.
- [x] Existing location, tracking, notification, SOS, check-in, medication, and activity-reminder
      production logic is unchanged.
- [x] Production data was not modified. The remaining legacy account relationship is operational
      cleanup and does not block beta.

## First-time monitored-device run

Run these checks on a clean physical device installation.

- [ ] Create a brand-new monitored account.
- [ ] Complete foreground location permission.
- [ ] Complete background / always-on location permission.
- [ ] Complete notification permission.
- [ ] Complete physical activity permission where Android requests it.
- [ ] Review and complete battery optimization guidance.
- [ ] Confirm the first location upload reaches the backend.
- [ ] Confirm the monitored user sees the initial dashboard without stale sample data.
- [ ] Confirm Diagnostics opens and Health Check, Motion Timeline, Pipeline, and Full Diagnostics load.
- [ ] Confirm background tracking remains active after the app is backgrounded.

## Caregiver invite and synchronization run

Use a second disposable account on a second physical device.

- [ ] Send a caregiver/family invite.
- [ ] Open the invite link and join the intended family.
- [ ] Confirm both devices show the same family membership.
- [ ] Confirm the caregiver dashboard displays the monitored member's initial location.
- [ ] Confirm subsequent location updates synchronize without reopening either app.

## Core caregiver experience

- [ ] Send and complete a check-in.
- [ ] Trigger the SOS confirmation flow and verify the intended caregiver receives it.
- [ ] Create a medication reminder and verify its scheduled notification and acknowledgement path.
- [ ] Create an activity reminder and verify its scheduled notification and completion path.
- [ ] Reopen Diagnostics after these actions and confirm no new health failures appear.

## Evidence to record

For each device-only check, record:

- device model and OS version
- app version, runtime version, and update ID
- account role used
- timestamp and timezone
- pass/fail result
- relevant Diagnostics excerpt when a step fails

Native permission dialogs, background execution, push delivery, battery optimization, and real
cross-device synchronization cannot be proven in the Replit web preview. Those items remain manual
physical-device beta checks and must not be marked complete from web or unit-test evidence alone.