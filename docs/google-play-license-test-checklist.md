# First Google Play license-test purchase — review and activation checklist

## Current boundary

This is preparation, not activation. No merge, backend deployment, variable
application, OTA publication, native build, Play upload or purchase is authorized
by this checklist. The owner must separately approve each release action.
Applying Railway variables can trigger a deployment: prepare values privately,
but do not save/apply them until the backend rollout is authorized.

The correction advertises Google checkout only when **both** the authenticated
Kinnship user ID and their current family ID are explicitly approved. This
restriction applies even if the server environment is accidentally `production`.
Everyone else receives `google_billing.purchases_enabled=false` and keeps the
existing Stripe checkout branch. Existing Stripe subscription storage, prices,
renewal, cancellation and management logic are unchanged.

This is deliberately a test-only rollout. Do not expand the allowlists as a
substitute for reviewing the eventual public Google billing launch.

## 1. Confirm the phone identity and choose an isolated tester

- **Owner-confirmed directly on both Play-installed phones on 2026-11-24:**
  app `1.3.1 (Build 83)`, runtime `1.3.1-diagnostic83`, channel `production`,
  OTA status Installed, OTA ID prefix `01a20e77…`, published
  2026-11-24 16:50 UTC. This is the owner's current on-phone observation,
  not an installation inferred from a release receipt.
- **The proposed activation target is Android Build 83 only**, runtime
  `1.3.1-diagnostic83`, production channel. Do not prepare a Build 82 activation
  or override the runtime to `1.3.1-diagnostic82`.
- Native compatibility was checked against the delivered Build 83 AAB:
  SHA-256 `327a2e1c2656020f05ed84f8e0c245790c08eeb42f73ca48037abc5ff5044aa5`.
  It contains `RNPurchasesModule`, `RNPurchasesPackage`, RevenueCat `Purchases`
  and Google `BillingClient`, with implementations for `setupPurchases`,
  `setLogLevel`, `getAppUserID`, `logIn`, `getOfferings`, `purchasePackage`,
  `restorePurchases` and `syncPurchasesForResult`.
- Dependency evidence matches the unchanged client SDK: react-native-purchases
  9.12.0 → hybrid-common 17.46.1 → purchases-android 9.23.1 → Play Billing 8.0.0.
  No new native build is required. This proves static bridge compatibility,
  not successful live purchasing or provider configuration.
- Select an unpaid Kinnship test account in an isolated test family. Record its
  existing backend user ID and family ID privately; do not use an email address
  or invent IDs. Do not alter or cancel a paid Stripe family to make it eligible.
- In Google Play Console, add/select the purchase account as a **license tester**
  as well as a tester opted into the existing testing track. Verify the phone
  installed Kinnship through that track using the intended Google account.
  Track enrollment alone is not license testing.

## 2. Confirm RevenueCat's Google app settings

Verified catalog mappings:

| Item | Value |
| --- | --- |
| Android package | `app.kinnship.client` |
| RevenueCat project | `proj0c367204` |
| Google app resource | `app12a81e8a2a` |
| Entitlement lookup key | `kinnship_pro` |
| Entitlement API v2 resource ID | `entlc3edd1be9e` |
| Current offering | `default` |
| Monthly package | `$rc_monthly` → `kinnship_monthly:monthly` |
| Annual package | `$rc_annual` → `kinnship_annual:annual` |
| Owner-approved USD prices | monthly $11.99; annual $99.99 |

Both Google products were independently read as active and attached to the
entitlement and current offering. Prices must still be checked in the actual
Google purchase sheet; RevenueCat resource linkage is not proof of checkout
price or tester eligibility. Do not delete the separate Test Store products.

In the RevenueCat dashboard:

- Confirm the Google service-account credentials are valid and have the
  required Play/API permissions.
- Confirm restoration is **Keep with original App User ID** in sandbox and
  production. Only then set the server confirmation flag below.
- Leave **Track new purchases from server-to-server notifications** off for
  this initial SDK-managed purchase. Do not introduce another purchaser identity.
- Connect Google Play RTDN/Pub/Sub to RevenueCat and confirm its test delivery.
- Obtain the Google app's public `goog_` SDK key for the client and a separate
  server-only API v2 secret key with customer subscription/active-entitlement
  and product read permissions. A Replit connector does not configure Railway.
- Keep Stripe separate; do not import, migrate, reprice or cancel its customers.

## 3. Prepare Railway configuration, then obtain deployment approval

Use the existing production backend service for
`https://kinnectcare-production.up.railway.app`, **not** an unrelated project or
workspace-only secrets. Deploy only a reviewed backend release containing the
Google adapter/routes/worker and this account-scoping correction. The audit
found the live API did not yet expose the Google billing routes.

Prepare these exact non-secret values:

| Variable | Initial test-rollout value |
| --- | --- |
| `REVENUECAT_PROJECT_ID` | `proj0c367204` |
| `REVENUECAT_GOOGLE_APP_ID` | `app12a81e8a2a` |
| `REVENUECAT_ENTITLEMENT_ID` | `entlc3edd1be9e` — **not** `kinnship_pro` |
| `GOOGLE_MONTHLY_PRODUCT` | `kinnship_monthly:monthly` |
| `GOOGLE_ANNUAL_PRODUCT` | `kinnship_annual:annual` |
| `GOOGLE_BILLING_ENVIRONMENT` | `sandbox` |
| `GOOGLE_BILLING_ENABLED` | `true` |
| `GOOGLE_BILLING_RECONCILIATION_ENABLED` | `true` |
| `GOOGLE_BILLING_PURCHASES_ENABLED` | **`false` initially** |
| `GOOGLE_BILLING_EMERGENCY_ACCESS_DISABLED` | `false` |
| `GOOGLE_BILLING_ORIGINAL_OWNER_CONFIRMED` | `true` only after step 2 |
| `GOOGLE_BILLING_TEST_USER_IDS` | approved backend user IDs, comma-separated |
| `GOOGLE_BILLING_TEST_FAMILY_IDS` | approved backend family IDs, comma-separated |

The allowlists are an AND check, not an OR check: a user's ID must be in the
user list and their current family in the family list. Empty/missing lists deny
new Google checkout. Multiple lists permit any listed user within any listed
family; initially approve only the one isolated purchaser/family needed.

Set these **server-only secrets privately**, never in chat, Git, app extras,
assets or an `EXPO_PUBLIC_*` variable:

| Secret | Purpose |
| --- | --- |
| `REVENUECAT_SECRET_API_KEY` | RevenueCat API v2 secret key |
| `REVENUECAT_WEBHOOK_AUTH` | exact webhook Authorization header value; use a new high-entropy value |
| `REVENUECAT_WEBHOOK_SIGNING_SECRET` | matching RevenueCat webhook HMAC signing secret |

Leave every existing Stripe variable and subscription record untouched.
Live Railway values have **not** been verified: the earlier read was security
blocked and was not retried. Do not assume these variables are absent or replace
an existing secret blindly.

After explicit approval to merge/deploy, verify the three Google routes exist,
authenticated identity/reconciliation work for the approved tester, and the
optional reconciliation worker started. Worker creation is evaluated at backend
startup; changing flags requires an approved restart/deployment to start it.
Verify the existing Stripe account still has access and normal management.

## 4. Configure RevenueCat → Kinnship webhook

After the authorized backend is ready, configure a RevenueCat webhook:

- **URL:** `https://kinnectcare-production.up.railway.app/api/billing/google/webhook`
- **App:** Kinnship Google Play app `app12a81e8a2a`.
- **Environment:** sandbox for this license test. A mixed/production event is
  deliberately rejected while the backend expects sandbox.
- **Events:** include the subscription lifecycle, including purchase, renewal,
  cancellation, expiration, billing issues, product changes and refunds/
  revocations. Let the backend fetch current provider state rather than trusting
  a webhook's claimed entitlement.
- **Authorization:** exactly the value stored in `REVENUECAT_WEBHOOK_AUTH`.
  If a `Bearer ` prefix is used, it must match on both sides.
- **HMAC signing:** enable it and configure the matching
  `REVENUECAT_WEBHOOK_SIGNING_SECRET` on the backend. Authorization alone does
  not satisfy this implementation.

The endpoint expects:

```
X-RevenueCat-Webhook-Signature: t=<unix_seconds>,v1=<sha256_hex>
```

Signature input is `<timestamp>.<unaltered raw JSON body>` with HMAC-SHA256.
The server verifies both authentication mechanisms, constant-time comparisons
and a five-minute timestamp tolerance. Keep the server clock accurate.

Send the dashboard test and confirm successful HTTP delivery and durable inbox
acceptance. A test event or HTTP success alone does not prove a real purchase
or entitlement. A dummy unknown purchaser must never gain access.

Reference: https://www.revenuecat.com/docs/integrations/webhooks

## 5. Prepare the compatible client activation — do not publish yet

The runtime gate is resolved: target Android Build 83,
`1.3.1-diagnostic83`, production channel only.

- Review an Android-only activation source compatible with that binary. Preserve
  existing GPS/recovery, SOS, senior-friendly UI and RevenueCat implementation.
- Use the Google app's **public** SDK key and these client export settings:
  - `EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY`: correct Google app `goog_` SDK key
  - `EXPO_PUBLIC_GOOGLE_BILLING_ENABLED=true`
  - `EXPO_PUBLIC_GOOGLE_PURCHASES_ENABLED=true`
- The existing production configuration remains disabled in this preparation PR.
  No `.env.production`, native selector, channel or runtime has been changed.
- Check the effective production-export settings, not just the native-build
  profile. The reviewed production channel and exact Android runtime must match
  the confirmed phone. Verify the exported flags/catalog/identity gates without
  making any store purchase.
- No activation bundle has been exported and no purchases have been enabled.
  Client SDK-key/configuration readiness and separate publication authorization
  remain required. Request separate owner approval for **one** Android Build 83
  activation OTA; do not publish an update for another runtime.

## 6. Authorize the final purchase switch and one license-test purchase

Only after separate rollout approval, turn
`GOOGLE_BILLING_PURCHASES_ENABLED=true` on Railway with both allowlists populated.
This is an operational change and may redeploy; do not apply it as part of PR
preparation. If the deployed release uses this correction, verify:

- Approved user + approved current family: Google checkout advertised.
- Wrong user, wrong family or either missing approval: Google checkout **not**
  advertised; normal Stripe checkout remains available.
- Already-paid account/family: identity returns `can_purchase=false`.
- No current/previous Stripe subscriber was modified or migrated.
- Purchase pause does not cancel a store payment already started. Do not disable
  reconciliation or change environments to try to cancel a payment.

Confirm the chosen phone has the authorized activation OTA ID/runtime. Start one
purchase only after the Google sheet shows a license-test notice, the intended
product/price and a Google test payment instrument. **Stop if it offers a real
charge/card instead.** Do not substitute Stripe or make a second purchase after
an uncertain result.

Success requires the purchase in RevenueCat under the backend's opaque ID,
Google acknowledgment, backend-confirmed family access and unchanged Stripe
access/management. Cancellation/renewal/expiry, original-account restoration and
interrupted-purchase checks remain separate launch acceptance requirements.
