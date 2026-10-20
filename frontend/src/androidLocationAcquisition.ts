import {
  trackingIntentEpoch, trackingIsRevoked, trackingPolicyStamp, verifyWakeOwnership, getVerifiedConsentGeneration,
} from './androidTrackingRecovery';
import type { AuthorizedBatteryTransport } from './androidTrackingRecovery';
import type { RevocationReason } from './androidTrackingRecovery';
import { readPermissionSnapshot } from './permissionCoordinator';
import { recordLocationUploadSuccess } from './locationUploadSuccess';
import { fenceNativeSdk } from './androidNativeShutdown';
import {
  readTrackingAuthority, claimTrackingAcquisition, completeTrackingAcquisition, recordTrackingEvidence,
} from './trackingReliability';
import type { TrackingAuthority } from './trackingReliability';
import { appendEngineEvidence } from './engineEvidenceJournal';
import { nextSeq } from './diagSeq';
import { recordEvidence, startupTraceId } from './evidenceTrace';

export const GUARDED_POSITION_MARKER = 'kc_guarded_one_shot';
type PositionOptions = { samples?: number; timeout?: number; extras?: Record<string, unknown> };
type PositionSdk = {
  getCurrentPosition: (options: any) => Promise<any>;
  stop: () => Promise<unknown>;
};

/**
 * Native persist:true writes before JS receives the fix. Never use it here.
 * Acquire without SQLite/HTTP side effects, then verify again before starting
 * an explicit, receipt-bound HTTP write. No native insertion or offline queue.
 */
export async function acquireAndUploadAndroidPosition(
  sdk: PositionSdk, transport: AuthorizedBatteryTransport, options: PositionOptions,
  executionCurrent: () => boolean,
  withdraw: (reason: RevocationReason, expected: TrackingAuthority) => Promise<unknown>,
): Promise<any> {
  const epoch = trackingIntentEpoch();
  const stamp = await trackingPolicyStamp();
  const authority = readTrackingAuthority();
  const operation = `gps-${Date.now()}-${Math.random()}`;
  const evidenceId = startupTraceId();
  if (!authority || authority.revoked) throw new Error('tracking_native_authority_unavailable');
  const current = async (freshOwnership = false) => {
    const latestAuthority = readTrackingAuthority();
    if (!latestAuthority || latestAuthority.revoked || latestAuthority.generation !== authority.generation
      || latestAuthority.owner !== authority.owner) return false;
    if (!executionCurrent() || epoch !== trackingIntentEpoch()) return false;
    if (await trackingIsRevoked() || !await transport.isCurrent()) return false;
    const permission = await readPermissionSnapshot({ includeNotifications: false });
    if (!executionCurrent() || epoch !== trackingIntentEpoch()) return false;
    if (permission.foreground === 'denied' || permission.background === 'denied') {
      await withdraw('permission', authority);
      return false;
    }
    if (permission.foreground !== 'granted' || permission.background !== 'granted') return false;
    if (freshOwnership) {
      const ownership = await verifyWakeOwnership(executionCurrent);
      recordEvidence('gps', 'authorization_result', evidenceId, {
        accepted: ownership === 'allowed', generation: authority.generation,
        reason: ownership,
        parentId: typeof options.extras?.kc_evidence_wake_id === 'string' ? options.extras.kc_evidence_wake_id : null,
      });
      if (!executionCurrent() || epoch !== trackingIntentEpoch()) return false;
      if (ownership !== 'allowed') {
        if (['session_rejected', 'invalid_owner', 'sharing_disabled'].includes(ownership)) {
          await withdraw(ownership === 'sharing_disabled' ? 'consent'
            : ownership === 'session_rejected' ? 'signout' : 'stopped', authority);
        }
        return false;
      }
    }
    const latestStamp = await trackingPolicyStamp();
    return executionCurrent() && epoch === trackingIntentEpoch()
      && latestStamp === stamp && !await trackingIsRevoked() && await transport.isCurrent();
  };
  const owned = fenceNativeSdk(sdk, () => current(),
    () => executionCurrent() && epoch === trackingIntentEpoch());
  const authorized = await current(true);
  recordEvidence('gps', 'authorization_result', evidenceId, {
    accepted: authorized, generation: authority.generation,
    reason: authorized ? 'allowed' : 'authorization_unverified',
  });
  if (!authorized) throw new Error('gps_authorization_unverified');
  const consentGeneration = getVerifiedConsentGeneration(authority.owner);
  if (consentGeneration === null) throw new Error('gps_consent_generation_unverified');
  if (!claimTrackingAcquisition(authority.owner, authority.generation, operation, evidenceId)) throw new Error('gps_recovery_not_due');
   recordTrackingEvidence('acquisition_attempt', { operation, generation: authority.generation, owner: authority.owner,
     source: typeof options.extras?.source === 'string' ? options.extras.source : 'UNKNOWN' });
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
  const position = await Promise.race([owned.getCurrentPosition({
    ...options, timeout: Math.min(options.timeout ?? 20, 20), persist: false,
    extras: { ...options.extras, [GUARDED_POSITION_MARKER]: true,
      ...(evidenceId ? { kc_evidence_id: evidenceId } : {}) },
  }), new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('gps_acquisition_408_timeout')), Math.min(options.timeout ?? 20, 20) * 1000);
  })]);
  if (timer) clearTimeout(timer);
  if (!await current(true)) throw new Error('gps_authorization_obsolete');
  const { latitude, longitude } = position?.coords ?? {};
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !position?.timestamp) {
    throw new Error('gps_invalid_position');
  }
  const capturedAt = new Date(position.timestamp).getTime();
  if (!Number.isFinite(capturedAt) || capturedAt > Date.now() + 5000 || Date.now() - capturedAt > 60000) {
    throw new Error('gps_capture_not_fresh');
  }
  // No await between the final synchronous generation fence and fetch dispatch.
  // An already-dispatched HTTP request cannot be retroactively undone by JS;
  // this fence governs publication of a fix that completed after withdrawal.
  if (!executionCurrent() || epoch !== trackingIntentEpoch()) throw new Error('gps_authorization_obsolete');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    recordTrackingEvidence('upload_attempt', { operation, generation: authority.generation, capturedAt });
    recordEvidence('gps', 'publication_attempt', evidenceId, { generation: authority.generation });
    const response = await fetch(
      `${transport.baseUrl}/api/members/${encodeURIComponent(transport.memberId)}/location`,
      {
        method: 'PUT', signal: controller.signal,
        headers: {
          'Content-Type': 'application/json', Authorization: `Bearer ${transport.token}`,
          'X-Kinnship-Presence-Source': 'location-upload',
        },
        body: JSON.stringify({
          ...position, latitude, longitude, consent_generation: consentGeneration,
        }),
      },
    );
    if (!response.ok) {
      recordEvidence('gps', 'publication_result', evidenceId, { accepted: false, status: response.status });
      throw new Error(`gps_upload_http_${response.status}`);
    }
    const accepted = await response.json();
    // HTTP 2xx can represent an older/replay-suppressed GPS fix. It is contact,
    // not fresh coordinate delivery. The response tuple must identify our fix.
    const coordinateAccepted = accepted?.location_write_accepted === true
      && accepted.location_write_rejection_reason == null
      && new Date(accepted?.coordinate_captured_at ?? '').getTime() === capturedAt
      && accepted.latitude === latitude && accepted.longitude === longitude;
    recordTrackingEvidence('upload_result', { operation, httpAccepted: true, coordinateAccepted, capturedAt });
    recordEvidence('gps', 'publication_result', evidenceId, {
      accepted: coordinateAccepted, status: response.status, generation: authority.generation,
    });
    if (!coordinateAccepted) throw new Error('gps_coordinates_not_accepted');
    // Do not publish coordinates to callers/diagnostics after a later boundary.
    if (!await current()) {
      throw new Error('gps_authorization_obsolete');
    }
    await recordLocationUploadSuccess();
    await appendEngineEvidence({
      seq: nextSeq(), at: Date.now(), event: 'verified_coordinate_publication', src: 'engine',
      detail: { origin: 'one-shot', source: options.extras?.source ?? 'one-shot',
        capturedAt, consentGeneration, generation: authority.generation, owner: authority.owner },
    });
    if (!await current()) {
      throw new Error('gps_authorization_obsolete');
    }
    completeTrackingAcquisition(operation, 'fresh_fix_delivered', capturedAt, position.is_moving === true);
    recordEvidence('gps', 'acquisition_completed', evidenceId, { accepted: true, generation: authority.generation });
    settled = true;
    return position;
  } finally { clearTimeout(timeout); }
  } catch (error) {
    const text = String(error);
    const fgsDenied = /ForegroundServiceStartNotAllowed|foreground.service.*not.allowed/i.test(text);
    const outcome = /obsolete|unverified/.test(text) ? 'operation_discarded'
      : fgsDenied ? 'background_start_blocked' : 'degraded';
    const reason = /408|timeout/.test(text) ? 'gps_timeout'
      : /http_/.test(text) ? 'http_error' : /capture_not_fresh/.test(text) ? 'stale_capture'
        : /coordinates_not_accepted/.test(text) ? 'coordinate_rejected'
          : outcome === 'operation_discarded' ? 'authorization_obsolete'
            : fgsDenied ? 'fgs_denied' : 'unclassified';
    recordTrackingEvidence('acquisition_failed', { operation, outcome, fgsDenied, reason });
    if (!settled) completeTrackingAcquisition(operation, outcome);
    recordEvidence('gps', 'acquisition_completed', evidenceId, { accepted: false, generation: authority.generation });
    throw error;
  } finally { if (timer) clearTimeout(timer); }
}
