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

export function permissionDecisionStillApplies(
  decision: PermissionSnapshot,
  current: PermissionSnapshot,
): boolean {
  // Losing a previously granted OS permission invalidates restored setup.
  // A deliberate denial/Continue Anyway remains valid: no prompt loop.
  return (['foreground', 'background', 'notifications'] as const).every(
    key => decision[key] !== 'granted' || current[key] === 'granted',
  );
}

export async function isPermissionsHandled(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw !== 'true') return false;
    if (Platform.OS !== 'android') return true;
    const current = await readPermissionSnapshot();
    if (Object.values(current).every(status => status === 'granted')) return true;
    const stored = await AsyncStorage.getItem(DECISION_KEY);
    if (!stored) return false; // Legacy boolean alone is not Android evidence.
    const decision = JSON.parse(stored);
    if (!decision || !['foreground', 'background', 'notifications'].every(
      key => ['granted', 'denied', 'undetermined'].includes(decision[key]),
    )) return false;
    return permissionDecisionStillApplies(decision, current);
  } catch (_e) {
    return false;
  }
}

export async function markPermissionsHandled(): Promise<void> {
  // Surface persistence errors instead of navigating into a setup loop.
  if (Platform.OS === 'android') {
    await AsyncStorage.setItem(DECISION_KEY, JSON.stringify(await readPermissionSnapshot()));
  }
  await AsyncStorage.setItem(KEY, 'true');
}
