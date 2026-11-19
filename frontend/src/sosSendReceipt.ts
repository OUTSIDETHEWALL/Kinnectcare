/**
 * Volatile evidence from this process's SOS response, never a delivery receipt.
 * Do not persist coordinates or derive success from a deep-link parameter.
 */
export type SosLocationEvidence = {
  capturedAt?: number;
  accuracy?: number;
  acquiredDuringAttempt?: boolean;
};

export type SosSendReceipt = {
  scope: string;
  alertId: string;
  recordedAt: string | null;
  notificationRequested: boolean;
  location: 'gps' | 'last-known' | 'included' | 'unavailable';
  capturedAt?: number;
  accuracy?: number;
  dialerOpened: boolean;
};

let latest: SosSendReceipt | null = null;
let epoch = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());

export function clearSosSendReceipt(alertId?: string) {
  if (alertId !== undefined && latest?.alertId !== alertId) return;
  latest = null;
  epoch += 1;
  emit();
}

export function sosAccountScope(user: { id: string; family_group_id?: string | null } | null) {
  return user?.id && user.family_group_id ? JSON.stringify([user.id, user.family_group_id]) : null;
}

export const getSosReceiptEpoch = () => epoch;
export function subscribeSosSendReceipt(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function readSosSendReceipt(alertId: unknown, scope: string | null): SosSendReceipt | null {
  return scope && typeof alertId === 'string' && latest?.alertId === alertId && latest.scope === scope ? latest : null;
}

export function noteSosDialerOpened(alertId: string | null) {
  if (latest && latest.alertId === alertId) {
    latest = { ...latest, dialerOpened: true };
    emit();
  }
}

export function recordSosSendReceipt(
  response: unknown,
  evidence: SosLocationEvidence,
  dialerOpened: boolean,
  scope: string,
): SosSendReceipt {
  const data = response as Record<string, any> | null;
  if (data?.ok !== true || typeof data.alert_id !== 'string' || !data.alert_id.trim()) {
    throw new Error('SOS recording was not confirmed by the server.');
  }
  const coords = data.coordinates;
  const included = typeof coords?.latitude === 'number' && Number.isFinite(coords.latitude)
    && Math.abs(coords.latitude) <= 90
    && typeof coords?.longitude === 'number' && Number.isFinite(coords.longitude)
    && Math.abs(coords.longitude) <= 180;
  latest = {
    scope,
    alertId: data.alert_id,
    recordedAt: typeof data.timestamp === 'string' && Number.isFinite(Date.parse(data.timestamp))
      ? data.timestamp : null,
    notificationRequested: data.fanout_mode === 'background',
    location: !included ? 'unavailable' : evidence.capturedAt === undefined ? 'included'
      : evidence.acquiredDuringAttempt ? 'gps' : 'last-known',
    ...(included ? { capturedAt: evidence.capturedAt, accuracy: evidence.accuracy } : {}),
    dialerOpened,
  };
  emit();
  return latest;
}
