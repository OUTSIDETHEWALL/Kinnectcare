import * as SecureStore from 'expo-secure-store';
import { api } from './api';

const HEX = /^[a-f0-9]{64}$/;
const KEY = 'kc_email_link_requests_v1';
const LIFETIME = 15 * 60 * 1000;
let receivedLink: { token: string; state: string } | null = null;
const linkListeners = new Set<() => void>();
type Pending = { verifier: string; at: number };
type PendingMap = Record<string, Pending>;

export function parseEmailLink(url: string | null): { token: string; state: string } | null {
  if (!url) return null;
  // Accept only our HTTPS origin or native scheme, never arbitrary URLs that
  // happen to contain a token. Fragments keep credentials out of server logs.
  if (!/^(?:https:\/\/kinnectcare-production\.up\.railway\.app\/auth\/email-link|kinnship:\/\/auth\/email-link)(?:#|$)/.test(url)) return null;
  const p = new URLSearchParams(url.split('#')[1] || '');
  const token = p.get('token') || '';
  const state = p.get('state') || '';
  return HEX.test(token) && HEX.test(state) ? { token, state } : null;
}

// A warm URL event can occur before Expo Router mounts the target screen.
// Capture synchronously in the already-mounted root listener, not only in
// a leaf useURL subscription or getInitialURL (which may return an old intent).
export function captureEmailLink(url: string | null): boolean {
  const parsed = parseEmailLink(url);
  if (!parsed) return false;
  receivedLink = parsed;
  for (const listener of linkListeners) listener();
  return true;
}
export function getReceivedEmailLink() { return receivedLink; }
export function subscribeEmailLinks(listener: () => void) {
  linkListeners.add(listener);
  return () => { linkListeners.delete(listener); };
}
export function clearReceivedEmailLink(token: string) {
  if (receivedLink?.token !== token) return;
  receivedLink = null;
  for (const listener of linkListeners) listener();
}

async function load(): Promise<PendingMap> {
  const raw = await SecureStore.getItemAsync(KEY);
  return raw ? JSON.parse(raw) : {};
}

export async function requestEmailLink(args: {
  email?: string; fullName?: string; inviteToken?: string; createFamily?: boolean;
}): Promise<void> {
  const Crypto = await import('expo-crypto');
  const bytes = await Crypto.getRandomBytesAsync(32);
  const verifier = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  const challenge = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier);
  const pending = await load();
  const now = Date.now();
  // At most six requests (~1.1KB) so Android SecureStore stays below its limit.
  const entries = Object.entries(pending).filter(([, v]) => now - v.at < LIFETIME).slice(-5);
  await SecureStore.setItemAsync(KEY, JSON.stringify({
    ...Object.fromEntries(entries), [challenge]: { verifier, at: now },
  }));
  await api.post('/auth/email-link/request', {
    email: args.email?.trim().toLowerCase() || undefined,
    full_name: args.fullName?.trim() || '',
    invite_token: args.inviteToken || undefined,
    create_family: !!args.createFamily,
    challenge,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  });
}

export async function redeemEmailLink(token: string, state: string, profile?: { fullName: string; createFamily: boolean }) {
  const pending = await load();
  const item = pending[state];
  if (!HEX.test(token) || !item || Date.now() - item.at > LIFETIME) {
    throw new Error('Open the email on the phone where you requested it. If you reinstalled Kinnship, request a new email link.');
  }
  const res = await api.post('/auth/email-link/verify', {
    token, verifier: item.verifier,
    full_name: profile?.fullName || '', create_family: !!profile?.createFamily,
  });
  // Keep the proof until the session has actually been saved. A new request
  // remains a safe recovery if the response was lost after server consumption.
  return res.data;
}

export function emailLinkError(error: any): string {
  const detail = error?.response?.data?.detail;
  return typeof detail === 'string' ? detail : error?.message || 'Could not connect. Check your connection and try again.';
}
