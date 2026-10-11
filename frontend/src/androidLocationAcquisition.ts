import {
  trackingIntentEpoch, trackingIsRevoked, trackingPolicyStamp, verifyWakeOwnership,
} from './androidTrackingRecovery';
import type { AuthorizedBatteryTransport } from './androidTrackingRecovery';
import type { RevocationReason } from './androidTrackingRecovery';
import { readPermissionSnapshot } from './permissionCoordinator';
import { recordLocationUploadSuccess } from './locationUploadSuccess';
import { fenceNativeSdk } from './androidNativeShutdown';

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
  withdraw: (reason: RevocationReason) => Promise<void>,
): Promise<any> {
  const epoch = trackingIntentEpoch();
  const stamp = await trackingPolicyStamp();
  const current = async (freshOwnership = false) => {
    if (!executionCurrent() || epoch !== trackingIntentEpoch()) return false;
    if (await trackingIsRevoked() || !await transport.isCurrent()) return false;
    const permission = await readPermissionSnapshot({ includeNotifications: false });
    if (permission.foreground !== 'granted' || permission.background !== 'granted') return false;
    if (freshOwnership) {
      const ownership = await verifyWakeOwnership(executionCurrent);
      if (ownership !== 'allowed') {
        if (['no_session', 'invalid_owner', 'sharing_disabled'].includes(ownership)) {
          await withdraw(ownership === 'sharing_disabled' ? 'consent'
            : ownership === 'no_session' ? 'signout' : 'stopped');
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
  const position = await owned.getCurrentPosition({
    ...options, persist: false,
    extras: { ...options.extras, [GUARDED_POSITION_MARKER]: true },
  });
  if (!await current(true)) throw new Error('gps_authorization_obsolete');
  const { latitude, longitude } = position?.coords ?? {};
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !position?.timestamp) {
    throw new Error('gps_invalid_position');
  }
  // No await between the final synchronous generation fence and fetch dispatch.
  // An already-dispatched HTTP request cannot be retroactively undone by JS;
  // this fence governs publication of a fix that completed after withdrawal.
  if (!executionCurrent() || epoch !== trackingIntentEpoch()) throw new Error('gps_authorization_obsolete');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(
      `${transport.baseUrl}/api/members/${encodeURIComponent(transport.memberId)}/location`,
      {
        method: 'PUT', signal: controller.signal,
        headers: {
          'Content-Type': 'application/json', Authorization: `Bearer ${transport.token}`,
          'X-Kinnship-Presence-Source': 'location-upload',
        },
        body: JSON.stringify({
          ...position, latitude, longitude,
        }),
      },
    );
    if (!response.ok) throw new Error(`gps_upload_http_${response.status}`);
    // Do not publish coordinates to callers/diagnostics after a later boundary.
    if (!executionCurrent() || epoch !== trackingIntentEpoch() || !await transport.isCurrent()) {
      throw new Error('gps_authorization_obsolete');
    }
    await recordLocationUploadSuccess();
    if (!await transport.isCurrent() || !executionCurrent() || epoch !== trackingIntentEpoch()) {
      throw new Error('gps_authorization_obsolete');
    }
    return position;
  } finally { clearTimeout(timeout); }
}
