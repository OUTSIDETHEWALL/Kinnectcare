/**
 * Optional App Lock preference.
 *
 * Email-code authentication owns the signed-in session.  This module only
 * records whether a particular signed-in user wants the extra foreground
 * privacy gate provided by the existing PIN/biometric unlock UI.
 *
 * The default is deliberately off, including for users who created a PIN
 * before this preference existed.  Their PIN stays in SecureStore so they can
 * turn App Lock on later without choosing a new one.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const APP_LOCK_PREFIX = '@kinnship/app_lock_v1_';
const MIGRATION_NOTICE_PREFIX = '@kinnship/app_lock_migration_notice_v1_';

function safeUserId(userId: string): string {
  return String(userId || '').replace(/[^A-Za-z0-9_.-]/g, '');
}

function appLockKey(userId: string): string {
  return `${APP_LOCK_PREFIX}${safeUserId(userId)}`;
}

function migrationNoticeKey(userId: string): string {
  return `${MIGRATION_NOTICE_PREFIX}${safeUserId(userId)}`;
}

/** App Lock is opt-in. Missing or unreadable storage must never lock a user out. */
export async function isAppLockEnabled(userId: string): Promise<boolean> {
  if (!userId) return false;
  try {
    return (await AsyncStorage.getItem(appLockKey(userId))) === '1';
  } catch (_e) {
    return false;
  }
}

export async function enableAppLock(userId: string): Promise<void> {
  if (!userId) return;
  await AsyncStorage.setItem(appLockKey(userId), '1');
}

/**
 * Disabling App Lock only changes the foreground-gate preference. It does not
 * delete the saved PIN, biometric preference, or authenticated session.
 */
export async function disableAppLock(userId: string): Promise<void> {
  if (!userId) return;
  await AsyncStorage.removeItem(appLockKey(userId));
}

export async function shouldShowAppLockMigrationNotice(
  userId: string,
  hasLegacyPin: boolean,
): Promise<boolean> {
  if (!userId || !hasLegacyPin) return false;
  try {
    return (await AsyncStorage.getItem(migrationNoticeKey(userId))) !== '1';
  } catch (_e) {
    return false;
  }
}

export async function markAppLockMigrationNoticeShown(userId: string): Promise<void> {
  if (!userId) return;
  try {
    await AsyncStorage.setItem(migrationNoticeKey(userId), '1');
  } catch (_e) {
    // If this write fails, showing the explanation again is safer than
    // changing authentication behavior or blocking the signed-in session.
  }
}

/**
 * Pure routing decision used by RootNav and tests. App Lock never blocks a
 * signed-in user unless they explicitly enabled it and have a usable PIN.
 */
export function needsAppLockUnlock(
  appLockEnabled: boolean,
  hasPin: boolean,
  unlockedThisProcess: boolean,
): boolean {
  return appLockEnabled && hasPin && !unlockedThisProcess;
}