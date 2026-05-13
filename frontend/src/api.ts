import axios from 'axios';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const BASE = process.env.EXPO_PUBLIC_BACKEND_URL;
const TOKEN_KEY = 'kc_token';

async function getToken(): Promise<string | null> {
  if (Platform.OS === 'web') return AsyncStorage.getItem(TOKEN_KEY);
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export async function saveToken(token: string) {
  if (Platform.OS === 'web') await AsyncStorage.setItem(TOKEN_KEY, token);
  else await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function clearToken() {
  if (Platform.OS === 'web') await AsyncStorage.removeItem(TOKEN_KEY);
  else await SecureStore.deleteItemAsync(TOKEN_KEY);
}

export const api = axios.create({
  baseURL: `${BASE}/api`,
  timeout: 20000,
});

api.interceptors.request.use(async (config) => {
  const token = await getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

export type User = { id: string; email: string; full_name: string; timezone?: string };

export type Member = {
  id: string;
  name: string;
  age: number;
  phone: string;
  gender: string;
  role: 'family' | 'senior';
  status: 'healthy' | 'warning' | 'critical';
  last_seen: string;
  location_name?: string;
  latitude?: number;
  longitude?: number;
  avatar_url?: string;
  daily_checkin_time?: string | null;
};

export type Alert = {
  id: string;
  member_id: string;
  member_name: string;
  type: 'missed_checkin' | 'low_battery' | 'medication' | 'routine' | 'sos';
  severity: 'critical' | 'warning' | 'info';
  title: string;
  message: string;
  latitude?: number;
  longitude?: number;
  acknowledged: boolean;
  created_at: string;
};

export type TimeSlot = { time: string; label?: string | null };

export type Reminder = {
  id: string;
  member_id: string;
  member_name: string;
  category: 'medication' | 'routine';
  title: string;
  dosage?: string | null;
  times: TimeSlot[];
  time: string;
  status: 'pending' | 'taken' | 'missed';
  taken: boolean;
  last_marked_at?: string | null;
  last_marked_date?: string | null;
};

export type MemberSummary = {
  member_id: string;
  name: string;
  role: 'family' | 'senior';
  status: 'healthy' | 'warning' | 'critical';
  medication_total: number;
  medication_taken: number;
  medication_missed: number;
  routine_total: number;
  routine_done: number;
  checked_in_today: boolean;
  last_checkin_time?: string | null;
  daily_checkin_time?: string | null;
  weekly_compliance_percent?: number | null;
  weekly_logged?: number;
};

export type BillingStatus = {
  plan: 'free' | 'family_plan';
  status?: string | null;
  member_limit: number | null; // null when unlimited (paid)
  member_count: number;
  members_remaining: number | null;
  current_period_end?: string | null;
  cancel_at_period_end?: boolean;
  stripe_customer_id?: string | null;
  manage_url?: string | null;
  paid_plan: {
    amount_cents: number;
    currency: string;
    interval: string;
    product_name: string;
  };
};

export async function getBillingStatus(): Promise<BillingStatus> {
  const r = await api.get('/billing/status');
  return r.data;
}

export async function createCheckoutSession(returnUrl?: string): Promise<{
  checkout_url: string;
  session_id: string;
  publishable_key: string | null;
}> {
  const successUrl = returnUrl ? `${returnUrl}?status=success` : undefined;
  const cancelUrl = returnUrl ? `${returnUrl}?status=cancel` : undefined;
  const r = await api.post('/billing/checkout-session', {
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
  return r.data;
}

export type PaywallError = {
  paywall: true;
  code: string;
  message: string;
  current?: number;
  limit?: number;
};

export function isPaywall(err: any): PaywallError | null {
  const data = err?.response?.data?.detail;
  if (data && typeof data === 'object' && data.paywall === true) {
    return data as PaywallError;
  }
  return null;
}
