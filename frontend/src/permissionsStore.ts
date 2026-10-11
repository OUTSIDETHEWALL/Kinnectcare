/**
 * permissionsStore.ts — tracks whether the first-launch permission
 * onboarding sequence has been completed on this device.
 *
 * Android may restore AsyncStorage on reinstall without restoring OS
 * grants. The legacy completion flag therefore needs a current OS check;
 * the saved decision also preserves an explicit Continue Anyway choice.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { readPermissionSnapshot, PermissionSnapshot } from './permissionCoordinator';

const KEY = '@kinnship/permissions_handled_v1';
const DECISION_KEY = '@kinnship/permission_decision_v2';

export class LocationPermissionDecisionChangedError extends Error {
  constructor(public readonly current: PermissionSnapshot) {
    super('Location permission changed while setup was pending');
    this.name = 'LocationPermissionDecisionChangedError';
  }
}

export function permissionDecisionStillApplies(
  decision: PermissionSnapshot,
  current: PermissionSnapshot,
  includeNotifications = true,
): boolean {
  // Losing a previously granted OS permission invalidates restored setup.
  // A deliberate denial/Continue Anyway remains valid: no prompt loop.
  const keys = includeNotifications
    ? ['foreground', 'background', 'notifications'] as const
    : ['foreground', 'background'] as const;
  return keys.every(
    key => decision[key] !== 'granted' || current[key] === 'granted',
  );
}

export async function isPermissionsHandled(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw !== 'true') return false;
    if (Platform.OS !== 'android') return true;
    // Notification functionality is optional, not location authorization or
    // grounds to reopen completed setup after notification denial/failure.
    const current = await readPermissionSnapshot({ includeNotifications: false });
    if (current.foreground === 'granted' && current.background === 'granted') return true;
    const stored = await AsyncStorage.getItem(DECISION_KEY);
    if (!stored) return false; // Legacy boolean alone is not Android evidence.
    const decision = JSON.parse(stored);
    if (!decision || !['foreground', 'background'].every(
      key => ['granted', 'denied', 'undetermined'].includes(decision[key]),
    )) return false;
    return permissionDecisionStillApplies(decision, current, false);
  } catch (_e) {
    return false;
  }
}

export async function markPermissionsHandled(
  expectedDecision?: Pick<PermissionSnapshot, 'foreground' | 'background'>,
): Promise<void> {
  if (Platform.OS !== 'android') {
    try { await AsyncStorage.setItem(KEY, 'true'); } catch (_e) {}
    return;
  }
  // Surface persistence errors instead of navigating into a setup loop.
  if (Platform.OS === 'android') {
    const current = await readPermissionSnapshot({ includeNotifications: false });
    if (expectedDecision && !permissionDecisionStillApplies(
      { ...expectedDecision, notifications: 'not-inspected' }, current, false,
    )) throw new LocationPermissionDecisionChangedError(current);
    await AsyncStorage.setItem(DECISION_KEY, JSON.stringify(current));
  }
  await AsyncStorage.setItem(KEY, 'true');
}
