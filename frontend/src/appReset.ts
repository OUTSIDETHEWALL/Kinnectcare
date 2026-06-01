/**
 * appReset.ts — last-resort "Reset App" recovery.
 *
 * Wipes all local app state so the user lands on a perfectly clean
 * first-launch experience. Intended for the small "Having trouble?
 * Reset app" link we surface on the PIN screens — it gives users
 * (and support) a one-tap way out if they ever end up in an
 * unrecoverable state (stale auth token, corrupted PIN record,
 * leftover SecureStore entries from a previous build, etc.).
 *
 * What gets cleared:
 *   • Auth token (`kc_token`) — forces re-login
 *   • Install sentinel — next launch is treated as fresh install
 *     so freshInstallGuard re-wipes any straggler SecureStore keys
 *   • All AsyncStorage (PIN-setup dismissed map, onboarding flag,
 *     any UI preferences). Cheaper and safer than enumerating
 *     individual keys — anything we care about is rebuilt on next
 *     launch.
 *   • SecureStore entries we know the names of
 *
 * What does NOT get cleared:
 *   • The user's actual ACCOUNT on the server — that's untouched.
 *     They'll just need to sign back in.
 *   • iOS Keychain entries we don't know about by name (we don't
 *     have a list-all API). That's OK — the next launch's
 *     freshInstallGuard catches the well-known keys, and the
 *     RootNav defensive redirect catches any stale-PIN cases.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

// Best-effort list of well-known SecureStore keys this app writes.
const KNOWN_SECURE_STORE_KEYS = [
  'kc_token',
];

export async function performFullAppReset(): Promise<void> {
  // 1. Nuke all AsyncStorage — this gets the install sentinel,
  //    pin-setup-dismissed map, onboarding flag, etc. So on next
  //    launch freshInstallGuard re-runs and treats this as a
  //    fresh install.
  try {
    await AsyncStorage.clear();
  } catch (_e) {}

  // 2. Best-effort delete of known SecureStore keys (auth token
  //    primarily). PIN records are keyed kc_pin_<userId> — we
  //    don't have user ids here, but with the auth token gone
  //    RootNav won't load any user, and the screen-level guards
  //    prevent the user from ever seeing a PIN screen without
  //    being logged in — so any straggler PIN records are inert.
  if (Platform.OS !== 'web') {
    for (const key of KNOWN_SECURE_STORE_KEYS) {
      try {
        await SecureStore.deleteItemAsync(key);
      } catch (_e) {}
    }
  }
}
