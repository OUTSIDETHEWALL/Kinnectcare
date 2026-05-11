import axios from 'axios';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const BASE = process.env.EXPO_PUBLIC_BACKEND_URL;

const TOKEN_KEY = 'kc_token';

async function getToken(): Promise<string | null> {
  if (Platform.OS === 'web') {
    return await AsyncStorage.getItem(TOKEN_KEY);
  }
  return await SecureStore.getItemAsync(TOKEN_KEY);
}

export async function saveToken(token: string) {
  if (Platform.OS === 'web') {
    await AsyncStorage.setItem(TOKEN_KEY, token);
  } else {
    await SecureStore.setItemAsync(TOKEN_KEY, token);
  }
}

export async function clearToken() {
  if (Platform.OS === 'web') {
    await AsyncStorage.removeItem(TOKEN_KEY);
  } else {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  }
}

export const api = axios.create({
  baseURL: `${BASE}/api`,
  timeout: 15000,
});

api.interceptors.request.use(async (config) => {
  const token = await getToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export type User = { id: string; email: string; full_name: string };
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
};
export type Alert = {
  id: string;
  member_id: string;
  member_name: string;
  type: 'missed_checkin' | 'low_battery' | 'medication' | 'sos';
  severity: 'critical' | 'warning' | 'info';
  title: string;
  message: string;
  acknowledged: boolean;
  created_at: string;
};
export type Reminder = {
  id: string;
  member_id: string;
  member_name: string;
  title: string;
  time: string;
  taken: boolean;
};
