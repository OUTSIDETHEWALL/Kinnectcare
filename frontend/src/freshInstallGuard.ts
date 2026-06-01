/**
 * freshInstallGuard.ts — clears stale Keychain/SecureStore state on the
 * FIRST launch after a fresh install.
 *
 * Why this exists:
 *   On iOS, `expo-secure-store` is backed by the Keychain. Keychain
 *   entries SURVIVE app uninstall by Apple design — so a user who
 *   reinstalls Kinnship will silently re-inherit a stale auth token
 *   AND a stale PIN record from the previous install. On Android,
 *   most SecureStore implementations (including expo-secure-store
 *   via AndroidX security/EncryptedSharedPreferences) DO clear on
 *   uninstall — but some OEM ROMs (notably Xiaomi MIUI and certain
 *   Samsung One UI versions with "App Twin"/"Secure Folder" enabled)
 *   can preserve EncryptedSharedPreferences across reinstalls too.
 *
 * Symptom this prevents:
 *   v6.9 users reported: "fresh install → PIN-setup screen shows
 *   BEFORE any login → entering PIN loops infinitely → uninstall +
 *   reinstall doesn't help." Root cause: the previous install's
 *   token was still in Keychain, so AuthProvider auto-loaded a
 *   ghost user, but the per-user dismissed-prompt flag (stored in
 *   AsyncStorage, which DID clear on uninstall) was missing, so
 *   RootNav routed straight to /(auth)/pin-setup with no way out
 *   for an "unauthenticated-feeling" user.
 *
 * Implementation:
 *   We write a sentinel to AsyncStorage on every launch. AsyncStorage
 *   IS reliably cleared by both iOS and Android on uninstall. On
 *   the next cold start, if the sentinel is missing we know this is
 *   a fresh install (or a clear-data wipe) — so we proactively
 *   delete the SecureStore auth token and any kc_pin_* PIN records
 *   that may have survived from the previous install.
 *
 * Exposed:
 *   maybeClearStaleSecureStoreOnFreshInstall() — call once from
 *   AuthProvider before reading the token. Idempotent: subsequent
 *   calls after the sentinel is written are no-ops.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const SENTINEL_KEY = '@kinnship/install_sentinel_v1';
const SENTINEL_VAL = 'installed';

// Keys we explicitly want to nuke on a fresh install. We keep this
// list narrow on purpose — only auth/PIN secrets, NOT app preferences
// (which are in AsyncStorage anyway and would already be gone).
const SECURE_STORE_KEYS_TO_WIPE = [
  'kc_token',        // auth token
];

/**
 * The PIN records are keyed `kc_pin_<userId>` and we don't have the
 * user ids at this point (we haven't loaded any user yet). expo-
 * secure-store doesn't expose a "list all keys" API, so the cleanest
 * way to wipe them is to clear the well-known auth token (which
 * forces a re-login) and let the post-login PIN flow re-prompt for
 * setup. Even if a stale kc_pin_<id> record survives in Keychain,
 * RootNav now never routes ANY screen for `user==null` to a PIN
 * page (see _layout.tsx), so a stale PIN record can't manifest as
 * a user-visible bug anymore.
 */

export async function maybeClearStaleSecureStoreOnFreshInstall(): Promise<void> {
  try {
    const sentinel = await AsyncStorage.getItem(SENTINEL_KEY);
    if (sentinel === SENTINEL_VAL) {
      // Not a fresh install — nothing to do.
      return;
    }
    // First run after install (or after a "clear data" wipe).
    if (Platform.OS !== 'web') {
      for (const key of SECURE_STORE_KEYS_TO_WIPE) {
        try {
          await SecureStore.deleteItemAsync(key);
        } catch (_e) {
          // Best-effort: ignore individual key failures.
        }
      }
    }
    // Mark the install as seen so subsequent launches skip this work.
    await AsyncStorage.setItem(SENTINEL_KEY, SENTINEL_VAL);
  } catch (_e) {
    // If the sentinel read/write fails (e.g. AsyncStorage is broken)
    // we'd rather fall through than block app launch. The PIN-screen
    // guards in pin-setup.tsx / pin-login.tsx / _layout.tsx will
    // still prevent the user-visible loop even without this wipe.
  }
}
