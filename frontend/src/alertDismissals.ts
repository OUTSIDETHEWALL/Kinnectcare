import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Alert } from './api';

export type SosDismissals = Record<string, string>;
export type AlertScope = { key: string; cacheKey: string; dismissalsKey: string };

export function alertScope(user?: { id?: string | null; family_group_id?: string | null } | null): AlertScope | null {
  if (!user?.id) return null;
  const key = JSON.stringify([user.id, user.family_group_id ?? null]);
  return {
    key,
    // Do not hydrate the old account-only cache after a family change.
    cacheKey: `@kinnship/alerts_v2_${key}`,
    dismissalsKey: `@kinnship/sos_dismissals_v1_${key}`,
  };
}

export function isClearedAlert(alert: Alert): boolean {
  return alert.type === 'sos' ? alert.resolved === true : alert.acknowledged === true;
}

export function sosResolution(alert: Alert): string | null {
  if (alert.type !== 'sos' || alert.resolved !== true) return null;
  const date = alert.resolved_at ? Date.parse(alert.resolved_at) : NaN;
  return Number.isFinite(date) ? String(date) : 'undated-resolution';
}

export function visibleAlerts(alerts: Alert[], dismissed: SosDismissals): Alert[] {
  return alerts.filter(alert => {
    const resolution = sosResolution(alert);
    return resolution === null || dismissed[alert.id] !== resolution;
  });
}

export function decodeDismissals(raw: string | null): SosDismissals {
  if (!raw) return {};
  const data = JSON.parse(raw);
  if (data?.version !== 1 || !data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) return {};
  const entries: [string, string][] = [];
  for (const [id, token] of Object.entries(data.entries)) {
    if (typeof token === 'string') entries.push([id, token]);
  }
  return Object.fromEntries(entries);
}

// Serialize reads as well as writes: a remount must wait for an earlier native
// write to finish, not hydrate an older dismissal record while it is pending.
const storageQueues = new Map<string, Promise<unknown>>();
export function alertStorage<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const next = (storageQueues.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation);
  const settled = next.catch(() => undefined);
  storageQueues.set(key, settled);
  void settled.then(() => {
    if (storageQueues.get(key) === settled) storageQueues.delete(key);
  });
  return next;
}

export function persistSosDismissals(
  scope: AlertScope, selected: Alert[], stillCurrent: () => boolean,
): Promise<SosDismissals> {
  return alertStorage(scope.dismissalsKey, async () => {
    const marks = decodeDismissals(await AsyncStorage.getItem(scope.dismissalsKey));
    if (!stillCurrent()) throw new Error('Account or family changed. No further alerts were cleared.');
    for (const alert of selected) {
      const resolution = sosResolution(alert);
      if (resolution !== null) marks[alert.id] = resolution;
    }
    // Store identifiers and resolution generations only, never incident data.
    await AsyncStorage.setItem(scope.dismissalsKey, JSON.stringify({ version: 1, entries: marks }));
    return marks;
  });
}
