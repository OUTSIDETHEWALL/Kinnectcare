# Kinnship — Google Play background-location submission pack

**Prepared:** August 19, 2026  
**Android package:** `app.kinnship.client`  
**Scope:** `ACCESS_BACKGROUND_LOCATION` only  
**Status:** Draft ready for legal/business review and final capture. Do not submit until every item in the pre-submission checklist is complete.

## 1. Review position

### One feature to declare

**Feature name:** Family safety location sharing

**Use this as the Permissions Declaration Form answer:**

> Kinnship is a family safety and wellness app. Its core family safety feature is location sharing: a signed-in family member's current location appears to the members of their Kinnship family group so the group can confirm that the person is safe and can locate them during an SOS event. This feature needs access to location in the background because a person may lock their phone, switch to another app, or leave Kinnship after going out. If collection stopped whenever Kinnship was not visible, the family map and safety status would become stale precisely when the family needs them. Kinnship uses location only for this family safety feature, not for advertising, analytics, or sale of data.

### Reviewer notes

- Declare **only the feature above**. Google evaluates one location-based feature at a time; do not add reminders, wellness, check-ins, battery monitoring, or other features to this answer.
- Describe the same feature prominently in the Play Store description and on the public website.
- The Android manifest requests `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`, and `ACCESS_BACKGROUND_LOCATION`, plus a location foreground service. The background declaration is required even when a foreground service is used.
- Do not state that the app is an emergency service or guarantees emergency response.

## 2. Prominent in-app disclosure

This disclosure must appear in normal use, **immediately before** the Android background-location runtime permission request. It must not be buried in Settings, a privacy policy, or Terms of Service.

**Title**

> Location sharing in the background

**Body — use verbatim**

> Kinnship collects location data to enable family safety location sharing, including current location on your family map and location in SOS alerts, even when the app is closed or not in use. Your location is shared only with members of your Kinnship family group and is never used for advertising.

**Button**

> Continue

The Android system permission prompt must follow immediately after this message. “Continue” does not grant permission; Android's own prompt is the permission decision.

### Implementation included on this branch

The shared disclosure guard is called immediately before both Android request paths:

1. the legacy Expo background-location request; and
2. the Transistor native background-location request.

This avoids the prior race where the native service could request permission before onboarding had shown a compliant disclosure.

## 3. Privacy policy replacement wording

The app's privacy policy has been updated on this branch. The public policy published at the store-listing URL must contain at least the following location statements:

> **Location data.** When you grant location permission, Kinnship collects the device's precise GPS coordinates, location accuracy, and timestamps to provide current location in the family map and location in SOS alerts. This can occur while the app is open, closed, or not in use.

> **How location is used and shared.** Kinnship uses location data only to operate family location sharing and SOS safety features. Precise location and related safety information are visible to members of the Kinnship family group that the user joins. Service providers that host our infrastructure, provide map or location services, or deliver push notifications process data on Kinnship's behalf. Kinnship does not sell location data or use it for advertising.

> **Retention and controls.** Kinnship retains account data while an account is active. A user may request deletion of their account by using the in-app account-deletion controls or contacting support@kinnship.app; associated production-database data is removed within 30 days, subject to legal obligations. Users can review and change their location permissions in Android Settings.

### Public-policy requirements

Before submission, publish the policy at a stable, public, non-editable **HTTPS URL** — not a PDF and not an in-app-only route — then:

1. link it from the Google Play Store listing;
2. link it from the app; and
3. enter the exact final URL in Play Console.

**Final public privacy-policy URL:** `______________________________`

The policy currently exists inside the app but no public web URL was found in this project. That is a launch blocker until it is hosted and verified.

## 4. Thirty-second Android demo video script

Record on a real or emulator **Android** device. Do not use iOS. Use a YouTube unlisted link or a direct Google Drive link to a common video format.

| Time | Screen / action | Spoken narration or caption |
| --- | --- | --- |
| 0–3 sec | Kinnship home/dashboard; show app name and the signed-in family view. | “Kinnship helps families stay connected through voluntary family safety location sharing.” |
| 3–7 sec | Begin the normal flow that enables location sharing for the signed-in member. | “A family member enables Kinnship location sharing from the normal app flow.” |
| 7–15 sec | Show the complete **Location sharing in the background** disclosure. Hold long enough for every line to be readable. | Read the disclosure exactly: “Kinnship collects location data to enable family safety location sharing, including current location on your family map and location in SOS alerts, even when the app is closed or not in use.” |
| 15–19 sec | Tap **Continue**. Show Android's location permission UI, including the route to allow all the time if the device requires Settings. | “The Android permission prompt follows immediately after the disclosure.” |
| 19–25 sec | Return to Kinnship. Show the family map/current location or safety status updating for the signed-in member. | “Approved family-group members can see the member's current location for family safety.” |
| 25–30 sec | Press Home or lock/minimize the app, then show the persistent Kinnship location notification and the map/status still current after returning. | “Kinnship continues this feature when the app is not in use, so the shared safety status does not become stale.” |

### Recording acceptance checklist

- [ ] Video is 30 seconds or shorter.
- [ ] It shows the exact declared feature, not a generic app tour.
- [ ] It shows the complete prominent disclosure before the runtime prompt.
- [ ] It shows the Android runtime prompt.
- [ ] It shows the feature working after the app is minimized/not in use.
- [ ] All text is legible; no personal addresses, phone numbers, email addresses, or real family data appear.
- [ ] The submitted URL opens without requiring reviewer credentials.

**Final video URL:** `______________________________`

## 5. Play Console and release checklist

### Background location

- [ ] Add the Android App Bundle that contains the manifest declaration and disclosure guard.
- [ ] Complete the Play Console Permissions Declaration Form using **only** the answer in section 1.
- [ ] Add the final video URL.
- [ ] Confirm the disclosure copy in the submitted build exactly matches section 2.

### Privacy and data safety

- [ ] Add the final public privacy-policy URL to the store listing.
- [ ] Confirm the public policy includes the location, background collection, use, sharing, advertising, retention, and deletion statements in section 3.
- [ ] Complete the Data safety form from actual runtime behavior, including precise location. Do not describe location sent to Kinnship's servers as “ephemeral,” because it is retained to operate the service.
- [ ] Review each SDK and service provider's current data-practice documentation before completing Data safety. The form must describe data collected by the app and its SDKs.
- [ ] Verify every statement against the production service before submitting; Google treats inaccurate declarations as a policy issue.

### Store listing

- [ ] Store description explicitly describes **Family safety location sharing** as a core feature and says it works when the app is closed or not in use.
- [ ] Store description does not imply emergency-service dispatch, medical monitoring, or guaranteed alert delivery.
- [ ] Add contact email `support@kinnship.app`.

### Required product verification before recording

- [ ] On a new Android install, verify the disclosure appears **before** every first background-location request path.
- [ ] Verify the Android system prompt follows the disclosure immediately.
- [ ] Verify the persistent location notification is visible during sharing.
- [ ] Verify a family member can turn location sharing off and that the **native** background engine stops uploading precise coordinates. The native engine's current stop behavior requires a dedicated verification/fix before this control can be promoted as a privacy guarantee.
- [ ] Verify the app continues to function when background permission is denied, without misleading the user about available safety status.

## 6. Source of requirements

- Google Play: [Understanding location in the background permissions](https://support.google.com/googleplay/android-developer/answer/9799150)
- Google Play: [Provide information for Google Play's Data safety section](https://support.google.com/googleplay/android-developer/answer/10787469)
- Android Developers: [Access location in the background](https://developer.android.com/develop/sensors-and-location/location/background)

Google's policy page says the reviewer video should demonstrate the declared feature, the prominent in-app disclosure, the runtime prompt, and the feature operating while the app is not in use. It recommends a duration of 30 seconds or less.