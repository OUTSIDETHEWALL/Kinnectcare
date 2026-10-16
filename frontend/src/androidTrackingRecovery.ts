import AsyncStorage from '@react-native-async-storage/async-storage';
import { readPermissionSnapshot } from './permissionCoordinator';
import { BACKGROUND_LOCATION_DISCLOSURE_TEXT } from './backgroundLocationDisclosure';
import {
  authorizeNativeTracking, readTrackingAuthority, revokeNativeTracking, recordTrackingEvidence,
  completeNativeTrackingShutdown, observeAcceptedTrackingLocation, withConfirmedTrackingShutdown,
  withExpectedTrackingRevocation, rearmNativeTrackingConsent,
} from './trackingReliability';
import type { TrackingAuthority } from './trackingReliability';

export type AuthorizationVerdict = {
  state: 'AUTHORIZED' | 'UNKNOWN' | 'REVOKED';
  source: string;
  reason?: RevocationReason;
};

export async function evaluateWakeAuthorization(isCurrent: () => boolean): Promise<AuthorizationVerdict> {
  try {
    if (await trackingIsRevoked()) return { state: 'REVOKED', source: 'durable_revocation', reason: 'stopped' };
    const permission = await readPermissionSnapshot({ includeNotifications: false });
    if (permission.foreground === 'denied' || permission.background === 'denied') {
      return { state: 'REVOKED', source: 'os_permission', reason: 'permission' };
    }
    if (permission.foreground !== 'granted' || permission.background !== 'granted') {
      return { state: 'UNKNOWN', source: 'permission_unverified' };
    }
    const result = await verifyWakeOwnership(isCurrent);
    if (result === 'allowed') return { state: 'AUTHORIZED', source: 'authenticated_owner' };
    if (result === 'invalid_owner' || result === 'sharing_disabled' || result === 'session_rejected') {
      return { state: 'REVOKED', source: result,
        reason: result === 'sharing_disabled' ? 'consent' : result === 'session_rejected' ? 'signout' : 'stopped' };
    }
    return { state: 'UNKNOWN', source: result };
  } catch {
    return { state: 'UNKNOWN', source: 'lookup_failed' };
  }
}

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
  sharing: boolean; at: number; consentGeneration: number;
} | null = null;
let verifiedConsent: { owner: string; generation: number } | null = null;
export function getVerifiedConsentGeneration(owner: string): number | null {
  return verifiedConsent?.owner === owner ? verifiedConsent.generation : null;
}
export type RevocationReason = 'stopped' | 'signout' | 'consent' | 'permission';
type Binding = { ownerUserId: string; memberId: string; backendBaseUrl: string };
type RevokedIntent = {
  version: 1; revoked: true; reason: RevocationReason; nonce: string; binding?: Binding;
};

type Intent = {
  version: 1;
  ownerUserId: string;
  memberId: string;
  backendBaseUrl: string;
  nonce: string;
};
export type RecoverySdk = {
  getState: () => Promise<{
    extras?: Record<string, unknown>;
    enabled?: boolean; url?: string; authorization?: { accessToken?: string };
    stopOnTerminate?: boolean; startOnBoot?: boolean; enableHeadless?: boolean;
  }>;
  setConfig: (config: Record<string, unknown>) => Promise<unknown>;
  start: () => Promise<{ enabled?: boolean }>;
  stop: () => Promise<unknown>;
  destroyLocations?: () => Promise<unknown>;
};

function shutdownConfirmedRevocation(
  sdk: RecoverySdk, caller: string, expected?: TrackingAuthority | null,
): Promise<unknown> {
  const authority = expected ?? readTrackingAuthority();
  if (authority && !authority.revoked) return Promise.resolve();
  recordTrackingEvidence('stop_requested', { caller, authorization: 'REVOKED',
    generation: authority?.generation, reason: 'confirmed_revocation' });
  return withConfirmedTrackingShutdown(async () => {
    await sdk.stop();
    if (sdk.destroyLocations) await sdk.destroyLocations();
    if (authority) completeNativeTrackingShutdown(authority.generation);
  }, authority ?? undefined);
}

export function trackingIntentEpoch(): number { return readTrackingAuthority()?.generation ?? epoch; }

function write(operation: () => Promise<void>): Promise<void> {
  const result = writes.then(operation);
  writes = result.catch(() => {});
  return result;
}

/** Revoke synchronously in this runtime, and durably before a later wake. */
export function revokeTrackingIntent(reason: RevocationReason = 'stopped', binding?: Binding): Promise<void> {
  epoch += 1;
  verifiedOwner = null;
  // Synchronous native invalidation is independent of async storage/FIFO.
  revokeNativeTracking(reason);
  recordTrackingEvidence('authorization', { authorization: 'REVOKED', reason });
  return write(async () => {
    const raw = await AsyncStorage.getItem(TRACKING_INTENT_KEY);
    let previous: Intent | RevokedIntent | null = null;
    try { previous = raw ? JSON.parse(raw) : null; } catch { /* replace corruption with revocation */ }
    const priorBinding = previous && 'revoked' in previous ? previous.binding
      : previous?.ownerUserId ? previous : undefined;
    const revoked: RevokedIntent = {
      version: 1, revoked: true,
      reason: previous && 'revoked' in previous && previous.reason === 'consent' ? 'consent' : reason,
      nonce: `${Date.now()}-${Math.random()}`, binding: binding ?? priorBinding,
    };
    await AsyncStorage.setItem(TRACKING_INTENT_KEY, JSON.stringify(revoked));
  });
}

/** Async evidence can revoke only the authority that requested it. */
export function revokeTrackingIntentIfCurrent(
  expected: TrackingAuthority, reason: RevocationReason, shutdown: () => Promise<unknown>,
): Promise<boolean> {
  return withExpectedTrackingRevocation(expected, reason, async () => {
    epoch += 1;
    verifiedOwner = null;
    recordTrackingEvidence('authorization', { authorization: 'REVOKED', reason,
      generation: expected.generation, owner: expected.owner });
    await shutdown();
  });
}

export async function trackingPolicyStamp(): Promise<string | null> {
  return AsyncStorage.getItem(TRACKING_INTENT_KEY);
}

export async function trackingIsRevoked(consentOnly = false): Promise<boolean> {
  const raw = await trackingPolicyStamp();
  if (revokedStamp(raw, consentOnly)) return true;
  const authority = readTrackingAuthority();
  if (authority?.revoked && authority.generation > 0
    && (!consentOnly || authority.reason === 'consent')) return true;
  // Pre-intent installations already have a durable sharing withdrawal flag.
  return await AsyncStorage.getItem('@kinnship/location_sharing_off_v1') === '1';
}

function revokedStamp(raw: string | null, consentOnly = false): boolean {
  if (!raw) return false; // Pre-migration absence is NOT deliberate revocation.
  try {
    const value = JSON.parse(raw);
    return consentOnly ? value?.revoked === true && value.reason === 'consent'
      : value?.revoked === true;
  } catch { return false; }
}

/** Only explicit opt-in may remove a sticky consent revocation. */
export function rearmTrackingConsent(): Promise<void> {
  verifiedOwner = null;
  const authority = readTrackingAuthority();
  if (authority) rearmNativeTrackingConsent(authority.generation);
  return write(async () => {
    const raw = await trackingPolicyStamp();
    const value = raw ? JSON.parse(raw) : null;
    if (value?.revoked === true && value.reason === 'consent') {
      await AsyncStorage.setItem(TRACKING_INTENT_KEY, JSON.stringify({ ...value, reason: 'stopped' }));
    }
  });
}

/** Affirmative owner, consent and OS proof grants intent before native mutation. */
export function authorizeTrackingIntent(
  config: { ownerUserId?: string; memberId: string; backendBaseUrl: string },
  expectedEpoch: number,
  isCurrent: () => boolean,
): Promise<void> {
  const nativeGeneration = readTrackingAuthority()?.generation ?? 0;
  return write(async () => {
    if (!config.ownerUserId || trackingIntentEpoch() !== expectedEpoch || !isCurrent()) return;
    if (await trackingIsRevoked(true) || trackingIntentEpoch() !== expectedEpoch || !isCurrent()) return;
    const existing = await readIntent();
    const intent: Intent = {
      version: 1, ownerUserId: config.ownerUserId, memberId: config.memberId,
      backendBaseUrl: config.backendBaseUrl.replace(/\/+$/, ''),
      nonce: existing?.ownerUserId === config.ownerUserId && existing.memberId === config.memberId
        ? existing.nonce : `${Date.now()}-${Math.random()}`,
    };
    const authority = authorizeNativeTracking(`${config.ownerUserId}:${config.memberId}`, nativeGeneration);
    if (authority && (authority.revoked || authority.owner !== `${config.ownerUserId}:${config.memberId}`)) {
      throw new Error('tracking_owner_replacement_requires_revocation');
    }
    await AsyncStorage.setItem(TRACKING_INTENT_KEY, JSON.stringify(intent));
  });
}

async function readIntent(): Promise<Intent | null> {
  const raw = await AsyncStorage.getItem(TRACKING_INTENT_KEY);
  return parseIntent(raw);
}

function parseIntent(raw: string | null): Intent | null {
  if (!raw) return null;
  let value: any;
  try { value = JSON.parse(raw); } catch { return null; }
  return value?.revoked !== true && value?.version === 1 && typeof value.ownerUserId === 'string' && value.ownerUserId
    && typeof value.memberId === 'string' && value.memberId
    && typeof value.backendBaseUrl === 'string' && typeof value.nonce === 'string'
    ? value : null;
}

/** GPS revocation does not revoke an otherwise valid owner's battery contact. */
export async function authorizeRevokedBatteryTransport(
  isCurrent: () => boolean,
): Promise<AuthorizedBatteryTransport | null> {
  const stamp = await trackingPolicyStamp();
  const value = stamp ? JSON.parse(stamp) : null;
  const nativeRevoked = readTrackingAuthority()?.revoked === true;
  const binding: Binding | undefined = value?.revoked === true ? value.binding
    : nativeRevoked && value?.ownerUserId ? value : undefined;
  const base = (process.env.EXPO_PUBLIC_BACKEND_URL || '').replace(/\/+$/, '');
  if ((value?.revoked !== true && !nativeRevoked) || (binding && binding.backendBaseUrl !== base)
    || !base.startsWith('https://')) return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getCurrentToken } = require('./api') as typeof import('./api');
  const expectedEpoch = trackingIntentEpoch();
  const token = await getCurrentToken();
  if (!token || !isCurrent()) return null;
  const current = async () => {
    const policy = await trackingPolicyStamp();
    const currentToken = await getCurrentToken();
    return trackingIntentEpoch() === expectedEpoch && isCurrent() && policy === stamp && currentToken === token;
  };
  const [user, members] = await Promise.all([
    authenticatedGet(`${base}/api/auth/me`, token),
    authenticatedGet(`${base}/api/members`, token),
  ]) as [{ id?: string }, { id: string; user_id: string }[]];
  if (!user?.id || !Array.isArray(members) || !await current()) return null;
  const owned = members.filter(member => member.user_id === user.id
    && (!binding || member.id === binding.memberId));
  if (owned.length !== 1 || (binding && user.id !== binding.ownerUserId)) return null;
  return { baseUrl: base, memberId: owned[0].id, token, isCurrent: current };
}

/**
 * Read-only authorization BEFORE the lifecycle FIFO: confirmed removal or
 * remote consent withdrawal must interrupt even a never-returning native call.
 * Network failure is not evidence of removal. No SDK-retained token is used.
 */
export async function verifyWakeOwnership(isCurrent: () => boolean): Promise<string> {
  const expectedEpoch = trackingIntentEpoch();
  const stamp = await trackingPolicyStamp();
  const intent = await readIntent();
  const base = (process.env.EXPO_PUBLIC_BACKEND_URL || '').replace(/\/+$/, '');
  if (!base.startsWith('https://') || (intent && intent.backendBaseUrl !== base)) return 'invalid_backend';
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getCurrentToken } = require('./api') as typeof import('./api');
  const token = await getCurrentToken();
  if (!isCurrent() || trackingIntentEpoch() !== expectedEpoch) return 'obsolete_owner';
  if (!token) return 'no_session';
  let user: { id?: string }, members: { id: string; user_id: string; location_consent_generation?: number }[], preferences: { location_sharing_enabled?: boolean };
  try {
    [user, members, preferences] = await Promise.all([
      authenticatedGet(`${base}/api/auth/me`, token),
      authenticatedGet(`${base}/api/members`, token),
      authenticatedGet(`${base}/api/me/preferences`, token),
    ]) as [typeof user, typeof members, typeof preferences];
  } catch (error) {
    if (!isCurrent() || trackingIntentEpoch() !== expectedEpoch || await getCurrentToken() !== token) return 'obsolete_owner';
    // Only /auth/me 401 confirms session invalidation. A member/preferences
    // 403 can be an endpoint policy failure, not evidence of sign-out.
    return String(error).includes('session_rejected') ? 'session_rejected' : 'ownership_unavailable';
  }
  const currentStamp = await trackingPolicyStamp();
  const currentToken = await getCurrentToken();
  if (!isCurrent() || trackingIntentEpoch() !== expectedEpoch || currentStamp !== stamp || currentToken !== token) return 'obsolete_owner';
  if (!user?.id || !Array.isArray(members)
    || members.some(member => !member || typeof member.id !== 'string'
      || (member.user_id != null && typeof member.user_id !== 'string'))) {
    return 'ownership_unavailable';
  }
  const owned = members.filter(member => member.user_id === user.id
    && (!intent || member.id === intent.memberId));
  if (owned.length > 1) return 'ownership_unavailable';
  if (owned.length !== 1 || (intent && user.id !== intent.ownerUserId)) return 'invalid_owner';
  if (preferences?.location_sharing_enabled === false
    || await AsyncStorage.getItem('@kinnship/location_sharing_off_v1') === '1') return 'sharing_disabled';
  if (preferences?.location_sharing_enabled !== true) return 'ownership_unavailable';
  // A native HTTP receipt has no original dispatch generation. Read the
  // accepted tuple only through this current-token/current-owner operation.
  if (!isCurrent() || trackingIntentEpoch() !== expectedEpoch) return 'obsolete_owner';
  verifiedConsent = { owner: `${user.id}:${owned[0].id}`, generation: owned[0].location_consent_generation ?? 0 };
  try {
    observeAcceptedTrackingLocation(owned[0], `${user.id}:${owned[0].id}`, expectedEpoch);
  } catch { /* unavailable evidence is not ownership withdrawal */ }
  return 'allowed';
}

async function authenticatedGet(url: string, token: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
    });
    if (!response.ok) throw new Error(
      url.endsWith('/api/auth/me') && response.status === 401 ? 'session_rejected' : `ownership_http_${response.status}`,
    );
    return await response.json();
  } finally { clearTimeout(timeout); }
}

/**
 * Absence is not consent. Migrate only an affirmative, matching legacy binding
 * plus disclosure/native background policy, freshly verified session/ownership/
 * sharing and OS permissions. Never use the SDK's retained JWT as authority.
 * Caller serializes with engine startup; this function never starts native work.
 */
export async function migrateLegacyTrackingIntent(
  sdk: Pick<RecoverySdk, 'getState'>, isCurrent: () => boolean,
): Promise<boolean> {
  const expectedEpoch = trackingIntentEpoch();
  if (await trackingPolicyStamp() !== null || !isCurrent()) return false;
  const base = (process.env.EXPO_PUBLIC_BACKEND_URL || '').replace(/\/+$/, '');
  if (!base.startsWith('https://')) return false;
  const [ownerId, memberId, bgMemberId, disclosure, sharingOff, state] = await Promise.all([
    AsyncStorage.getItem('kc_my_user_id_v1'),
    AsyncStorage.getItem('kc_my_member_id_v1'),
    AsyncStorage.getItem('@kinnship/bg_location_member_id_v1'),
    AsyncStorage.getItem('@kinnship/background_location_disclosure_shown_v1'),
    AsyncStorage.getItem('@kinnship/location_sharing_off_v1'),
    sdk.getState(),
  ]);
  // Transistor exclusivity removes the old Expo-task member key. Absence is
  // expected; a surviving conflicting binding is not.
  if (!ownerId || !memberId || (bgMemberId !== null && memberId !== bgMemberId) || disclosure !== 'true'
    || sharingOff === '1' || state.stopOnTerminate !== false
    || state.startOnBoot !== true || state.enableHeadless !== true
    || state.url !== `${base}/api/members/${encodeURIComponent(memberId)}/location`) return false;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getCurrentToken } = require('./api') as typeof import('./api');
  const token = await getCurrentToken();
  if (!token || !isCurrent() || trackingIntentEpoch() !== expectedEpoch) return false;
  const [user, members, preferences, permissions] = await Promise.all([
    authenticatedGet(`${base}/api/auth/me`, token),
    authenticatedGet(`${base}/api/members`, token),
    authenticatedGet(`${base}/api/me/preferences`, token),
    readPermissionSnapshot({ includeNotifications: false }),
  ]) as [{ id?: string }, { id: string; user_id: string }[],
    { location_sharing_enabled?: boolean }, { foreground: string; background: string }];
  if (user?.id !== ownerId || !Array.isArray(members)
    || members.filter(member => member.user_id === ownerId).length !== 1
    || !members.some(member => member.id === memberId && member.user_id === ownerId)
    || preferences?.location_sharing_enabled !== true
    || permissions.foreground !== 'granted' || permissions.background !== 'granted') return false;
  let migrated = false;
  await write(async () => {
    const [stamp, latestToken, latestOwner, latestMember, latestBgMember, localOff] = await Promise.all([
      trackingPolicyStamp(), getCurrentToken(),
      AsyncStorage.getItem('kc_my_user_id_v1'), AsyncStorage.getItem('kc_my_member_id_v1'),
      AsyncStorage.getItem('@kinnship/bg_location_member_id_v1'),
      AsyncStorage.getItem('@kinnship/location_sharing_off_v1'),
    ]);
    if (trackingIntentEpoch() !== expectedEpoch || !isCurrent() || stamp !== null || latestToken !== token
      || latestOwner !== ownerId || latestMember !== memberId || latestBgMember !== bgMemberId
      || localOff === '1') return;
    const intent: Intent = {
      version: 1, ownerUserId: ownerId, memberId, backendBaseUrl: base,
      nonce: `${Date.now()}-${Math.random()}`,
    };
    await AsyncStorage.setItem(TRACKING_INTENT_KEY, JSON.stringify(intent));
    migrated = trackingIntentEpoch() === expectedEpoch && isCurrent();
  });
  return migrated;
}

/**
 * Caller holds the startup/reconfiguration FIFO; intentional stop bypasses it.
 * One attempt per wake, no listener registration, no timers that repeat.
 * Never authorize from the SDK's retained JWT: sign-out may have left it there.
 */
export async function recoverUnexpectedlyDisabledTracking(
  sdk: RecoverySdk,
  isCurrent: () => boolean,
  onAuthorizedBattery?: (transport: AuthorizedBatteryTransport) => void,
  registerRuntime?: () => Promise<void>,
): Promise<string> {
  let expectedEpoch = trackingIntentEpoch();
  let expectedAuthority = readTrackingAuthority();
  let expectedStamp = await trackingPolicyStamp();
  if (revokedStamp(expectedStamp) || await trackingIsRevoked()) {
    if (!expectedAuthority || !isCurrent() || trackingIntentEpoch() !== expectedEpoch) return 'obsolete_owner';
    if (!expectedAuthority.revoked) {
      const applied = await revokeTrackingIntentIfCurrent(expectedAuthority, 'consent', async () => {
        await sdk.stop();
        if (sdk.destroyLocations) await sdk.destroyLocations();
      });
      if (!applied) return 'obsolete_owner';
    } else await shutdownConfirmedRevocation(sdk, 'recovery_durable_revocation', expectedAuthority);
    const transport = await authorizeRevokedBatteryTransport(isCurrent);
    if (transport) onAuthorizedBattery?.(transport);
    return 'tracking_revoked';
  }
  if (expectedStamp === null) {
    await migrateLegacyTrackingIntent(sdk, isCurrent);
    expectedEpoch = trackingIntentEpoch();
    expectedStamp = await trackingPolicyStamp();
    if (revokedStamp(expectedStamp)) {
      await shutdownConfirmedRevocation(sdk, 'recovery_migration_revocation', expectedAuthority);
      return 'tracking_revoked';
    }
  }
  const intent = parseIntent(expectedStamp);
  const base = (process.env.EXPO_PUBLIC_BACKEND_URL || '').replace(/\/+$/, '');
  if (!isCurrent()) return 'obsolete_owner';
  if (!base || (intent && intent.backendBaseUrl !== base) || !base.startsWith('https://')) {
    return 'invalid_backend';
  }
  const sdkState = await sdk.getState();
  recordTrackingEvidence('native_configuration', { enabled: sdkState.enabled === true, outcome: 'configured_unverified' });
  const prefix = `${base}/api/members/`;
  const nativeMember = sdkState.url?.startsWith(prefix) && sdkState.url.endsWith('/location')
    ? sdkState.url.slice(prefix.length, -'/location'.length) : null;
  const memberId = intent?.memberId ?? nativeMember;
  if (!memberId || memberId.includes('/')) return 'invalid_member';
  // Lazy import avoids the API/engine cycle during cold entry evaluation.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getCurrentToken } = require('./api') as typeof import('./api');
  const token = await getCurrentToken();
  if (!token) return 'no_session';
  let expectedNonce = intent?.nonce;
  const current = async () => {
    const nativeAuthority = readTrackingAuthority();
    if (!expectedAuthority || !nativeAuthority || nativeAuthority.owner !== expectedAuthority.owner
      || nativeAuthority.generation !== expectedAuthority.generation) return false;
    if (trackingIntentEpoch() !== expectedEpoch || !isCurrent()) return false;
    const nonce = (await readIntent())?.nonce;
    const stamp = await trackingPolicyStamp();
    const currentToken = await getCurrentToken();
    // Revocation can occur during either storage await; the entry check alone
    // does not protect a late stale read from authorizing native work.
    return trackingIntentEpoch() === expectedEpoch && isCurrent()
      && nonce === expectedNonce && stamp === expectedStamp && currentToken === token;
  };
  const withdrawCurrent = async (reason: RevocationReason, caller: string): Promise<boolean> => {
    if (!expectedAuthority || !await current()) return false;
    const authority = expectedAuthority;
    return revokeTrackingIntentIfCurrent(authority, reason, async () => {
      recordTrackingEvidence('stop_requested', { caller, reason, authorization: 'REVOKED',
        generation: authority.generation });
      await sdk.stop();
      if (sdk.destroyLocations) await sdk.destroyLocations();
    });
  };
  if (!await current()) return 'obsolete_owner';
  const lastAttempt = Number(await AsyncStorage.getItem(ATTEMPT_KEY));
  const now = Date.now();
  const needsStart = sdkState.enabled !== true;
  const coolingDown = intent && needsStart && (
    lastAttempt > 0 && lastAttempt <= now && now - lastAttempt < COOLDOWN_MS);
  // Enabled transport can reuse a one-minute proof, never an unverified owner.
  // Disabled-engine restart ALWAYS revalidates with the server.
  const cache = verifiedOwner;
  if (!sdkState.enabled || !cache || cache.token !== token || cache.nonce !== expectedNonce
    || cache.memberId !== memberId || Date.now() < cache.at || Date.now() - cache.at >= 60_000
    || cache.consentGeneration !== getVerifiedConsentGeneration(`${cache.ownerUserId}:${memberId}`)) {
    let responses: unknown[];
    try {
      responses = await Promise.all([
        authenticatedGet(`${base}/api/auth/me`, token),
        authenticatedGet(`${base}/api/members`, token),
        authenticatedGet(`${base}/api/me/preferences`, token),
      ]);
    } catch (error) {
      if (String(error).includes('session_rejected') && await current()) {
        await withdrawCurrent('signout', 'recovery_confirmed_session_rejection');
      }
      throw error;
    }
    const [user, members, preferences] = responses as [
      { id?: string }, { id: string; user_id: string; location_consent_generation?: number }[], { location_sharing_enabled?: boolean },
    ];
    if (!await current()) return 'obsolete_owner';
    if (!user?.id || !Array.isArray(members)
      || members.some(member => !member || typeof member.id !== 'string'
        || (member.user_id != null && typeof member.user_id !== 'string'))) {
      return 'ownership_unavailable';
    }
    if ((intent && user.id !== intent.ownerUserId)
      || !members.some(member => member.id === memberId && member.user_id === user.id)) {
      if (!await withdrawCurrent('stopped', 'recovery_confirmed_owner_loss')) return 'obsolete_owner';
      return 'invalid_owner';
    }
    if (preferences?.location_sharing_enabled !== true && preferences?.location_sharing_enabled !== false) {
      return 'ownership_unavailable';
    }
    verifiedOwner = {
      token, nonce: expectedNonce, memberId, ownerUserId: user.id,
      sharing: preferences?.location_sharing_enabled === true, at: Date.now(),
      consentGeneration: members.find(m => m.id === memberId)!.location_consent_generation ?? 0,
    };
  }
  if (!await current()) return 'obsolete_owner';
  const verification = verifiedOwner;
  if (!verification) return 'ownership_unavailable';
  const permissions = await readPermissionSnapshot({ includeNotifications: false });
  if (!await current()) return 'obsolete_owner';
  const sharingOff = verification.sharing === false
    || await AsyncStorage.getItem('@kinnship/location_sharing_off_v1') === '1';
  if (!await current()) return 'obsolete_owner';
  const permissionDenied = permissions.foreground === 'denied' || permissions.background === 'denied';
  if (!permissionDenied && (permissions.foreground !== 'granted' || permissions.background !== 'granted')) {
    return 'permission_unverified';
  }
  if (sharingOff || permissionDenied) {
    if (!await withdrawCurrent(sharingOff ? 'consent' : 'permission',
      'recovery_confirmed_consent_or_permission')) return 'obsolete_owner';
    // Battery contact is not GPS consent. Still require the verified app session.
    const transport = await authorizeRevokedBatteryTransport(isCurrent);
    if (transport) onAuthorizedBattery?.(transport);
    return sharingOff ? 'sharing_disabled' : 'permission_denied';
  }
  if (await current()) onAuthorizedBattery?.({ baseUrl: base, memberId, token, isCurrent: current });
  if (!intent) return 'no_current_intent';
  const native = readTrackingAuthority();
  if (native && native.generation === 0 && native.revoked) {
    // One-time adoption requires the same affirmative server/permission proof
    // as legacy intent migration. Never reopen an actual native revocation.
    expectedAuthority = authorizeNativeTracking(`${intent.ownerUserId}:${intent.memberId}`, 0);
  }
  // Register this runtime only after genesis adoption and affirmative proof.
  // Acquisition failure/backoff cannot prevent callback registration.
  if (registerRuntime) await registerRuntime();
  if (!await current()) return 'obsolete_owner';
  // This timestamp limits configuration-recovery starts, not GPS acquisition.
  if (coolingDown) return 'cooldown';
  const locationUrl = `${base}/api/members/${encodeURIComponent(memberId)}/location`;
  if ((sdkState.extras?.consent_generation ?? 0) !== verification.consentGeneration) {
    if (!await current()) return 'obsolete_owner';
    await sdk.setConfig({ extras: { ...sdkState.extras, consent_generation: verification.consentGeneration } });
  }
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
  const latestPermissions = await readPermissionSnapshot({ includeNotifications: false });
  if (!await current()) return 'obsolete_owner';
  const lateSharingOff = await AsyncStorage.getItem('@kinnship/location_sharing_off_v1') === '1';
  if (!await current()) return 'obsolete_owner';
  if (latestPermissions.foreground === 'denied' || latestPermissions.background === 'denied' || lateSharingOff) {
    if (!await withdrawCurrent(lateSharingOff ? 'consent' : 'permission',
      'recovery_late_permission_withdrawal')) return 'obsolete_owner';
    return 'permission_denied';
  }
  const state = needsStart ? await sdk.start() : await sdk.getState();
  const finalPermissions = await readPermissionSnapshot({ includeNotifications: false });
  if (!await current()) {
    // A start can complete after a confirmed shutdown. Never do this for an
    // expired operation or for an already-authorized replacement owner.
    if (await trackingIsRevoked()) {
      recordTrackingEvidence('stop_requested', { caller: 'late_start_after_revocation', reason: 'confirmed_revocation' });
      await shutdownConfirmedRevocation(sdk, 'late_start_after_revocation');
      return 'late_start_stopped';
    }
    return 'obsolete_owner';
  }
  const finalSharingOff = await AsyncStorage.getItem('@kinnship/location_sharing_off_v1') === '1';
  if (!await current()) return 'obsolete_owner';
  if (finalPermissions.foreground === 'denied' || finalPermissions.background === 'denied' || finalSharingOff) {
    if (!await withdrawCurrent(finalSharingOff ? 'consent' : 'permission',
      'recovery_final_permission_withdrawal')) return 'obsolete_owner';
    return 'late_start_stopped';
  }
  return state.enabled === true ? needsStart ? 'restarted' : 'already_enabled' : 'start_not_enabled';
}
