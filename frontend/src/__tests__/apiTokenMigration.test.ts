jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));
jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK: 'AFTER_FIRST_UNLOCK',
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

import * as SecureStore from 'expo-secure-store';
import {
  migrateTokenForBackgroundActions,
  saveToken,
} from '../api';

jest.mock('expo-secure-store');

describe('native welfare-action token migration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('re-saves an existing session token with after-first-unlock accessibility', async () => {
    (SecureStore.getItemAsync as jest.Mock).mockResolvedValueOnce('existing-token');

    await migrateTokenForBackgroundActions();

    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      'kc_token',
      'existing-token',
      { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK },
    );
  });

  it('stores new session tokens with the same lock-screen-safe accessibility', async () => {
    await saveToken('new-token');

    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      'kc_token',
      'new-token',
      { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK },
    );
  });
});