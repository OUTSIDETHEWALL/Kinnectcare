/**
 * Kinnship — Expo dynamic app config (v1.2.0+).
 *
 * Converted from `app.json` to `app.config.js` in the Transistor location
 * engine migration so we can inject the
 * `react-native-background-geolocation` Android + iOS license keys at
 * build time from `process.env` without ever committing the JWT strings
 * to Git.
 *
 * Local dev / `npx expo run:android`:
 *   • Keys are loaded from `/app/frontend/.env` (gitignored, mode 600).
 *
 * EAS cloud builds (`eas build`):
 *   • Keys are loaded from EAS Secrets uploaded once via
 *     `eas secret:create TRANSISTOR_LICENSE_ANDROID --type string ...`.
 *   • Expo's build infrastructure injects them as env vars before this
 *     file is evaluated.
 *
 * Everything else is byte-for-byte preserved from the prior `app.json`
 * to keep OTA channels, runtime versions, and EAS pipelines stable
 * during the migration.
 */
const TRANSISTOR_LICENSE_ANDROID = process.env.TRANSISTOR_LICENSE_ANDROID || '';
const TRANSISTOR_LICENSE_IOS = process.env.TRANSISTOR_LICENSE_IOS || '';

module.exports = ({ config }) => ({
  ...config,
  expo: {
    name: 'Kinnship',
    slug: 'kinnship',
    version: '1.2.0',
    runtimeVersion: { policy: 'appVersion' },
    updates: {
      url: 'https://u.expo.dev/11cb65a8-eab0-4745-9b4a-7b8964805381',
      enabled: true,
      checkAutomatically: 'ON_LOAD',
      fallbackToCacheTimeout: 0,
    },
    orientation: 'portrait',
    icon: './assets/images/kinnship-icon-1024.png',
    scheme: 'kinnship',
    userInterfaceStyle: 'automatic',
    newArchEnabled: true,

    ios: {
      supportsTablet: true,
      bundleIdentifier: 'app.kinnship.client',
      buildNumber: '1',
      infoPlist: {
        NSLocationWhenInUseUsageDescription:
          'Share your location with family during check-ins and SOS.',
        NSLocationAlwaysAndWhenInUseUsageDescription:
          'Keep your family updated on your location for safety, even when the app is closed.',
        NSLocationAlwaysUsageDescription:
          'Keep your family updated on your location for safety.',
        // Transistor SDK requires Motion access for activity-based
        // adaptive cadence (still / walking / driving detection).
        NSMotionUsageDescription:
          'Kinnship uses motion to detect when you start moving and update your family.',
        NSCameraUsageDescription: 'Add profile photos for family members.',
        NSContactsUsageDescription: 'Pick an emergency contact from your phone.',
        ITSAppUsesNonExemptEncryption: false,
        // Transistor SDK iOS license — read from EAS Secrets / .env.
        TSLocationManagerLicense: TRANSISTOR_LICENSE_IOS,
        UIBackgroundModes: [
          'location',
          'fetch',
          'processing',
          'remote-notification',
        ],
      },
    },

    android: {
      package: 'app.kinnship.client',
      versionCode: 60, // Build 60 — INVITATION FLOW OVERHAUL. Comprehensive fix for the "invitee never appears on caregiver's dashboard" issue that persisted after Build #59's ensure_self_member_row hotfix. Root cause: even with backend member-creation working, the invitation ACCEPTANCE never fired because (a) `kinnship://` deep-link URLs fail silently when the app is not installed — most fresh-install users never reach the app with an invite context, and (b) there was no persistence layer to carry the invite token across install / signup / verify-otp boundaries. Fixes: (i) NEW BACKEND ROUTE `GET /invite/{token}` — HTML landing page that tries `kinnship://invite/{token}` via JS, auto-falls-back to Google Play (with `?referrer=invite_token%3D{token}` install-referrer so future native referrer capture can auto-resume). (ii) EMAIL REDESIGN — primary "Accept Invitation" button now points at the HTTPS landing page instead of the raw scheme URL, so it works in every mail client / on every device / whether the app is installed or not. Redundant "Install from Play Store" secondary button removed since the landing page handles that. (iii) NEW FRONTEND MODULE `src/pendingInvite.ts` — AsyncStorage-backed persistence for invite tokens with 14-day TTL. (iv) `_layout.tsx` RootNav — cold-start (Linking.getInitialURL) + warm-start (Linking.addEventListener) deep-link handler that extracts INV-/KINN- tokens from both `kinnship://invite/{token}` AND `https://.../invite/{token}` URLs, persists them to AsyncStorage, immediately joins if user is authenticated, and pushes to /invite/{token} for the friendly preview. (v) `AuthContext.verifyOtp` — post-authentication hook auto-consumes any pending invite token via POST /family-group/join and re-fetches /auth/me so RootNav sees the new family_group_id. Idempotent: 404 / already-member responses are silently swallowed. (vi) `app/invite/[token].tsx` — also stashes token via setPendingInvite for belt-and-suspenders coverage across any entry vector. Net effect: invitee taps Accept Invitation → guaranteed to land in the caregiver's family, on the very next dashboard poll, whether the app was installed or not, whether they'd signed up before or not.
      googleServicesFile: './google-services.json',
      adaptiveIcon: {
        foregroundImage: './assets/images/kinnship-adaptive-foreground-1024.png',
        backgroundColor: '#1B5E35',
      },
      edgeToEdgeEnabled: true,
      permissions: [
        // Existing location set
        'ACCESS_FINE_LOCATION',
        'ACCESS_COARSE_LOCATION',
        'ACCESS_BACKGROUND_LOCATION',
        'FOREGROUND_SERVICE',
        'FOREGROUND_SERVICE_LOCATION',
        'POST_NOTIFICATIONS',
        'READ_CONTACTS',
        'WAKE_LOCK',
        // Required by Transistor for Activity Recognition (motion-based
        // adaptive cadence — still / walking / driving transitions).
        'ACTIVITY_RECOGNITION',
        // Required for the SDK's auto-start-on-boot behavior so the
        // foreground service comes back up after device reboot.
        'RECEIVE_BOOT_COMPLETED',
      ],
    },

    web: {
      bundler: 'metro',
      output: 'static',
      favicon: './assets/images/kinnship-icon-1024.png',
    },

    plugins: [
      'expo-router',
      './plugins/withAndroidTelQueries',
      // ----- Transistor Software react-native-background-geolocation -----
      // Order matters: the Transistor plugin must come BEFORE expo-location
      // so its AndroidManifest entries land first.  License key is read from
      // env (uploaded to EAS Secrets / present in local .env), never inline.
      [
        'react-native-background-geolocation',
        {
          license: TRANSISTOR_LICENSE_ANDROID,
        },
      ],
      // Transistor's companion package — manages Gradle ext-vars for the
      // tslocationmanager native module and the Play Services location
      // dependency.  Versions per Transistor's official Expo SDK setup.
      [
        'expo-gradle-ext-vars',
        {
          googlePlayServicesLocationVersion: '21.3.0',
          tslocationmanagerVersion: '4.2.+',
          appCompatVersion: '1.6.1',
        },
      ],
      // `expo-location` retained ONLY for foreground one-time location
      // reads (e.g. "Where am I right now?" during onboarding / manual
      // map refresh).  Background tracking has been migrated to the
      // Transistor SDK as of v1.2.0.  We keep the foreground service
      // flag = false here because Transistor owns the foreground service.
      [
        'expo-location',
        {
          locationAlwaysAndWhenInUsePermission:
            'Kinnship keeps your family updated on your location so we can reach you in an emergency.',
          locationAlwaysPermission:
            'Kinnship keeps your family updated on your location so we can reach you in an emergency.',
          locationWhenInUsePermission:
            'Share your location with family during check-ins and SOS.',
          isIosBackgroundLocationEnabled: true,
          isAndroidBackgroundLocationEnabled: true,
          isAndroidForegroundServiceEnabled: false,
        },
      ],
      // expo-task-manager still loaded for legacy fallback path (Phase 4
      // removes this dependency entirely once the Transistor engine is
      // accepted via the Walmart + Overnight tests).
      'expo-task-manager',
      [
        'expo-splash-screen',
        {
          image: './assets/images/kinnship-splash-1024.png',
          imageWidth: 220,
          resizeMode: 'contain',
          backgroundColor: '#1B5E35',
        },
      ],
      [
        'expo-notifications',
        {
          // Build #58 — filename bumped to *-v2.png to force EAS +
          // Android to rebuild the notification drawable resource.
          // Same shield-checkmark silhouette Charles approved in
          // Build #56, but Android was still surfacing the old "K"
          // in the tray — most likely because the previously
          // installed AAB registered its channels with the old
          // drawable and channels are sticky once created.  A new
          // filename forces a fresh drawable AND a new channel
          // registration on next launch (see `silent_v3`, `meds_v2`,
          // etc. below).
          icon: './assets/images/kinnship-notification-icon-v2.png',
          color: '#1B5E35',
          defaultChannel: 'default',
        },
      ],
      'expo-font',
    ],

    extra: {
      router: {},
      eas: {
        projectId: '11cb65a8-eab0-4745-9b4a-7b8964805381',
      },
    },
    experiments: {
      typedRoutes: true,
    },
    owner: 'finalcut',
  },
});
