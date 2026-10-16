import React from 'react';
import { act, create } from 'react-test-renderer';
import { AuthProvider, useAuth } from '../AuthContext';

const mockGet = jest.fn();
const mockPut = jest.fn();
const mockPost = jest.fn();
const mockStorageRead = jest.fn();
const mockStorageWrite = jest.fn();
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('../api', () => ({
  api: { get: (...args: any[]) => mockGet(...args), put: (...args: any[]) => mockPut(...args),
    post: (...args: any[]) => mockPost(...args) },
  saveToken: jest.fn(), clearToken: jest.fn(async () => {}),
}));
jest.mock('expo-secure-store', () => ({ getItemAsync: async () => 'test-session' }));
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: (...args: any[]) => mockStorageRead(...args),
  setItem: (...args: any[]) => mockStorageWrite(...args),
  removeItem: async () => {},
}));
jest.mock('../pinAuth', () => ({
  forgetSessionUnlock: jest.fn(), hasPinForUser: jest.fn(), markUnlocked: jest.fn(), clearPin: jest.fn(),
}));
jest.mock('../pinSession', () => ({ clearSession: async () => {} }));
jest.mock('../pendingInvite', () => ({
  getPendingInvite: async () => null, clearPendingInvite: async () => {}, markInviteConsumed: async () => {},
}));
jest.mock('../freshInstallGuard', () => ({
  maybeClearStaleSecureStoreOnFreshInstall: async () => {},
  wasFreshInstallThisLaunch: () => false, consumeFreshInstallFlag: () => false,
}));
jest.mock('../installReferrerInvite', () => ({ captureInstallReferrerInvite: async () => {} }));
jest.mock('../startupDiagnostics', () => ({ logStartupEvent: jest.fn() }));
jest.mock('../nativeStartupRecorder', () => ({ recordNativeStartupCheckpoint: jest.fn() }));

describe('real AuthProvider first usable state', () => {
  let auth: ReturnType<typeof useAuth>;
  let tree: ReturnType<typeof create>;
  const user = { id: 'startup-self', timezone: 'not-device-timezone' };
  function Probe() { auth = useAuth(); return null; }
  const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockReset().mockResolvedValue({ data: user });
    mockPost.mockReset();
    mockPut.mockReset().mockImplementation(() => new Promise(() => {}));
    mockStorageRead.mockReset().mockResolvedValue(null);
    mockStorageWrite.mockReset().mockResolvedValue(undefined);
  });
  afterEach(async () => {
    if (tree) await act(async () => tree.unmount());
    jest.useRealTimers();
  });

  it('releases authenticated startup while optional timezone maintenance never completes', async () => {
    await act(async () => { tree = create(<AuthProvider><Probe /></AuthProvider>); await flush(); });
    expect(mockPut).toHaveBeenCalled();
    expect(auth!.user?.id).toBe(user.id);
    expect(auth!.loading).toBe(false);
  });
  it('does not hold usable authenticated state behind a delayed cache write', async () => {
    mockStorageWrite.mockImplementation(() => new Promise(() => {}));
    await act(async () => { tree = create(<AuthProvider><Probe /></AuthProvider>); await flush(); });
    expect(auth!.user?.id).toBe(user.id);
    expect(auth!.loading).toBe(false);
  });
  it('a late bootstrap response cannot resurrect a signed-out cached session', async () => {
    let complete!: (value: unknown) => void;
    mockStorageRead.mockResolvedValue(JSON.stringify(user));
    mockGet.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    await act(async () => { tree = create(<AuthProvider><Probe /></AuthProvider>); await flush(); });
    await act(async () => { await auth!.logout(); });
    await act(async () => { complete({ data: user }); await flush(); });
    expect(auth!.user).toBeNull();
  });
  it('a late OTP response cannot sign the user back in after logout', async () => {
    let complete!: (value: unknown) => void;
    mockPost.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    await act(async () => { tree = create(<AuthProvider><Probe /></AuthProvider>); await flush(); });
    const login = auth!.verifyOtp({ email: 'test@example.com', code: '000000' }).catch(error => error);
    await act(async () => { await auth!.logout(); });
    await act(async () => {
      complete({ data: { user, access_token: 'test-otp-session' } });
      await flush();
    });
    expect(await login).toEqual(expect.objectContaining({ message: expect.stringMatching(/cancelled/) }));
    expect(require('../api').saveToken).not.toHaveBeenCalled();
    expect(auth!.user).toBeNull();
  });
  it('delayed two-401 diagnostic cleanup cannot clear a newer successful login', async () => {
    jest.useFakeTimers();
    let complete!: (value: unknown) => void;
    const pending = new Promise(resolve => { complete = resolve; });
    const next = { id: 'new-startup-self' };
    mockStorageRead.mockImplementation(key =>
      key === 'kc_auth_clear_diag' ? pending : Promise.resolve(JSON.stringify(user)));
    mockGet.mockRejectedValue({ response: { status: 401 } });
    mockPost.mockResolvedValue({ data: { user: next, access_token: 'new-test-session' } });
    await act(async () => { tree = create(<AuthProvider><Probe /></AuthProvider>); await flush(); });
    await act(async () => { jest.advanceTimersByTime(2000); await flush(); });
    expect(mockStorageRead).toHaveBeenCalledWith('kc_auth_clear_diag');
    await act(async () => { await auth!.logout(); });
    await act(async () => { await auth!.verifyOtp({ email: 'test@example.com', code: '000000' }); });
    await act(async () => { complete(null); await flush(); });
    expect(require('../api').clearToken).toHaveBeenCalledTimes(1);
    expect(auth!.user?.id).toBe(next.id);
  });
});
