import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { api, saveToken, clearToken, User } from './api';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const TOKEN_KEY = 'kc_token';

type AuthCtx = {
  user: User | null;
  loading: boolean;
  signup: (email: string, password: string, fullName: string) => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
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
      const token = await readToken();
      if (token) {
        try {
          const res = await api.get('/auth/me');
          setUser(res.data);
        } catch (_e) {
          await clearToken();
        }
      }
      setLoading(false);
    })();
  }, []);

  const signup = async (email: string, password: string, full_name: string) => {
    const tz = (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
    const res = await api.post('/auth/signup', { email, password, full_name, timezone: tz });
    await saveToken(res.data.access_token);
    setUser(res.data.user);
  };

  const login = async (email: string, password: string) => {
    const res = await api.post('/auth/login', { email, password });
    await saveToken(res.data.access_token);
    setUser(res.data.user);
    // Sync timezone if it doesn't match device tz
    try {
      const tz = (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
      if (tz && tz !== res.data.user.timezone) {
        api.put('/auth/timezone', { timezone: tz }).catch(() => {});
      }
    } catch (_e) {}
  };

  const logout = async () => {
    await clearToken();
    setUser(null);
  };

  return (
    <Ctx.Provider value={{ user, loading, signup, login, logout }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth must be used within AuthProvider');
  return c;
}
