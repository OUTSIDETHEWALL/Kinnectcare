/**
 * pinAuth.ts — 4-digit PIN authentication module.
 *
 * Storage model:
 *   • Keyed per-user-id (so a shared device with multiple Kinnship accounts
 *     keeps each user's PIN independent).
 *   • Values live in expo-secure-store on native (iOS Keychain / Android
 *     Keystore — hardware-backed) and in AsyncStorage on web (web preview
 *     only — never used for real auth).
 *   • PIN is stored as plaintext INSIDE the secure store. SecureStore is
 *     already hardware-encrypted, so a separate hash adds no real
 *     defense-in-depth — the attacker either has Keychain access (game
 *     over for any local secret) or they don't.
 *   • A failed-attempt counter and a lockout timestamp are stored
 *     alongside the PIN; 5 consecutive wrong attempts triggers a 15-min
 *     lockout that forces the user back to email/password.
 *
 * Public API:
 *   hasPinForUser(userId)         → boolean
 *   setPin(userId, pin)           → save a new PIN (4 digits)
 *   verifyPin(userId, pin)        → { ok: true } | { ok: false, remaining, lockUntilMs }
 *   getAttemptState(userId)       → { attempts, lockUntilMs, maxAttempts }
 *   clearPin(userId)              → remove the PIN for this user
 *   resetAttempts(userId)         → wipe attempt counter (called after
 *                                   successful email/password login)
 *   markUnlocked(userId)          → set the in-memory "already unlocked
 *                                   this session" flag so the PIN gate
 *                                   doesn't re-prompt
 *   isUnlockedNow(userId)         → check session flag
 *   forgetSessionUnlock()         → call on app-backgrounded transition
 *                                   if you want to force re-PIN on resume
 */

import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const MAX_PIN_ATTEMPTS = 5;
export const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes
export const PIN_LENGTH = 4;

type PinRecord = {
  pin: string;
  attempts: number;
  lockUntilMs: number; // 0 = not locked
  createdAt: number;
};

function keyForUser(userId: string): string {
  // SecureStore keys are limited to ASCII alphanumerics + `.`/`-`/`_`,
  // so we strip anything else out of the user id.
  const safe = String(userId || '').replace(/[^A-Za-z0-9_.-]/g, '');
  return `kc_pin_${safe}`;
}

async function read(key: string): Promise<string | null> {
  if (Platform.OS === 'web') return AsyncStorage.getItem(key);
  return SecureStore.getItemAsync(key);
}

async function write(key: string, value: string): Promise<void> {
  if (Platform.OS === 'web') return AsyncStorage.setItem(key, value);
  // KEYCHAIN_ACCESSIBLE_WHEN_UNLOCKED so the PIN secret is only readable
  // after the user has unlocked their device once after boot.
  await SecureStore.setItemAsync(key, value, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED,
  });
}

async function remove(key: string): Promise<void> {
  if (Platform.OS === 'web') return AsyncStorage.removeItem(key);
  await SecureStore.deleteItemAsync(key);
}

async function loadRecord(userId: string): Promise<PinRecord | null> {
  const raw = await read(keyForUser(userId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.pin === 'string' && /^\d{4}$/.test(parsed.pin)) {
      return {
        pin: parsed.pin,
        attempts: Number(parsed.attempts) || 0,
        lockUntilMs: Number(parsed.lockUntilMs) || 0,
        createdAt: Number(parsed.createdAt) || Date.now(),
      };
    }
  } catch (_e) {}
  return null;
}

async function saveRecord(userId: string, rec: PinRecord): Promise<void> {
  await write(keyForUser(userId), JSON.stringify(rec));
}

export async function hasPinForUser(userId: string): Promise<boolean> {
  if (!userId) return false;
  const rec = await loadRecord(userId);
  return rec !== null;
}

export async function setPin(userId: string, pin: string): Promise<void> {
  if (!userId) throw new Error('Missing user id');
  if (!/^\d{4}$/.test(pin)) throw new Error('PIN must be exactly 4 digits');
  const rec: PinRecord = {
    pin,
    attempts: 0,
    lockUntilMs: 0,
    createdAt: Date.now(),
  };
  await saveRecord(userId, rec);
}

export async function clearPin(userId: string): Promise<void> {
  if (!userId) return;
  await remove(keyForUser(userId));
  unlockedSessions.delete(userId);
}

export async function resetAttempts(userId: string): Promise<void> {
  if (!userId) return;
  const rec = await loadRecord(userId);
  if (!rec) return;
  rec.attempts = 0;
  rec.lockUntilMs = 0;
  await saveRecord(userId, rec);
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'wrong'; remaining: number; lockUntilMs: number }
  | { ok: false; reason: 'locked'; lockUntilMs: number }
  | { ok: false; reason: 'no_pin' };

export async function verifyPin(userId: string, pin: string): Promise<VerifyResult> {
  const rec = await loadRecord(userId);
  if (!rec) return { ok: false, reason: 'no_pin' };
  const now = Date.now();
  if (rec.lockUntilMs && rec.lockUntilMs > now) {
    return { ok: false, reason: 'locked', lockUntilMs: rec.lockUntilMs };
  }
  if (rec.pin === pin) {
    // Success — reset counters
    rec.attempts = 0;
    rec.lockUntilMs = 0;
    await saveRecord(userId, rec);
    markUnlocked(userId);
    return { ok: true };
  }
  // Wrong PIN
  rec.attempts = (rec.attempts || 0) + 1;
  const remaining = Math.max(0, MAX_PIN_ATTEMPTS - rec.attempts);
  if (rec.attempts >= MAX_PIN_ATTEMPTS) {
    rec.lockUntilMs = now + LOCKOUT_MS;
  }
  await saveRecord(userId, rec);
  return {
    ok: false,
    reason: 'wrong',
    remaining,
    lockUntilMs: rec.lockUntilMs,
  };
}

export async function getAttemptState(userId: string) {
  const rec = await loadRecord(userId);
  return {
    hasPin: rec !== null,
    attempts: rec?.attempts || 0,
    lockUntilMs: rec?.lockUntilMs || 0,
    maxAttempts: MAX_PIN_ATTEMPTS,
  };
}

// =====================================================================
// In-memory "already unlocked this session" flag.
//
// Rationale: once the user enters the right PIN on app launch, we don't
// want to keep prompting on every navigation. We mark the user as
// unlocked-for-this-session; the flag is cleared on logout or when the
// app process is killed (since it lives only in memory).
//
// If the user backgrounds the app for a long time and you want to
// re-lock, call forgetSessionUnlock() from a state listener.
// =====================================================================
const unlockedSessions = new Set<string>();

export function markUnlocked(userId: string): void {
  if (userId) unlockedSessions.add(userId);
}

export function isUnlockedNow(userId: string): boolean {
  return !!userId && unlockedSessions.has(userId);
}

export function forgetSessionUnlock(userId?: string): void {
  if (userId) unlockedSessions.delete(userId);
  else unlockedSessions.clear();
}
