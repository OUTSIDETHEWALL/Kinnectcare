# Google Play billing: implementation and separate activation gates

## Authorization boundary

This integration is disabled by default. Code/test/PR preparation does not
authorize activating credentials, creating or changing live Play/Stripe settings,
merging, deploying, OTA publication, Android production builds, or purchases.
Existing Stripe subscriptions are not migrated, repriced or cancelled.

## Architecture and identity

- `react-native-purchases` 9.12.0 -> hybrid-common 17.46.1 -> purchases-android
  9.23.1 -> Google Play Billing 8.0.0 (published Maven POM dependency chain).
- RevenueCat owns Play receipt verification and acknowledgment. Do not enable
  observer/custom-completion mode or introduce a second acknowledgment owner.
- Backend API v2 reads verify the configured Google app, exact store identifiers,
  environment, entitlement, original and current opaque customer identities, and
  store ownership. Clients submit no account IDs, receipts or entitlement claims.
- Purchaser identities are randomly generated on the backend and never use email,
  family ID, names, GPS, SOS, medication, contacts or other family attributes.
- Immutable hash-keyed Google order-root and RevenueCat subscription ownership
  records reject a chain claimed by a different Kinnship account. RevenueCat
  additionally validates and deduplicates the underlying Play purchase tokens.
- Stripe storage remains separate. Either independently valid source grants the
  existing Family Plan through the existing any-paid-member family rule. Provider
  cancellation must never overwrite the other provider's access projection.
- Reconciliation uses a database lease and conditional final write. Webhooks
  trigger current-state reads, not blind event-state assignments. Expired leases
  cannot publish. Provider failures preserve only already-verified access until
  its authoritative expiry; they never invent a renewal or indefinite extension.
- Grace access never uses the customer-wide entitlement expiry: API v2 exposes
  `gives_access` for the particular subscription but no individual grace-end
  timestamp. An original-owned, approved subscription in grace receives a
  five-minute verification lease, refreshed after one minute. On verification
  failure it expires; this may temporarily withhold legitimate grace access,
  rather than borrow a later expiry from a sandbox or unrelated product.
- A durable minimal inbox retries webhook failures; periodic sweeps reconcile
  accounts even when webhook delivery is missed. No full webhook body is stored.
- Billing configuration/worker failures never gate core API startup. Billing
  routes fail closed and initialization is retried independently.

## Required configuration (do not activate as part of this PR)

Server-only, explicitly approved deployment configuration:

| Name | Purpose |
| --- | --- |
| `GOOGLE_BILLING_ENABLED` | Master configuration gate; exactly `true` enables the configured integration. It does not revoke already-verified access. |
| `GOOGLE_BILLING_PURCHASES_ENABLED` | Separately enables offering new Google purchases; defaults off and additionally requires working reconciliation configuration. |
| `GOOGLE_BILLING_RECONCILIATION_ENABLED` | Separately enables identity-bound recovery and projection updates; defaults off. Signed lifecycle events can still queue while processing is paused. |
| `GOOGLE_BILLING_EMERGENCY_ACCESS_DISABLED` | Defaults off. The explicit emergency switch denies Google-derived access only; it never removes independently valid Stripe access. |
| `REVENUECAT_PROJECT_ID` | Company-owned Kinnship project. |
| `REVENUECAT_GOOGLE_APP_ID` | RevenueCat Google Play app resource ID, not Test Store. |
| `REVENUECAT_SECRET_API_KEY` | Server-only API v2 key with customer subscriptions/entitlements and product read access. |
| `REVENUECAT_ENTITLEMENT_ID` | API v2 entitlement resource ID, not its display name/lookup key. |
| `GOOGLE_MONTHLY_PRODUCT` | Exact RevenueCat store identifier, e.g. approved `family_plan:monthly`. |
| `GOOGLE_ANNUAL_PRODUCT` | Exact RevenueCat store identifier, e.g. approved `family_plan:annual`. |
| `GOOGLE_BILLING_ENVIRONMENT` | `production` or `sandbox`; defaults to production, never mixes them. |
| `GOOGLE_BILLING_ORIGINAL_OWNER_CONFIRMED` | Set to `true` only after independently checking Keep with original App User ID in RevenueCat. |
| `REVENUECAT_WEBHOOK_AUTH` | High-entropy Authorization header shared with RevenueCat. |
| `REVENUECAT_WEBHOOK_SIGNING_SECRET` | RevenueCat HMAC signing secret, never in client code. |
| `GOOGLE_BILLING_TEST_USER_IDS` | Comma-separated approved synthetic purchaser IDs for sandbox only. |
| `GOOGLE_BILLING_TEST_FAMILY_IDS` | Comma-separated isolated family IDs; both user and family must match for sandbox access. |

Client build-time public configuration:

- `EXPO_PUBLIC_GOOGLE_BILLING_ENABLED=true`
- `EXPO_PUBLIC_GOOGLE_PURCHASES_ENABLED=true` only when explicitly switching new
  Android checkout to Google; leave off to preserve existing Stripe checkout
  while still allowing authenticated Google receipt recovery.
- `EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY` = Google app public `goog_` SDK key.

Never place a secret API key, webhook secret or Google service-account JSON under
an EXPO_PUBLIC name, in app config extras, source control, app assets or Android.
Use the approved secure configuration mechanism, not chat. The backend runs on
Railway: a workspace connection alone does not configure Railway's runtime.

## Owner-controlled RevenueCat / Google settings

1. Verify company ownership, recovery access and 2FA. Keep RevenueCat's Pro billing
   account current; do not connect/migrate Stripe into RevenueCat.
2. Verify/create the Google Play app for `app.kinnship.client` only after approval.
   The initial connected project contained only a Test Store app. The connector
   currently lacks app/product writes, integration writes and project writes.
3. Verify the existing Play catalog before adding anything; configure approved
   monthly US$11.99 and annual US$99.99 auto-renewing base plans, regions, taxes,
   grace/hold behavior and legal disclosures. Product identifiers are not yet
   confirmed. Import both plans into one Family Plan entitlement/offering.
4. Require sign-in before purchase. Set **Keep with original App User ID** for
   production and sandbox. Do not leave RevenueCat's default transfer setting.
   Provide account recovery; do not silently reassign purchases to new accounts.
5. Carefully review **Track new purchases from server-to-server notifications**:
   leave it off for initial SDK-managed purchasing. Its identity detection and
   the SDK's hashed obfuscatedExternalAccountId can create conflicting owners.
   Queued SDK recovery and explicit restore cover interrupted submissions;
   validate process-death completion physically before release.
6. Upload a dedicated Google service-account JSON directly to RevenueCat; enable
   required APIs and approve least-privilege Play/Cloud access. Do not reuse the
   existing release/signing service account without an explicit access review.
   Credential propagation may take up to 36 hours.
7. Connect Play RTDN/Pub/Sub to RevenueCat and verify its test notification. Add a
   RevenueCat webhook for the approved backend's `/api/billing/google/webhook`,
   correct Google app/environment, Authorization header and HMAC signing.
   The backend endpoint returns success only after durable inbox persistence.
8. Test sandbox only with both purchaser and family allowlists. Sandbox grants
   are invalid outside those approved identities/families.

## Native and release gates

- No Android binary was produced by this PR. No OTA was published. Native billing
  cannot be added to Build 81 by OTA. Keep activation switches off until approved.
  Native capability is checked before the deferred SDK import.
- Select the next versionCode/runtime under the existing approved release process,
  isolate it from Build 81, inspect the resulting AAB's billing permission,
  classes and dependency version, then obtain separate delivery authorization.
- Check purchase interruption / Android Activity launchMode against existing
  invite/auth deep links; do not change Activity behavior without native evidence.
- While either purchase rollout side is off (server or client), preserve the
  existing Android Stripe checkout. Switching to Google requires both sides plus
  native capability. A started/failed Google purchase NEVER falls back to Stripe.
  Review Google payment-policy/region compliance before publishing the transition;
  this code change is not store-policy or production-release approval.
- Account deletion warns that Google Play subscriptions must be cancelled in
  Play separately; it does not promise automatic Google cancellation.
- No live verification, acknowledgment deadline, RTDN delivery, original-owner
  setting, Console price, restored purchase or new native binary is considered
  proven by mocked SDK tests.

## Acceptance after separate authorization

The authenticated root schedules non-interactive original-owner receipt recovery
after 1.5 seconds, without gating auth/navigation/tracking/SOS. Each attempt has
a 15-second caller budget and there are at most three attempts per authenticated
root lifetime (5- and 30-second retry delays). Sign-out/account changes invalidate
pending callbacks. A timed-out native operation retains the identity serialization
lock until it settles; late or expired queued work cannot rebind another owner.
No automatic interactive `restorePurchases()` runs at startup.

`/billing/cancel` and `/billing/resume` accept optional `provider: "stripe"` for
explicit Stripe management. Legacy empty requests remain valid for Stripe-only
accounts. Google-only and ambiguous dual-provider legacy requests return 409
with guidance rather than false success. Provider outages return errors without
locally pretending to cancel recurring charges. Google renewal is managed in Play.

Disabling new purchases does not revoke existing paid entitlements. Pausing
reconciliation freezes projection updates, not signed-event intake, until restart/
re-enable; the last verified access still expires normally. Emergency access denial
is independent and Google-only. Operational switches cannot cancel a store payment
already in progress. All configuration changes still require separate approval.

Install the approved AAB through the approved internal track using a license
tester. Before every purchase, verify the correct Google account, explicit test
notice and a Google test instrument. Stop if any is missing; never substitute
Stripe or a real card. RevenueCat Test Store is not Play acceptance evidence.

Test monthly and annual native purchases; successful and declined/cancelled/
pending payment; Google acknowledgment; backend-confirmed family access; renewal;
cancellation through expiry; grace, hold, recovery, pause; refund/revocation;
offline completion and process death; reinstall/second device restoration under
the original Kinnship account; cross-account/token replay rejection; duplicate/
reordered webhook handling and downtime catch-up. Confirm existing Stripe users
retain access and provider management remains distinct.

Inspect worker health, inbox retry backlog and periodic verification timestamps
before release. Confirm no sensitive attributes were sent. Preserve redacted
evidence, and obtain explicit production-release approval.

## Automated verification

Run store-independent tests with network access limited to loopback:

```
KINNSHIP_RUN_LOCAL_MONGO_TESTS=1 PYTHONPATH=backend:backend/tests python -m pytest \
  -p loopback_guard_plugin backend/tests/test_google_billing.py \
  backend/tests/test_billing_webhook_reconciliation.py -q
cd frontend
npx jest --runInBand src/__tests__/googlePurchases.test.ts \
  src/__tests__/googleBillingRecovery.test.tsx \
  src/__tests__/googleCheckoutRollout.test.tsx \
  src/__tests__/rootLocationPermissionRecovery.test.tsx \
  src/__tests__/upgradeCheckoutReturn.test.ts --forceExit
```

The Mongo fixture starts its own disposable replica on loopback and constructs
its own URI. It never reads a development or production database credential.
