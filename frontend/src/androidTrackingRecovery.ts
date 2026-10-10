import AsyncStorage from '@react-native-async-storage/async-storage';
import { readPermissionSnapshot } from './permissionCoordinator';
import { BACKGROUND_LOCATION_DISCLOSURE_TEXT } from './backgroundLocationDisclosure';

export const BACKGROUND_PERMISSION_RATIONALE = {
  title: 'Location sharing in the background',
  message: BACKGROUND_LOCATION_DISCLOSURE_TEXT,
  positiveAction: 'Change to {backgroundPermissionOptionLabel}',
  negativeAction: 'Not now',
};

export const TRACKING_INTENT_KEY = 'kc_android_tracking_intent_v1';
const ATTEMPT_KEY = 'kc_android_tracking_recovery_attempt_v1';
const COOLDOWN_MS = 5 * 60_000;
let epoch = 0;
let writes: Promise<unknown> = Promise.resolve();
const policyListeners = new Set<() => void>();
export function subscribeToTrackingPolicy(listener: () => void): () => void {
  policyListeners.add(listener);
  return () => { policyListeners.delete(listener); };
}
export function notifyTrackingPolicyChanged(): void {
  for (const listener of [...policyListeners]) listener();
}
export type AuthorizedBatteryTransport = {
  memberId: string; baseUrl: string; token: string;
  isCurrent: () => Promise<boolean>;
};
let verifiedOwner: {
  token: string; nonce?: string; memberId: string; ownerUserId: string;
  sharing: boolean; at: number;
} | null = null;

type Intent = {
  version: 1;
  ownerUserId: string;
  memberId: string;
  backendBaseUrl: string;
  nonce: string;
};
export type RecoverySdk = {
  getState: () => Promise<{
    enabled?: boolean; url?: string; authorization?: { accessToken?: string };
  }>;
  setConfig: (config: Record<string, unknown>) => Promise<unknown>;
  start: () => Promise<{ enabled?: boolean }>;
  stop: () => Promise<unknown>;
};

export function trackingIntentEpoch(): number { return epoch; }

function write(operation: () => Promise<void>): Promise<void> {
  const result = writes.then(operation);
  writes = result.catch(() => {});
  return result;
}

/** Revoke synchronously in this runtime, and durably before a later wake. */
export function revokeTrackingIntent(): Promise<void> {
  epoch += 1;
  verifiedOwner = null;
  return write(() => AsyncStorage.removeItem(TRACKING_INTENT_KEY));
}

/** Only successful, owned, background-ready foreground startup grants intent. */
export function authorizeTrackingIntent(
  config: { ownerUserId?: string; memberId: string; backendBaseUrl: string },
  expectedEpoch: number,
  isCurrent: () => boolean,
): Promise<void> {
  return write(async () => {
    if (!config.ownerUserId || epoch !== expectedEpoch || !isCurrent()) return;
    const intent: Intent = {
      version: 1, ownerUserId: config.ownerUserId, memberId: config.memberId,
      backendBaseUrl: config.backendBaseUrl.replace(/\/+$/, ''),
      nonce: `${Date.now()}-${Math.random()}`,
    };
    await AsyncStorage.setItem(TRACKING_INTENT_KEY, JSON.stringify(intent));
  });
}

async function readIntent(): Promise<Intent | null> {
  const raw = await AsyncStorage.getItem(TRACKING_INTENT_KEY);
  if (!raw) return null;
  const value = JSON.parse(raw);
  return value?.version === 1 && typeof value.ownerUserId === 'string' && value.ownerUserId
    && typeof value.memberId === 'string' && value.memberId
    && typeof value.backendBaseUrl === 'string' && typeof value.nonce === 'string'
    ? value : null;
}

async function authenticatedGet(url: string, token: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
    });
    if (!response.ok) throw new Error(`ownership_http_${response.status}`);
    return await response.json();
  } finally { clearTimeout(timeout); }
}

/**
 * Caller holds the same native lifecycle queue as foreground start/stop.
 * One attempt per wake, no listener registration, no timers that repeat.
 * Never authorize from the SDK's retained JWT: sign-out may have left it there.
 */
export async function recoverUnexpectedlyDisabledTracking(
  sdk: RecoverySdk,
  isCurrent: () => boolean,
  onAuthorizedBattery?: (transport: AuthorizedBatteryTransport) => void,
): Promise<string> {
  let expectedEpoch = epoch;
  const intent = await readIntent();
  const base = (process.env.EXPO_PUBLIC_BACKEND_URL || '').replace(/\/+$/, '');
  if (!isCurrent()) return 'obsolete_owner';
  if (!base || (intent && intent.backendBaseUrl !== base) || !base.startsWith('https://')) {
    return 'invalid_backend';
  }
  const sdkState = await sdk.getState();
  const prefix = `${base}/api/members/`;
  const nativeMember = sdkState.url?.startsWith(prefix) && sdkState.url.endsWith('/location')
    ? sdkState.url.slice(prefix.length, -'/location'.length) : null;
  const memberId = intent?.memberId ?? nativeMember;
  if (!memberId || memberId.includes('/')) return 'invalid_member';
  // Lazy import avoids the API/engine cycle during cold entry evaluation.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getCurrentToken } = require('./api') as typeof import('./api');
  const token = await getCurrentToken();
  if (!token) {
    if (sdkState.enabled === true) await sdk.stop();
    return 'no_session';
  }
  let expectedNonce = intent?.nonce;
  const current = async () => {
    if (epoch !== expectedEpoch || !isCurrent()) return false;
    const nonce = (await readIntent())?.nonce;
    const currentToken = await getCurrentToken();
    // Revocation can occur during either storage await; the entry check alone
    // does not protect a late stale read from authorizing native work.
    return epoch === expectedEpoch && isCurrent()
      && nonce === expectedNonce && currentToken === token;
  };
  if (!await current()) return 'obsolete_owner';
  const lastAttempt = Number(await AsyncStorage.getItem(ATTEMPT_KEY));
  const now = Date.now();
  const needsStart = sdkState.enabled !== true;
  if (intent && needsStart && lastAttempt > 0 && lastAttempt <= now && now - lastAttempt < COOLDOWN_MS) {
    const cache = verifiedOwner;
    if (cache && cache.token === token && cache.nonce === expectedNonce
      && cache.memberId === memberId && now >= cache.at && now - cache.at < 60_000) {
      onAuthorizedBattery?.({ baseUrl: base, memberId, token, isCurrent: current });
    }
    return 'cooldown';
  }
  // Enabled transport can reuse a one-minute proof, never an unverified owner.
  // Disabled-engine restart ALWAYS revalidates with the server.
  const cache = verifiedOwner;
  if (!sdkState.enabled || !cache || cache.token !== token || cache.nonce !== expectedNonce
    || cache.memberId !== memberId || Date.now() < cache.at || Date.now() - cache.at >= 60_000) {
    let responses: unknown[];
    try {
      responses = await Promise.all([
        authenticatedGet(`${base}/api/auth/me`, token),
        authenticatedGet(`${base}/api/members`, token),
        authenticatedGet(`${base}/api/me/preferences`, token),
      ]);
    } catch (error) {
      if (/ownership_http_(401|403)/.test(String(error)) && await current()) {
        await revokeTrackingIntent();
        await sdk.stop();
      }
      throw error;
    }
    const [user, members, preferences] = responses as [
      { id?: string }, { id: string; user_id: string }[], { location_sharing_enabled?: boolean },
    ];
    if (!await current()) return 'obsolete_owner';
    if (!user?.id || (intent && user.id !== intent.ownerUserId) || !Array.isArray(members)
      || !members.some(member => member.id === memberId && member.user_id === user.id)) {
      await revokeTrackingIntent();
      await sdk.stop();
      return 'invalid_owner';
    }
    verifiedOwner = {
      token, nonce: expectedNonce, memberId, ownerUserId: user.id,
      sharing: preferences?.location_sharing_enabled === true, at: Date.now(),
    };
  }
  if (!await current()) return 'obsolete_owner';
  const permissions = await readPermissionSnapshot();
  const sharingOff = !verifiedOwner?.sharing
    || await AsyncStorage.getItem('@kinnship/location_sharing_off_v1') === '1';
  const permissionDenied = permissions.foreground !== 'granted' || permissions.background !== 'granted';
  if (sharingOff || permissionDenied) {
    await revokeTrackingIntent();
    expectedEpoch = epoch;
    expectedNonce = undefined;
    await sdk.stop();
    // Battery contact is not GPS consent. Still require the verified app session.
    if (await current()) onAuthorizedBattery?.({ baseUrl: base, memberId, token, isCurrent: current });
    return sharingOff ? 'sharing_disabled' : 'permission_denied';
  }
  if (await current()) onAuthorizedBattery?.({ baseUrl: base, memberId, token, isCurrent: current });
  if (!intent) return 'no_current_intent';
  const locationUrl = `${base}/api/members/${encodeURIComponent(memberId)}/location`;
  if (sdkState.enabled === true && sdkState.url === locationUrl
    && sdkState.authorization?.accessToken === token) return 'already_enabled';
  if (!await current()) return 'obsolete_owner';
  if (needsStart) await AsyncStorage.setItem(ATTEMPT_KEY, String(now));
  await sdk.setConfig({
    url: locationUrl,
    authorization: { strategy: 'JWT', accessToken: token },
    backgroundPermissionRationale: BACKGROUND_PERMISSION_RATIONALE,
    locationAuthorizationRequest: 'Always',
    disableLocationAuthorizationAlert: true,
  });
  const latestPermissions = await readPermissionSnapshot();
  if (!await current()) return 'obsolete_owner';
  if (latestPermissions.foreground !== 'granted' || latestPermissions.background !== 'granted'
    || await AsyncStorage.getItem('@kinnship/location_sharing_off_v1') === '1') {
    await revokeTrackingIntent();
    await sdk.stop();
    return 'permission_denied';
  }
  const state = needsStart ? await sdk.start() : await sdk.getState();
  const finalPermissions = await readPermissionSnapshot();
  if (!await current() || finalPermissions.foreground !== 'granted'
    || finalPermissions.background !== 'granted'
    || await AsyncStorage.getItem('@kinnship/location_sharing_off_v1') === '1') {
    await sdk.stop();
    if (await current()) await revokeTrackingIntent();
    return 'late_start_stopped';
  }
  return state.enabled === true ? needsStart ? 'restarted' : 'already_enabled' : 'start_not_enabled';
}
