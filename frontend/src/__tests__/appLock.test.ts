const mockStorage = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (key: string) => mockStorage.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => {
    mockStorage.set(key, value);
  }),
  removeItem: jest.fn(async (key: string) => {
    mockStorage.delete(key);
  }),
}));

import {
  disableAppLock,
  enableAppLock,
  isAppLockEnabled,
  markAppLockMigrationNoticeShown,
  needsAppLockUnlock,
  shouldShowAppLockMigrationNotice,
} from '../appLock';

describe('optional App Lock preference', () => {
  beforeEach(() => {
    mockStorage.clear();
    jest.clearAllMocks();
  });

  it('defaults to off for signed-in users, including legacy PIN users', async () => {
    await expect(isAppLockEnabled('user-1')).resolves.toBe(false);
  });

  it('can be enabled and disabled without any session operation', async () => {
    await enableAppLock('user-1');
    await expect(isAppLockEnabled('user-1')).resolves.toBe(true);

    await disableAppLock('user-1');
    await expect(isAppLockEnabled('user-1')).resolves.toBe(false);
  });

  it('shows the migration explanation once only for users with a legacy PIN', async () => {
    await expect(shouldShowAppLockMigrationNotice('user-1', false)).resolves.toBe(false);
    await expect(shouldShowAppLockMigrationNotice('user-1', true)).resolves.toBe(true);

    await markAppLockMigrationNoticeShown('user-1');
    await expect(shouldShowAppLockMigrationNotice('user-1', true)).resolves.toBe(false);
  });

  it('keeps preferences isolated by user on a shared device', async () => {
    await enableAppLock('user-1');
    await markAppLockMigrationNoticeShown('user-1');

    await expect(isAppLockEnabled('user-2')).resolves.toBe(false);
    await expect(shouldShowAppLockMigrationNotice('user-2', true)).resolves.toBe(true);
  });

  it('requires foreground unlock only for an enabled lock with a usable PIN', () => {
    expect(needsAppLockUnlock(false, true, false)).toBe(false);
    expect(needsAppLockUnlock(true, false, false)).toBe(false);
    expect(needsAppLockUnlock(true, true, true)).toBe(false);
    expect(needsAppLockUnlock(true, true, false)).toBe(true);
  });
});