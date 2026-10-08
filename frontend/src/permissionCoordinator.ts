import { Platform } from 'react-native';

// Both modules are already linked in Build 68. Load only at the call site so
// registration/headless imports do not initialize notification permission UI.
function location(): typeof import('expo-location') {
  return require('expo-location');
}
function notificationApi(): typeof import('expo-notifications') {
  return require('expo-notifications');
}

// One queue for foreground permission UI. Automatic Android callers only
// inspect permissions; onboarding (or an explicit user action) owns requests.
let permissionQueue: Promise<unknown> = Promise.resolve();

export function serializePermissionOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = permissionQueue.then(operation);
  permissionQueue = result.catch(() => {});
  return result;
}

export type PermissionSnapshot = {
  foreground: string;
  background: string;
  notifications: string;
};

export async function readPermissionSnapshot(): Promise<PermissionSnapshot> {
  const Location = location();
  const Notifications = notificationApi();
  const [foreground, background, notifications] = await Promise.all([
    Location.getForegroundPermissionsAsync(),
    Location.getBackgroundPermissionsAsync(),
    Notifications.getPermissionsAsync(),
  ]);
  return {
    foreground: foreground.status,
    background: background.status,
    notifications: notifications.status,
  };
}

type LocationDecision = { foreground: string; background: string } | null;
let onboardingLocation: {
  isCurrent: () => boolean;
  promise: Promise<LocationDecision>;
} | null = null;

export function requestOnboardingLocation(isCurrent: () => boolean = () => true): Promise<LocationDecision> {
  if (onboardingLocation) {
    // A remounted screen adopts the pending disclosure instead of issuing a
    // second request. The disposed screen still ignores the shared result.
    onboardingLocation.isCurrent = isCurrent;
    return onboardingLocation.promise;
  }
  const operation = { isCurrent, promise: null as unknown as Promise<LocationDecision> };
  const current = () => operation.isCurrent();
  operation.promise = serializePermissionOperation(async () => {
    const Location = location();
    if (!current()) return null;
    // Disclosure and both requests are one operation, so notification
    // registration cannot interleave and a dismissed screen cannot request.
    const { ensureBackgroundLocationDisclosure } = require('./backgroundLocationDisclosure');
    await ensureBackgroundLocationDisclosure();
    if (!current()) return null;
    const foreground = await Location.requestForegroundPermissionsAsync();
    if (!current()) return null;
    if (foreground.status !== 'granted' || Platform.OS !== 'android') {
      return { foreground: foreground.status, background: 'undetermined' };
    }
    const existing = await Location.getBackgroundPermissionsAsync();
    if (!current()) return null;
    const background = existing.status === 'granted'
      ? existing
      : await Location.requestBackgroundPermissionsAsync();
    if (!current()) return null;
    return { foreground: foreground.status, background: background.status };
  }).finally(() => {
    if (onboardingLocation === operation) onboardingLocation = null;
  });
  onboardingLocation = operation;
  return operation.promise;
}

export function foregroundLocationForAutomaticCaller() {
  return serializePermissionOperation(() => Platform.OS === 'android'
    ? location().getForegroundPermissionsAsync()
    : location().requestForegroundPermissionsAsync());
}

export function notificationPermission(
  interactive = false,
  isCurrent: () => boolean = () => true,
) {
  return serializePermissionOperation(async () => {
    const Notifications = notificationApi();
    const existing = await Notifications.getPermissionsAsync();
    if (!isCurrent() || existing.status === 'granted') return existing;
    if (Platform.OS === 'android' && !interactive) return existing;
    return Notifications.requestPermissionsAsync();
  });
}
