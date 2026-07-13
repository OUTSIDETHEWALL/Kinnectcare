/**
 * permissionsStore.ts — tracks whether the first-launch permission
 * onboarding sequence has been completed on this device.
 *
 * Storage: a single boolean flag in AsyncStorage.  Losing it (e.g. on
 * a fresh install) just re-shows the permissions screen once, which is
 * the correct behaviour — a fresh install means no permissions granted
 * yet, so the screen is appropriate.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = '@kinnship/permissions_handled_v1';

export async function isPermissionsHandled(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw === 'true';
  } catch (_e) {
    return false;
  }
}

export async function markPermissionsHandled(): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, 'true');
  } catch (_e) {}
}
