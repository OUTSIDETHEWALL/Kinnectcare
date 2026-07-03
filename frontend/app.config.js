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
      versionCode: 55, // Build 55 — ME PAGE & SETTINGS CLEANUP. (A) Me tab full rewrite (app/(tabs)/me.tsx): editable Name/Time zone via PATCH /api/auth/me, Plan card (Stripe status + Manage Subscription), Notifications (push registration status + Retry + Quiet Hours), Security (PIN + Biometrics toggle), Privacy (Location Sharing toggle), Legal, Diagnostics, Sign out, Delete Account. (B) PIN session persistence — 24 h rolling TTL via src/pinSession.ts (AsyncStorage-backed); refreshed only on actual PIN or biometric unlock, NOT on foreground; survives Android low-memory JS-process reclaim. (C) Optional biometrics (src/biometrics.ts using expo-local-authentication) — Face ID / Fingerprint / Touch ID as convenience alternative to PIN, never replacement. Auto-prompts on /(auth)/pin-login when enabled; silent fallback to PIN pad on cancel/failure/lockout. (D) Location Sharing toggle: server preference `location_sharing_enabled` on user doc + on-device LOCATION_SHARING_DISABLED_KEY guard in backgroundLocation.ts task and locationRefresh.ts foreground path — no coord leaves the phone when OFF. (E) Legacy /settings route deleted entirely; all links (manage-subscription, diagnostics) rerouted to /(tabs)/me; Stack.Screen removed. (F) Backend PATCH /api/auth/me added (partial full_name/timezone update with validation); GET/PUT /me/preferences extended to carry location_sharing_enabled with default-true migration. (G) Feature-freeze target: Build #56.
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
          icon: './assets/images/kinnship-notification-icon.png',
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
