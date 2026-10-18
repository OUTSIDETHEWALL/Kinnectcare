import type { TrackingAuthority } from './trackingReliability';

/** HTTP 200 alone is never GPS evidence. Never mutate the member store here. */
export function verifiedDelivery(
  raw: unknown, _callbackContext: 'background' | 'foreground', authority: TrackingAuthority | null,
  now = Date.now(),
): Record<string, unknown> | null {
  if (!authority || authority.revoked) return null;
  try {
    const body = typeof raw === 'string' ? JSON.parse(raw) : raw as any;
    const capturedAt = Date.parse(body?.location_write_captured_at);
    if (body?.id !== authority.owner.split(':')[1]
      || body?.user_id !== authority.owner.split(':')[0]
      || body?.location_write_accepted !== true || body.location_write_rejection_reason != null
      || !Number.isFinite(capturedAt) || capturedAt > now + 5000 || now - capturedAt > 5 * 60_000) return null;
    return { origin: 'native-receipt', captureId: body.location_write_capture_uuid,
      consentGeneration: body.location_write_consent_generation ?? 0,
      capturedAt, generation: authority.generation, owner: authority.owner };
  } catch { return null; }
}
