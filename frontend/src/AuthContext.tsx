import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { api, saveToken, clearToken, User } from './api';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { forgetSessionUnlock, hasPinForUser, markUnlocked, clearPin } from './pinAuth';
import {
  maybeClearStaleSecureStoreOnFreshInstall,
  wasFreshInstallThisLaunch,
  consumeFreshInstallFlag,
} from './freshInstallGuard';

const TOKEN_KEY = 'kc_token';
// v1.2 beta — cache the user object alongside the token so we can
// rehydrate the session OFFLINE on cold-start (e.g. after a device
// reboot when the network hasn't reconnected yet).  Without this
// cache, /auth/me on cold-start was the only path to know who the
// user IS, and any transient network failure (Samsung's slow Wi-Fi
// re-handshake post-reboot) caused user=null → PIN gate skipped →
// RootNav fell through to the welcome / OTP path.  With the cache,
// PIN gate fires immediately and /auth/me retries silently in the
// background.
const USER_CACHE_KEY = 'kc_user_cache_v1';

async function readUserCache(): Promise<User | null> {
  // v1.2-hotfix2: switched from SecureStore to AsyncStorage because
  // expo-secure-store on Android enforces a ~2 KB per-value limit and
  // the full User object (with timezone, emergency contacts, family
  // group metadata, etc.) was occasionally exceeding that — causing
  // setItemAsync() to throw silently inside the try/catch in
  // writeUserCache().  Net effect: cache appeared to write but the
  // bytes never landed → next cold-start read returned null → user
  // bounced to welcome screen.  AsyncStorage has no such limit and
  // is already used elsewhere for non-secret state (disclaimer ack,
  // onboarding flag, install sentinel).  The User object isn't a
  // secret — the BEARER TOKEN (still in SecureStore) is the
  // sensitive credential.
  try {
    const raw = await AsyncStorage.getItem(USER_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as User;
  } catch (_e) {
    return null;
  }
}

async function writeUserCache(u: User | null): Promise<void> {
  try {
    if (!u) {
      await AsyncStorage.removeItem(USER_CACHE_KEY);
      return;
    }
    await AsyncStorage.setItem(USER_CACHE_KEY, JSON.stringify(u));
  } catch (_e) {}
}

/**
 * AuthContext — passwordless email-OTP auth.
 *
 * As of v6.11 Kinnship has no password fields anywhere. Authentication
 * is a two-step email-OTP flow:
 *
 *   1. requestOtp({ email, purpose: 'login' | 'signup', fullName?, inviteCode? })
 *      → backend emails a 6-digit code valid for 10 minutes.
 *   2. verifyOtp({ email, code })
 *      → on match, backend returns a JWT + user. We store the token
 *        and set the user, identical post-conditions to the old
 *        login()/signup() methods.
 *
 * The PIN unlock flow continues to work after the initial OTP — see
 * pinAuth.ts. Email-OTP is now also the "master key" if the user
 * forgets their PIN.
 */
type RequestOtpArgs = {
  email: string;
  purpose: 'login' | 'signup';
  fullName?: string;
  inviteCode?: string;
};

type AuthCtx = {
  user: User | null;
  loading: boolean;
  requestOtp: (args: RequestOtpArgs) => Promise<{ ok: boolean; message: string; expiresInSeconds: number }>;
  resendOtp: (args: RequestOtpArgs) => Promise<{ ok: boolean; message: string; expiresInSeconds: number }>;
  verifyOtp: (args: { email: string; code: string }) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
};

const Ctx = createContext<AuthCtx | undefined>(undefined);

async function readToken(): Promise<string | null> {
  if (Platform.OS === 'web') return AsyncStorage.getItem(TOKEN_KEY);
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      // FRESH-INSTALL GUARD — clear any stale Keychain/SecureStore
      // entries that may have survived a previous app uninstall
      // (iOS Keychain entries persist by Apple design, and some
      // Android OEM ROMs preserve EncryptedSharedPreferences too).
      try {
        await maybeClearStaleSecureStoreOnFreshInstall();
      } catch (_e) {}
      const token = await readToken();
      if (!token) {
        // No token at all — definitely not signed in.  Dismiss loading
        // immediately so the user reaches the welcome screen.
        setLoading(false);
        return;
      }
      // We have a token.  From here we MUST NOT dismiss loading until
      // we have either:
      //   (a) restored a cached user (offline path), OR
      //   (b) successfully called /auth/me (online path), OR
      //   (c) confirmed the token is invalid via a 401 from /auth/me.
      // Any earlier loading=false would flash the welcome screen
      // through to the user — the exact bug Joyce + Charles saw on
      // notification tap.
      const cachedUser = await readUserCache();
      if (cachedUser) {
        // OFFLINE-FIRST: cache hit → restore the session immediately
        // and dismiss loading.  /auth/me continues in the background.
        setUser(cachedUser);
        setLoading(false);
      }
      try {
        const res = await api.get('/auth/me');
        setUser(res.data);
        await writeUserCache(res.data);
        try {
          const tz = (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
          if (tz && tz !== res.data.timezone) {
            const updated = await api.put('/auth/timezone', { timezone: tz });
            setUser(updated.data);
            await writeUserCache(updated.data);
          }
        } catch (_e) {}
      } catch (e: any) {
        let status = e?.response?.status;
        // RETRY-ONCE on 401: a single transient 401 (Mongo brief
        // read failure, Railway edge restart, etc.) must NOT
        // permanently log the user out.  Pause 2s and reissue.
        if (status === 401) {
          try {
            await new Promise((r) => setTimeout(r, 2000));
            const res2 = await api.get('/auth/me');
            setUser(res2.data);
            await writeUserCache(res2.data);
            status = undefined; // recovered
          } catch (e2: any) {
            status = e2?.response?.status;
            // Capture body+url for the diag below, replace e for that
            e = e2;
          }
        }
        if (status === 401) {
          // Confirmed two consecutive 401s → token genuinely invalid.
          // Write diagnostic record BEFORE clearing so we can
          // post-mortem next session.
          try {
            const raw = await AsyncStorage.getItem('kc_auth_clear_diag');
            const arr: any[] = raw ? JSON.parse(raw) : [];
            let bodyStr: string | null = null;
            try { bodyStr = JSON.stringify(e?.response?.data).slice(0, 500); } catch (_) {}
            arr.push({
              t: Date.now(),
              source: 'bootstrap_two_401s',
              status: 401,
              body: bodyStr,
              url: e?.config?.url || null,
              cachedUserId: cachedUser?.id || null,
            });
            while (arr.length > 20) arr.shift();
            await AsyncStorage.setItem('kc_auth_clear_diag', JSON.stringify(arr));
          } catch (_e) {}
          await clearToken();
          await writeUserCache(null);
          setUser(null);
        }
        // else: keep token AND cached user. PIN gate handles UX.
      }
      // Catch-all flip in case the cache hit branch above didn't
      // already do it (cache miss + /auth/me success path lands here).
      setLoading(false);
    })();
  }, []);

  /**
   * Request an OTP for the given email. Returns the same payload the
   * server returns ({ ok, message, expires_in_seconds }) so the OTP
   * verify screen can show a contextual hint + countdown.
   */
  const requestOtp = async (args: RequestOtpArgs) => {
    const tz =
      (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
    const body: any = {
      email: (args.email || '').trim().toLowerCase(),
      purpose: args.purpose,
    };
    if (args.purpose === 'signup') {
      body.full_name = (args.fullName || '').trim();
      body.timezone = tz;
      if (args.inviteCode && args.inviteCode.trim()) {
        body.invite_code = args.inviteCode.trim().toUpperCase();
      }
    }
    const res = await api.post('/auth/request-otp', body);
    return {
      ok: !!res.data?.ok,
      message: String(res.data?.message || ''),
      expiresInSeconds: Number(res.data?.expires_in_seconds || 600),
    };
  };

  // resendOtp is just an alias for requestOtp — the backend exposes
  // /auth/resend-otp as a separate endpoint to make intent explicit
  // but it accepts the same payload. We surface it as a separate
  // method so the OTP-verify screen can clearly distinguish "ask
  // again" from "send for the first time" in its UI copy.
  const resendOtp = async (args: RequestOtpArgs) => {
    const body: any = {
      email: (args.email || '').trim().toLowerCase(),
      purpose: args.purpose,
    };
    if (args.purpose === 'signup') {
      const tz =
        (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
      body.full_name = (args.fullName || '').trim();
      body.timezone = tz;
      if (args.inviteCode && args.inviteCode.trim()) {
        body.invite_code = args.inviteCode.trim().toUpperCase();
      }
    }
    const res = await api.post('/auth/resend-otp', body);
    return {
      ok: !!res.data?.ok,
      message: String(res.data?.message || ''),
      expiresInSeconds: Number(res.data?.expires_in_seconds || 600),
    };
  };

  /**
   * Verify a 6-digit OTP. On success the user is signed in (token
   * persisted, AuthContext.user updated). On failure, the call
   * throws — the verify screen surfaces the error.
   */
  const verifyOtp = async ({ email, code }: { email: string; code: string }) => {
    const res = await api.post('/auth/verify-otp', {
      email: (email || '').trim().toLowerCase(),
      code: (code || '').trim(),
    });
    const u: User = res.data.user;

    // FRESH-INSTALL PIN CLEANUP — if this launch was detected as a
    // fresh install (Keychain auth-token wiped by freshInstallGuard),
    // also wipe the user's stale Keychain PIN record so RootNav
    // doesn't bounce them to /(auth)/pin-login asking for a forgotten
    // PIN. Identical reasoning as the legacy password login path —
    // see comment block in v6.10 for the full backstory.
    if (wasFreshInstallThisLaunch()) {
      try { await clearPin(u.id); } catch (_e) {}
      consumeFreshInstallFlag();
    }

    // Pre-flag the PIN as unlocked-for-this-session BEFORE setUser
    // fires. This prevents a one-frame flash of /(auth)/pin-login
    // for users who already have a PIN saved — a fresh OTP sign-in
    // is strictly STRONGER than a saved PIN, so we don't need to
    // ask for the PIN again right after verifying ownership of the
    // email.
    try {
      const has = await hasPinForUser(u.id);
      if (has) markUnlocked(u.id);
    } catch (_e) {}

    await saveToken(res.data.access_token);
    setUser(u);
    // Cache the fresh user object so a subsequent cold-start (e.g.
    // device reboot, then notification tap) can rehydrate the
    // session OFFLINE and fire the PIN gate without waiting on
    // /auth/me.  Fixes "Notification → OTP instead of PIN".
    await writeUserCache(u);

    // Sync timezone if it doesn't match device tz
    try {
      const tz =
        (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
      if (tz && tz !== u.timezone) {
        api.put('/auth/timezone', { timezone: tz }).catch(() => {});
      }
    } catch (_e) {}
  };

  const logout = async () => {
    forgetSessionUnlock(user?.id);
    await clearToken();
    await writeUserCache(null);
    setUser(null);
  };

  const refreshUser = async () => {
    try {
      const res = await api.get('/auth/me');
      setUser(res.data);
      await writeUserCache(res.data);
    } catch (_e) {}
  };

  return (
    <Ctx.Provider value={{ user, loading, requestOtp, resendOtp, verifyOtp, logout, refreshUser }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth must be used within AuthProvider');
  return c;
}
