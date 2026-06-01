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
      if (token) {
        try {
          const res = await api.get('/auth/me');
          setUser(res.data);
          try {
            const tz = (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
            if (tz && tz !== res.data.timezone) {
              const updated = await api.put('/auth/timezone', { timezone: tz });
              setUser(updated.data);
            }
          } catch (_e) {}
        } catch (_e) {
          await clearToken();
        }
      }
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
    setUser(null);
  };

  const refreshUser = async () => {
    try {
      const res = await api.get('/auth/me');
      setUser(res.data);
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
