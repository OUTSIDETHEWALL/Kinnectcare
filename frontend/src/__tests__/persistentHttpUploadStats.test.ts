type ReadStats = () => Promise<{ attempted: number; ok: number; fail: number }>;

describe('getPersistentHttpUploadStats', () => {
  it('reads durable success and failure counts and derives attempts', async () => {
    jest.resetModules();
    const getItem = jest.fn(async (key: string) => {
      if (key === 'kc_pts_http_ok_count') return '8';
      if (key === 'kc_pts_http_fail') return '2';
      return null;
    });

    let readStats: ReadStats;
    jest.isolateModules(() => {
      jest.doMock('react-native', () => ({
        Platform: { OS: 'web' },
        AppState: { currentState: 'active' },
      }));
      jest.doMock('@react-native-async-storage/async-storage', () => ({
        getItem,
        setItem: jest.fn().mockResolvedValue(undefined),
      }));
      readStats = require('../locationEngine').getPersistentHttpUploadStats as ReadStats;
    });

    await expect(readStats!()).resolves.toEqual({
      attempted: 10,
      ok: 8,
      fail: 2,
    });
  });

  it('treats missing or malformed counters as zero', async () => {
    jest.resetModules();
    const getItem = jest.fn().mockResolvedValue('not-a-number');
    let readStats: ReadStats;

    jest.isolateModules(() => {
      jest.doMock('react-native', () => ({
        Platform: { OS: 'web' },
        AppState: { currentState: 'active' },
      }));
      jest.doMock('@react-native-async-storage/async-storage', () => ({
        getItem,
        setItem: jest.fn().mockResolvedValue(undefined),
      }));
      readStats = require('../locationEngine').getPersistentHttpUploadStats as ReadStats;
    });

    await expect(readStats!()).resolves.toEqual({
      attempted: 0,
      ok: 0,
      fail: 0,
    });
  });

  it('keeps lifetime counts when the engine log is cleared', async () => {
    jest.resetModules();
    const storage = new Map<string, string>([
      ['kc_pts_http_ok_count', '3'],
      ['kc_pts_http_fail', '1'],
    ]);
    const setItem = jest.fn(async (key: string, value: string) => {
      storage.set(key, value);
    });
    const asyncStorage = {
      getItem: jest.fn(async (key: string) => storage.get(key) ?? null),
      setItem,
      removeItem: jest.fn(async (key: string) => {
        storage.delete(key);
      }),
    };
    let readStats: ReadStats;
    let clearEngineLog: () => Promise<void>;

    jest.isolateModules(() => {
      jest.doMock('react-native', () => ({
        Platform: { OS: 'web' },
        AppState: { currentState: 'active' },
      }));
      jest.doMock('@react-native-async-storage/async-storage', () => asyncStorage);
      const locationEngine = require('../locationEngine');
      readStats = locationEngine.getPersistentHttpUploadStats as ReadStats;
      clearEngineLog = locationEngine.clearEngineLog as () => Promise<void>;
    });

    await clearEngineLog!();

    await expect(readStats!()).resolves.toEqual({
      attempted: 4,
      ok: 3,
      fail: 1,
    });
    expect(setItem).toHaveBeenCalledWith('@kinnship/location_engine_log_v1', '[]');
    expect(storage.get('kc_pts_http_ok_count')).toBe('3');
    expect(storage.get('kc_pts_http_fail')).toBe('1');
  });
});