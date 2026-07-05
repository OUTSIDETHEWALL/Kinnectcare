/**
 * freshInstallGuard.ts — detect a fresh install for downstream cleanup.
 *
 * Background: on iOS, expo-secure-store is backed by the Keychain, and
 * Keychain entries SURVIVE app uninstalls by Apple design — so a user
 * who reinstalls Kinnship will silently inherit stale PIN records
 * (`kc_pin_<userId>`) from the previous install. After login they'd
 * be sent to pin-login asking for a PIN they don't remember.
 *
 * Our fix: write a sentinel to AsyncStorage on every launch.
 * AsyncStorage IS reliably cleared on uninstall on both iOS and
 * Android. When we see the sentinel missing, we know this is a fresh
 * install — and we set an in-memory flag that AuthContext later
 * reads to clear the user's specific stale PIN record AFTER they
 * successfully sign in via OTP (at which point we know which userId
 * to clear).
 *
 * IMPORTANT — what we DON'T do here anymore:
 *   We used to ALSO proactively wipe `kc_token` from SecureStore on
 *   every fresh-install launch. That turned out to be too
 *   aggressive: if the AsyncStorage sentinel write ever failed for
 *   any reason on a user's device, EVERY launch was treated as a
 *   fresh install → token wiped → user forced to OTP-login every
 *   single time, making the PIN pointless.
 *
 *   The proactive wipe was no longer necessary anyway: the
 *   /auth/me call in AuthContext naturally returns 401 for any
 *   stale/invalid token, at which point clearToken() fires. And
 *   the pin-screen-level guards prevent any "stale-user → pin-setup
 *   loop" UI bug regardless of token freshness.
 *
 *   So v6.11.1 onward: this guard ONLY records the fresh-install
 *   signal. Token cleanup happens organically via /auth/me.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const SENTINEL_KEY = '@kinnship/install_sentinel_v1';
const SENTINEL_VAL = 'installed';

let _wasFreshInstall = false;

export function wasFreshInstallThisLaunch(): boolean {
  return _wasFreshInstall;
}

export function consumeFreshInstallFlag(): void {
  _wasFreshInstall = false;
}

export async function maybeClearStaleSecureStoreOnFreshInstall(): Promise<void> {
  try {
    const sentinel = await AsyncStorage.getItem(SENTINEL_KEY);
    if (sentinel === SENTINEL_VAL) {
      // Not a fresh install — nothing to do.
      return;
    }
    // First run after install (or after a "clear data" wipe).
    _wasFreshInstall = true;
    // NOTE: we deliberately do NOT wipe SecureStore kc_token here
    // anymore. See the file-header comment for the rationale. The
    // token will be validated by /auth/me on the next AuthContext
    // mount; if it's stale it'll naturally 401 and clearToken
    // will fire — same end result, but without the risk of
    // wiping a perfectly good token if AsyncStorage is flaky.
    await AsyncStorage.setItem(SENTINEL_KEY, SENTINEL_VAL);
  } catch (_e) {
    // If AsyncStorage is broken (very rare), the worst case is we
    // treat every launch as a fresh install — which now is benign,
    // since the only consequence is that AuthContext will try to
    // clear the stale PIN record after the next successful OTP
    // login. Token is untouched.
  }
}
