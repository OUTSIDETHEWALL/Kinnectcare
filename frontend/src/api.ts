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

/**
 * Public accessor for the current JWT.  Added in Phase 2 of the
 * Transistor location-engine migration: the engine wrapper needs to
 * read the token at start-up to seed the SDK's native HTTP transport,
 * and the RootNav layout effect is the canonical caller.  Kept as an
 * async wrapper around the internal getToken() so the on-disk path
 * stays a single source of truth.
 */
export async function getCurrentToken(): Promise<string | null> {
  return getToken();
}

// ============================================================
//  Token-change subscriber registry (v1.4 / Phase 2)
// ============================================================
//
// The Transistor background-location engine ships JWTs in the SDK's
// native HTTP transport via the `authorization` config.  Whenever
// THIS app refreshes the JWT — either explicitly (verifyOtp) or
// silently (rolling X-Refresh-Token header on any authenticated
// response) — every saveToken() call must propagate the new value
// to the engine via setAuthToken().
//
// A pub/sub here is the cleanest plumbing because:
//   * api.ts is the chokepoint for token mutations (saveToken,
//     clearToken).
//   * The engine wrapper (locationEngine.ts) can't depend on api.ts
//     without creating a circular import; the layout is the wiring
//     layer.
//   * Multiple subscribers may want token events in the future
//     (push token re-registration, websocket reconnects, etc.).
type TokenListener = (token: string | null) => void;
const tokenListeners = new Set<TokenListener>();

export function subscribeToTokenChanges(listener: TokenListener): () => void {
  tokenListeners.add(listener);
  return () => {
    tokenListeners.delete(listener);
  };
}

function notifyTokenChange(token: string | null): void {
  // Snapshot to a list so listeners that unsubscribe themselves
  // during the notification don't break the iteration.
  const snap = Array.from(tokenListeners);
  for (const l of snap) {
    try {
      l(token);
    } catch (_e) {
      // Subscribers must never crash the auth flow.
    }
  }
}

export async function saveToken(token: string) {
  if (Platform.OS === 'web') await AsyncStorage.setItem(TOKEN_KEY, token);
  else await SecureStore.setItemAsync(TOKEN_KEY, token);
  notifyTokenChange(token);
}

export async function clearToken() {
  if (Platform.OS === 'web') await AsyncStorage.removeItem(TOKEN_KEY);
  else await SecureStore.deleteItemAsync(TOKEN_KEY);
  notifyTokenChange(null);
}

export const api = axios.create({
  baseURL: `${BASE}/api`,
  // 45s — generous on purpose. The OTP backend now returns in ~250ms
  // (SMTP is fire-and-forget in BackgroundTasks), but we leave a wide
  // margin to absorb mobile carrier latency spikes that previously
  // surfaced as the "Could not send code" alert.
  timeout: 45000,
});

api.interceptors.request.use(async (config) => {
  const token = await getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// ----- ROBUST AUTH-ENDPOINT RETRY (v6.11.4) -----
//
// Why this exists, in plain English:
//   For a week we kept hitting intermittent "Could not send code"
//   alerts. The root causes turned out to be:
//     1. The backend ran with uvicorn `--reload` enabled, so every
//        code edit triggered a 2-5s restart window where requests
//        got connection-refused. (Fixed in supervisor config now.)
//     2. SMTP was awaited inside the request handler, so Gmail
//        latency spikes blew past axios's 20s timeout. (Fixed by
//        moving SMTP to FastAPI BackgroundTasks.)
//     3. Carrier-side TCP blips that nobody can fix from a server.
//
//   This retry helper neutralizes case #3 (and provides belt-and-
//   suspenders coverage for any future #1/#2-style regressions).
//
// Policy:
//   • Only retries the explicitly listed auth endpoints (OTP send /
//     verify). NEVER retries on a 4xx — the user typed the wrong
//     code, no point hammering the server.
//   • Retries on: 0/no-response, 5xx, ECONNABORTED (timeout), or
//     network errors. Up to 3 attempts total with 600ms / 1500ms
//     backoff.
//   • Returns the eventual success response, OR the LAST error
//     unchanged (so existing error-handling code is unaffected).
const RETRY_PATHS = [
  '/auth/request-otp',
  '/auth/resend-otp',
  '/auth/verify-otp',
];

const RETRY_BACKOFFS_MS = [600, 1500]; // 2 retries → 3 total attempts

function _shouldRetry(error: any): boolean {
  if (!error) return false;
  const status = error?.response?.status;
  // 404 special-case: on the explicitly-allowlisted auth paths we KNOW
  // the endpoint exists on the backend (we've shipped a build that
  // depends on it). A 404 there is almost always the Kubernetes
  // ingress responding while the upstream backend pod is briefly
  // unreachable (during a restart, container swap, or proxy refresh).
  // Treat it like a transient outage — retry. Worst case: we retry
  // against a still-down backend and still surface the error after
  // the backoff window.
  //
  // We DO still skip retry on 4xx for /verify-otp (wrong code is a
  // genuine 400, the user shouldn't keep hammering). Only 5xx /
  // network / timeout / 404 trigger retries elsewhere.
  if (status === 404) return true;
  if (status && status >= 400 && status < 500) return false; // other 4xx = don't retry
  // No response (network failure), timeout, or 5xx → retry
  return true;
}

api.interceptors.response.use(
  async (res) => {
    try {
      // Rolling-refresh hook — see comment block on the backend
      // /auth/me endpoint for the full backstory.
      const headerTok =
        res.headers?.['x-refresh-token'] ||
        (res.headers as any)?.['X-Refresh-Token'];
      const bodyTok =
        (res.data && typeof res.data === 'object' && (res.data as any).refreshed_token) ||
        null;
      const fresh = headerTok || bodyTok;
      if (fresh && typeof fresh === 'string' && fresh.length > 20) {
        await saveToken(fresh);
      }
    } catch (_e) {}
    return res;
  },
  async (error) => {
    const cfg = error?.config;
    if (!cfg) return Promise.reject(error);
    const url = String(cfg.url || '');
    const onRetryPath = RETRY_PATHS.some((p) => url.includes(p));
    if (!onRetryPath) return Promise.reject(error);

    cfg.__retryCount = cfg.__retryCount || 0;
    if (cfg.__retryCount >= RETRY_BACKOFFS_MS.length) {
      return Promise.reject(error);
    }
    if (!_shouldRetry(error)) {
      return Promise.reject(error);
    }

    const delay = RETRY_BACKOFFS_MS[cfg.__retryCount];
    cfg.__retryCount += 1;
    await new Promise((r) => setTimeout(r, delay));
    return api.request(cfg);
  },
);

export type User = {
  id: string;
  email: string;
  full_name: string;
  timezone?: string;
  family_group_id?: string | null;
  family_group_role?: 'owner' | 'member' | null;
};

export type Member = {
  id: string;
  user_id?: string | null;
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
  checkin_interval_hours?: number | null;
  checkin_interval_started_at?: string | null;
  emergency_contact_phone?: string | null;
  emergency_contact_name?: string | null;
  // Build #56/57 — Privacy: mirrored from the user's location_sharing
  // preference so family clients render a "🔒 Location sharing off"
  // state directly from the /members payload.  Defaults true on legacy
  // docs that never had the field (server-side).
  location_sharing_enabled?: boolean;
  // Build 64 — SDK movement state from the Transistor upload payload.
  // True when the SDK was in MOVING mode at last upload time.
  // Drives movement-aware freshness thresholds in TrackingStatusPill.
  // Null for member rows created before this field was introduced.
  is_moving?: boolean | null;
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
  // Build 50 — Explicit resolve fields for SOS incident-screen workflow.
  resolved?: boolean;
  resolved_at?: string | null;
  resolved_by_user_id?: string | null;
  resolved_by_name?: string | null;
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
  // Refill tracking (medication only)
  days_supply?: number | null;
  refill_reminder_days?: number | null;
  last_refill_at?: string | null;
  run_out_at?: string | null;
};

export type CheckIn = {
  id: string;
  owner_id: string;
  family_group_id?: string | null;
  member_id: string;
  member_name: string;
  location_name?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  confirmed_by?: string | null;
  source?: string | null;
  created_at: string;
};

export type CheckinRequest = {
  id: string;
  family_group_id: string;
  requester_id: string;
  requester_name: string;
  member_id: string;
  member_name: string;
  status: 'pending' | 'responded' | 'need_help';
  created_at: string;
  responded_at?: string | null;
};

export async function sendCheckinRequest(memberId: string): Promise<{ ok: boolean; request_id: string }> {
  const r = await api.post(`/checkin-requests/${memberId}`);
  return r.data;
}

export async function respondToCheckinRequest(
  requestId: string,
  payload: { member_id: string; latitude?: number; longitude?: number; location_name?: string }
): Promise<CheckIn> {
  const r = await api.post(`/checkin-requests/${requestId}/respond`, payload);
  return r.data;
}

export async function listCheckinRequestsForMember(memberId: string): Promise<CheckinRequest[]> {
  const r = await api.get(`/checkin-requests/member/${memberId}`);
  return r.data;
}

export async function listCheckinsForMember(memberId: string): Promise<CheckIn[]> {
  const r = await api.get(`/checkins/member/${memberId}`);
  return r.data;
}

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
  emergency_contact_phone?: string | null;
  weekly_compliance_percent?: number | null;
  weekly_logged?: number;
};

export type PaidPlan = {
  interval: 'month' | 'year';
  label: string;
  amount_cents: number;
  currency: string;
  product_name: string;
  is_recommended: boolean;
  savings_cents: number;
};

export type BillingStatus = {
  plan: 'free' | 'family_plan';
  plan_label?: string | null;
  status?: string | null;
  interval?: 'month' | 'year' | null;
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
  paid_plans: PaidPlan[];
  annual_savings_cents: number;
};

export async function getBillingStatus(): Promise<BillingStatus> {
  const r = await api.get('/billing/status');
  return r.data;
}

export async function cancelSubscription(): Promise<{
  cancelled: boolean;
  immediate?: boolean;
  current_period_end?: string | null;
  billing_status: BillingStatus;
}> {
  const r = await api.post('/billing/cancel');
  return r.data;
}

export async function resumeSubscription(): Promise<{
  resumed: boolean;
  billing_status: BillingStatus;
}> {
  const r = await api.post('/billing/resume');
  return r.data;
}

export async function createCheckoutSession(
  returnUrl?: string,
  interval: 'month' | 'year' = 'month',
): Promise<{
  checkout_url: string;
  session_id: string;
  interval: 'month' | 'year';
  publishable_key: string | null;
}> {
  const successUrl = returnUrl ? `${returnUrl}?status=success` : undefined;
  const cancelUrl = returnUrl ? `${returnUrl}?status=cancel` : undefined;
  const r = await api.post('/billing/checkout-session', {
    success_url: successUrl,
    cancel_url: cancelUrl,
    interval,
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

// ========== Family Group ==========
export type FamilyGroup = {
  id: string;
  name: string;
  owner_user_id: string;
  invite_code: string;
  created_at?: string;
};

export type FamilyGroupMember = {
  user_id: string;
  full_name: string;
  email: string;
  role: 'owner' | 'member';
  joined_at?: string;
};

export type FamilyGroupResponse = {
  group: FamilyGroup;
  members: FamilyGroupMember[];
  my_role: 'owner' | 'member';
  member_count: number;
};

export async function getFamilyGroup(): Promise<FamilyGroupResponse> {
  const r = await api.get('/family-group');
  return r.data;
}

export async function renameFamilyGroup(name: string): Promise<{ ok: boolean; group: FamilyGroup }> {
  const r = await api.put('/family-group', { name });
  return r.data;
}

export async function regenerateInviteCode(): Promise<{ ok: boolean; invite_code: string; group: FamilyGroup }> {
  const r = await api.post('/family-group/regenerate-code');
  return r.data;
}

export async function joinFamilyGroup(invite_code: string): Promise<{ ok: boolean; group: FamilyGroup; already_member?: boolean }> {
  const r = await api.post('/family-group/join', { invite_code });
  return r.data;
}

export async function leaveFamilyGroup(): Promise<{ ok: boolean; new_group: FamilyGroup }> {
  const r = await api.post('/family-group/leave');
  return r.data;
}

export async function removeFamilyMember(user_id: string): Promise<{ ok: boolean; removed_user_id: string }> {
  const r = await api.post('/family-group/remove-member', { user_id });
  return r.data;
}

// ---------- Email invitations (per-recipient INV-XXXXXX tokens) ----------

export type FamilyInvite = {
  id: string;
  token: string;
  invitee_name: string;
  invitee_email: string;
  inviter_name: string;
  relationship?: string | null;
  role?: 'senior' | 'family' | null;
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
  created_at?: string;
  expires_at?: string;
  accepted_at?: string | null;
  accepted_by_user_id?: string | null;
};

export async function sendFamilyInvite(payload: {
  name: string;
  email: string;
  relationship?: string;
  role?: 'senior' | 'family';
}): Promise<{ ok: boolean; delivered: boolean; invite: FamilyInvite }> {
  const r = await api.post('/family-group/invite', payload);
  return r.data;
}

export async function listFamilyInvites(): Promise<{ invites: FamilyInvite[]; count: number }> {
  const r = await api.get('/family-group/invites');
  return r.data;
}

export async function revokeFamilyInvite(id: string): Promise<{ ok: boolean; status: string }> {
  const r = await api.delete(`/family-group/invites/${id}`);
  return r.data;
}
