import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { api, saveToken, clearToken, User } from './api';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { forgetSessionUnlock, hasPinForUser, markUnlocked } from './pinAuth';
import { maybeClearStaleSecureStoreOnFreshInstall } from './freshInstallGuard';

const TOKEN_KEY = 'kc_token';

type AuthCtx = {
  user: User | null;
  loading: boolean;
  signup: (email: string, password: string, fullName: string, inviteCode?: string) => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
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
      // Without this, v6.9 users could end up with a stale auth
      // token after reinstall, which forced RootNav to route them
      // straight to /(auth)/pin-setup with no way back to the
      // welcome / login screen.
      try {
        await maybeClearStaleSecureStoreOnFreshInstall();
      } catch (_e) {}
      const token = await readToken();
      if (token) {
        try {
          const res = await api.get('/auth/me');
          setUser(res.data);
          // Auto-sync device timezone every launch so all server-side
          // scheduling/scheduling math runs in the user's actual tz.
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

  const signup = async (email: string, password: string, full_name: string, inviteCode?: string) => {
    const tz = (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
    const body: any = { email, password, full_name, timezone: tz };
    if (inviteCode && inviteCode.trim()) {
      body.invite_code = inviteCode.trim().toUpperCase();
    }
    const res = await api.post('/auth/signup', body);
    await saveToken(res.data.access_token);
    setUser(res.data.user);
  };

  const login = async (email: string, password: string) => {
    const res = await api.post('/auth/login', { email, password });
    const u: User = res.data.user;
    // CRITICAL ORDERING — pre-flag the PIN as unlocked-for-this-session
    // BEFORE calling setUser. Why?
    //
    // setUser triggers a re-render of RootNav, which fires its
    // [user?.id] useEffect. That effect calls hasPinForUser + checks
    // isUnlockedNow. If the user has a saved PIN AND we haven't yet
    // marked them unlocked, the effect will set needsPinUnlock=true,
    // and the routing-effect will then redirect to /(auth)/pin-login
    // — even though login.tsx is about to call markUnlocked a beat
    // later (after its /auth/me round-trip).
    //
    // Result: a brief PIN-screen FLASH between the dashboard redirect
    // and the actual landing on dashboard. User-visible regression.
    //
    // Fix: do the markUnlocked HERE, synchronously, before setUser
    // fires. By the time RootNav's effect runs, isUnlockedNow already
    // returns true → needsPinUnlock stays false → no flash.
    try {
      const has = await hasPinForUser(u.id);
      if (has) markUnlocked(u.id);
    } catch (_e) {}
    await saveToken(res.data.access_token);
    setUser(u);
    // Sync timezone if it doesn't match device tz
    try {
      const tz = (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
      if (tz && tz !== res.data.user.timezone) {
        api.put('/auth/timezone', { timezone: tz }).catch(() => {});
      }
    } catch (_e) {}
  };

  const logout = async () => {
    // Forget any in-memory "unlocked-this-session" flag for the
    // currently-signed-in user, so the next sign-in (even on the same
    // device account) re-prompts for the PIN. The PIN itself stays in
    // SecureStore — it's only invalidated when the user explicitly
    // disables it from Settings or deletes the app.
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

  // Used by the password-reset flow to log the user in immediately after
  // successfully resetting their password (the reset endpoint returns the
  // same TokenResponse shape as /auth/login).
  const hydrateFromToken = async (accessToken: string, userObj: any) => {
    await saveToken(accessToken);
    setUser(userObj);
  };

  return (
    <Ctx.Provider value={{ user, loading, signup, login, logout, refreshUser, hydrateFromToken }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth must be used within AuthProvider');
  return c;
}
