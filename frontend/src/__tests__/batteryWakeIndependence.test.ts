/* eslint-disable @typescript-eslint/no-require-imports */
describe('WorkManager contact independence (JS boundary, not Android wake proof)', () => {
  let callback: (event: { taskId: string; timeout?: boolean }) => Promise<void>;
  let release: (value: unknown) => void;
  let configure: jest.Mock;
  let finish: jest.Mock;
  let authorize: jest.Mock;
  let recover: jest.Mock;
  let readStorage: jest.Mock;
  let writeStorage: jest.Mock;
  const originalFetch = global.fetch;
  beforeEach(() => {
    jest.resetModules();
    const storage = new Map<string, string>();
    jest.doMock('react-native', () => ({ Platform: { OS: 'android' } }));
    readStorage = jest.fn(async (key: string) => storage.get(key) ?? null);
    writeStorage = jest.fn(async (key: string, value: string) => { storage.set(key, value); });
    jest.doMock('@react-native-async-storage/async-storage', () => ({
      getItem: readStorage, setItem: writeStorage,
    }));
    finish = jest.fn();
    configure = jest.fn(async () => 2);
    jest.doMock('react-native-background-fetch', () => ({ default: {
      registerHeadlessTask: (fn: typeof callback) => { callback = fn; }, configure, finish,
      NETWORK_TYPE_ANY: 1,
    } }));
    authorize = jest.fn(async () => ({
      baseUrl: 'https://example.test', memberId: 'self', token: 'test-session',
      isCurrent: async () => true,
    }));
    jest.doMock('../androidTrackingRecovery', () => ({ authorizeDeviceContactTransport: authorize }));
    recover = jest.fn(() => new Promise(resolve => { release = resolve; }));
    jest.doMock('../locationEngine', () => ({ recoverWithOperationalReport: recover }));
    jest.doMock('react-native-background-geolocation', () => ({
      default: { getState: async () => ({ enabled: false }) },
    }));
    jest.doMock('expo-battery', () => ({
      getBatteryLevelAsync: async () => .69, getBatteryStateAsync: async () => 1,
      BatteryState: { CHARGING: 2, FULL: 3 },
    }));
    global.fetch = jest.fn(async () => ({ status: 200 })) as any;
    require('../batteryTask');
  });
  afterEach(() => { global.fetch = originalFetch; jest.resetModules(); });
  const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };

  it('accepts battery before a never-returning GPS recovery; later completion finishes once', async () => {
    const task = callback({ taskId: 'wake' });
    await flush();
    expect(recover).toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledWith('https://example.test/api/members/self/battery',
      expect.objectContaining({ method: 'PATCH' }));
    expect(finish).not.toHaveBeenCalled();
    release({ authorization: 'UNKNOWN' });
    await task;
    expect(finish).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  it('does not publish without current self-owner proof', async () => {
    authorize.mockResolvedValue(null);
    const task = callback({ taskId: 'wake' });
    await flush();
    release({ authorization: 'UNKNOWN' });
    await task;
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it.each(['read', 'write'])('never gates battery acceptance or native completion on diagnostic storage %s', async operation => {
    (operation === 'read' ? readStorage : writeStorage).mockImplementation(() => new Promise(() => {}));
    const task = callback({ taskId: 'slow-storage' });
    await flush();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(recover).toHaveBeenCalled();
    release({ authorization: 'UNKNOWN' });
    await task;
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith('slow-storage');
  });
  it('a headless timeout does not start fresh work or a new execution generation', async () => {
    await callback({ taskId: 'expired', timeout: true });
    expect(authorize).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledWith('expired');
  });
  it('an accepted battery upload survives GPS timeout without duplicate completion or publication', async () => {
    const task = callback({ taskId: 'gps-pending' });
    await flush();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    await callback({ taskId: 'gps-pending', timeout: true });
    expect(finish).toHaveBeenCalledTimes(1);
    release({ authorization: 'UNKNOWN' });
    await task; await flush();
    expect(finish).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  it('can schedule the battery job without configuring GPS', async () => {
    await require('../batteryTask').configureBatteryTask();
    expect(configure).toHaveBeenCalledWith(expect.objectContaining({
      enableHeadless: true, stopOnTerminate: false, startOnBoot: true,
    }), expect.any(Function), expect.any(Function));
    expect(recover).not.toHaveBeenCalled();
  });
});
