const mockStorage = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn((key: string) => Promise.resolve(mockStorage.get(key) ?? null)),
  setItem: jest.fn((key: string, value: string) => {
    mockStorage.set(key, value);
    return Promise.resolve();
  }),
  removeItem: jest.fn((key: string) => {
    mockStorage.delete(key);
    return Promise.resolve();
  }),
}));

import {
  clearPendingInvite,
  getPendingInvite,
  isInviteConsumed,
  markInviteConsumed,
  setPendingInvite,
} from '../pendingInvite';

describe('consumed invitation replay guard', () => {
  beforeEach(() => {
    mockStorage.clear();
  });

  test('a successfully consumed token cannot be restored as pending', async () => {
    await setPendingInvite('INV-REBOOT123');
    expect((await getPendingInvite())?.token).toBe('INV-REBOOT123');

    await markInviteConsumed('INV-REBOOT123');
    await clearPendingInvite();

    // Simulates Google Play Install Referrer or Android redelivering the
    // original launch Intent after the phone reboots.
    await setPendingInvite('INV-REBOOT123');

    expect(await isInviteConsumed('INV-REBOOT123')).toBe(true);
    expect(await getPendingInvite()).toBeNull();
  });

  test('a different, newly issued invitation can still be persisted', async () => {
    await markInviteConsumed('INV-OLD123');
    await setPendingInvite('INV-NEW456');

    expect((await getPendingInvite())?.token).toBe('INV-NEW456');
  });

  test('an interrupted old release leaving pending and consumed records recovers after restart', async () => {
    await setPendingInvite('INV-ACCEPTED');
    await markInviteConsumed('INV-ACCEPTED');
    // Same persisted storage, fresh module lifetime as after an OTA/restart.
    jest.resetModules();
    const reopened = require('../pendingInvite');
    expect(await reopened.getPendingInvite()).toBeNull();
    expect(await reopened.isInviteConsumed('INV-ACCEPTED')).toBe(true);
    expect(mockStorage.has('@kinnship/pending_invite_v1')).toBe(false);
  });

  test('closing an older route preserves a different pending invitation', async () => {
    await setPendingInvite('INV-NEW456');
    await clearPendingInvite('INV-OLD123');
    expect((await getPendingInvite())?.token).toBe('INV-NEW456');
  });
});