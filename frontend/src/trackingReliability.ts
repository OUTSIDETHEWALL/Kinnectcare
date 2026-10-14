/**
 * Android cross-runtime authority and acquisition gate. No tokens or GPS
 * coordinates cross this boundary. A missing native extension is explicit:
 * legacy authority may be preserved, but new recovery cannot be authorized.
 */
export type TrackingAuthority = {
  generation: number; owner: string; revoked: boolean;
  capturedAt?: number; nextEligibleAt?: number; outcome?: string;
  ordinaryDeliveryAt?: number; moving?: boolean; movementAt?: number;
  operation?: string;
  shutdownPending?: boolean;
  reason?: string;
  revokedOwner?: string;
};
export type OperationalRecoveryReport = {
  configurationResult: string;
  authorization: 'AUTHORIZED' | 'UNKNOWN' | 'REVOKED';
  nativeConfiguration: 'enabled' | 'start_requested' | 'unverified';
  state: 'CONFIGURED_UNVERIFIED' | 'RECENT_LOCATION_VERIFIED' | 'LOCATION_DUE_STALE'
    | 'ACQUIRING' | 'FRESH_FIX_DELIVERED' | 'DEGRADED' | 'BACKGROUND_START_BLOCKED' | 'REVOKED';
  acquisition: 'pending' | 'one_shot_delivered' | 'failed' | 'not_attempted';
  upload: 'coordinate_accepted' | 'unverified';
  androidRestriction: 'background_start_blocked' | 'unverified';
  nextEligibleAt: number | null;
  capturedAt: number | null;
  sustainedTracking: 'not_proven';
};
type ReliabilityModule = {
  trackingRead(): string;
  trackingAuthorize(owner: string, expectedGeneration: number): string;
  trackingRevoke(reason: string): string;
  trackingRevokeIfCurrent(owner: string, generation: number, reason: string, operation: string): boolean;
  trackingRearmConsent(generation: number): boolean;
  trackingClaim(owner: string, generation: number, operation: string, now: number): boolean;
  trackingClaimConfiguration(owner: string, generation: number, operation: string, now: number): boolean;
  trackingComplete(operation: string, outcome: string, capturedAt: number, moving: boolean): void;
  trackingRecord(event: string, detail: string): void;
  trackingEvidence(): string;
  trackingObserve(owner: string, generation: number, capturedAt: number, moving: boolean): void;
  trackingMovement(owner: string, generation: number, moving: boolean): void;
  trackingShutdownComplete(generation: number): void;
  trackingShutdownBegin(generation: number, operation: string): boolean;
  trackingShutdownEnd(operation: string, success: boolean): void;
};

function native(): ReliabilityModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const expo = require('expo') as { requireOptionalNativeModule?: (name: string) => ReliabilityModule | null };
    const module = expo.requireOptionalNativeModule?.('StartupDiagnostics');
    return typeof module?.trackingRead === 'function' ? module : null;
  } catch { return null; }
}

export function readTrackingAuthority(): TrackingAuthority | null {
  const module = native();
  if (!module) return null;
  return JSON.parse(module.trackingRead());
}

export function authorizeNativeTracking(owner: string, expectedGeneration: number): TrackingAuthority | null {
  const module = native();
  return module ? JSON.parse(module.trackingAuthorize(owner, expectedGeneration)) : null;
}

export function revokeNativeTracking(reason: string): void {
  native()?.trackingRevoke(reason);
}

export function rearmNativeTrackingConsent(generation: number): void {
  native()?.trackingRearmConsent(generation);
}

/**
 * Native CAS reserves shutdown before releasing the cross-runtime lock. No
 * AsyncStorage revocation write may arrive later and poison a replacement.
 */
export async function withExpectedTrackingRevocation(
  expected: TrackingAuthority, reason: string, shutdown: () => Promise<unknown>,
): Promise<boolean> {
  const module = native();
  if (!module?.trackingRevokeIfCurrent) return false;
  const operation = `conditional-shutdown-${Date.now()}-${Math.random()}`;
  let accepted: boolean;
  try {
    accepted = module.trackingRevokeIfCurrent(expected.owner, expected.generation, reason, operation);
  } catch (error) {
    // commit() failure keeps a fail-closed live native snapshot. Still stop,
    // but preserve a failed shutdown barrier and propagate the persistence error.
    const failed = JSON.parse(module.trackingRead());
    if (!failed.revoked || failed.generation !== expected.generation + 1
      || !failed.shutdowns?.[operation]) throw error;
    try { await shutdown(); } finally { module.trackingShutdownEnd(operation, false); }
    throw error;
  }
  if (!accepted) return false;
  let success = false;
  try {
    await shutdown();
    success = true;
    return true;
  } finally {
    module.trackingShutdownEnd(operation, success);
  }
}

export function completeNativeTrackingShutdown(generation: number): void {
  native()?.trackingShutdownComplete(generation);
}

/** Keep every outstanding destructive native promise behind the rebind barrier. */
export async function withConfirmedTrackingShutdown<T>(
  action: () => Promise<T>, expected?: TrackingAuthority,
): Promise<T> {
  const module = native();
  if (!module) return action(); // New binding is already blocked without the extension.
  const authority = expected ?? readTrackingAuthority();
  const operation = `shutdown-${Date.now()}-${Math.random()}`;
  if (!authority || !module.trackingShutdownBegin(authority.generation, operation)) {
    throw new Error('tracking_shutdown_obsolete');
  }
  let success = false;
  try {
    const result = await action();
    success = true;
    return result;
  } finally {
    module.trackingShutdownEnd(operation, success);
  }
}

export function recordTrackingEvidence(event: string, detail: Record<string, unknown> = {}): void {
  try { native()?.trackingRecord(event, JSON.stringify(detail)); } catch { /* evidence cannot gate shutdown */ }
}

export function claimTrackingAcquisition(owner: string, generation: number, operation: string): boolean {
  const module = native();
  if (!module) throw new Error('tracking_native_extension_required');
  return module.trackingClaim(owner, generation, operation, Date.now());
}

export function completeTrackingAcquisition(
  operation: string, outcome: string, capturedAt = 0, moving = false,
): void {
  native()?.trackingComplete(operation, outcome, capturedAt, moving);
}

export async function withTrackingConfiguration<T>(action: () => Promise<T>): Promise<T> {
  const authority = readTrackingAuthority();
  const module = native();
  if (!module || !authority || authority.revoked) throw new Error('tracking_native_authority_unavailable');
  const operation = `configuration-${Date.now()}-${Math.random()}`;
  if (!module.trackingClaimConfiguration(authority.owner, authority.generation, operation, Date.now())) {
    throw new Error('tracking_configuration_deferred');
  }
  try {
    return await action();
  } finally {
    // Configuring/starting is not fresh GPS delivery and never resets backoff.
    completeTrackingAcquisition(operation, 'operation_discarded');
  }
}

export function readTrackingEvidence(): unknown {
  try {
    const module = native();
    return module ? JSON.parse(module.trackingEvidence()) : { error: 'tracking_native_extension_required' };
  } catch { return { error: 'tracking_evidence_unavailable' }; }
}

/** A freshly authenticated owner read, not an uncorrelated SDK HTTP event. */
export function observeAcceptedTrackingLocation(member: any, owner: string, generation: number): void {
  const authority = readTrackingAuthority();
  const capturedAt = new Date(member?.coordinate_captured_at ?? '').getTime();
  if (!authority || authority.revoked || authority.owner !== owner || authority.generation !== generation
    || authority.owner.split(':')[1] !== member?.id || authority.owner.split(':')[0] !== member?.user_id
    || !Number.isFinite(capturedAt) || capturedAt > Date.now() + 5000) return;
  native()?.trackingObserve(authority.owner, authority.generation, capturedAt, member.is_moving === true);
}

export function observeTrackingMovement(moving: boolean): void {
  const authority = readTrackingAuthority();
  if (authority && !authority.revoked) native()?.trackingMovement(authority.owner, authority.generation, moving);
}

/** Configuration is never an operational-health verdict. */
export function describeOperationalRecovery(
  configurationResult: string, authority: TrackingAuthority | null, now = Date.now(),
): OperationalRecoveryReport {
  const revoked = ['tracking_revoked', 'permission_denied', 'sharing_disabled', 'invalid_owner',
    'session_rejected', 'late_start_stopped'].includes(configurationResult);
  const authorized = ['already_enabled', 'restarted', 'cooldown'].includes(configurationResult);
  const capture = authority?.capturedAt ?? 0;
  const recentMoving = authority?.moving === true && !!authority.movementAt
    && authority.movementAt <= now && now - authority.movementAt < 10 * 60_000;
  const fresh = capture > 0 && capture <= now + 5000
    && now - capture < (recentMoving ? 10 : 60) * 60_000;
  const blocked = authority?.outcome === 'background_start_blocked';
  let state: OperationalRecoveryReport['state'] = 'CONFIGURED_UNVERIFIED';
  if (capture > 0) state = fresh ? 'RECENT_LOCATION_VERIFIED' : 'LOCATION_DUE_STALE';
  if (fresh && authority?.outcome === 'fresh_fix_delivered'
    && (authority.ordinaryDeliveryAt ?? 0) <= capture) state = 'FRESH_FIX_DELIVERED';
  if (authority?.outcome === 'degraded') state = 'DEGRADED';
  if (blocked) state = 'BACKGROUND_START_BLOCKED';
  if (authority?.operation) state = 'ACQUIRING';
  if (revoked || authority?.revoked) state = 'REVOKED';
  return {
    configurationResult,
    authorization: revoked ? 'REVOKED' : authorized && authority && !authority.revoked ? 'AUTHORIZED' : 'UNKNOWN',
    nativeConfiguration: configurationResult === 'already_enabled' ? 'enabled'
      : configurationResult === 'restarted' ? 'start_requested' : 'unverified',
    state, acquisition: authority?.operation ? 'pending'
      : authority?.outcome === 'fresh_fix_delivered' ? 'one_shot_delivered'
        : blocked || authority?.outcome === 'degraded' ? 'failed' : 'not_attempted',
    upload: capture > 0 ? 'coordinate_accepted' : 'unverified',
    androidRestriction: blocked ? 'background_start_blocked' : 'unverified',
    nextEligibleAt: authority?.nextEligibleAt || null, capturedAt: capture || null,
    sustainedTracking: 'not_proven',
  };
}

export function observeNativeEnabledState(enabled: boolean): void {
  const authority = readTrackingAuthority();
  recordTrackingEvidence('native_enabled_observed', {
    enabled, generation: authority?.generation,
    caller: !enabled && !authority?.revoked ? 'UNKNOWN' : 'confirmed_revocation_or_configuration',
    authorization: authority?.revoked ? 'REVOKED' : 'UNKNOWN',
  });
}

export function recordTrackingRecoveryFailure(error: unknown, source: string): void {
  const authority = readTrackingAuthority();
  if (!authority || authority.revoked) return;
  const operation = `reconcile-${Date.now()}-${Math.random()}`;
  const text = String(error);
  const fgsDenied = /ForegroundServiceStartNotAllowed|foreground.service.*not.allowed/i.test(text);
  const outcome = /obsolete|unverified/.test(text) ? 'operation_discarded'
    : fgsDenied ? 'background_start_blocked' : 'degraded';
  recordTrackingEvidence('recovery_deferred', { outcome, source, fgsDenied });
  if (claimTrackingAcquisition(authority.owner, authority.generation, operation)) {
    completeTrackingAcquisition(operation, outcome);
  }
}
