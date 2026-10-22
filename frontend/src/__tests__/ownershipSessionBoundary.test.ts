/* eslint-disable @typescript-eslint/no-require-imports */
const pending = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
};

describe('real API token mutations fence initial ownership sharing', () => {
  let api: typeof import('../api');
  let sharing: typeof import('../initialOwnershipReads');
  let secure: any;
  let stop: jest.Mock;
  beforeEach(() => {
    jest.resetModules();
    jest.doMock('react-native', () => ({ Platform: { OS: 'android' }, AppState: { currentState: 'active' } }));
    jest.doMock('@react-native-async-storage/async-storage', () => ({
      getItem: jest.fn(async () => null),
    }));
    jest.doMock('expo-secure-store', () => ({
      getItemAsync: jest.fn(async () => 'same-token'),
      setItemAsync: jest.fn(async () => {}),
      deleteItemAsync: jest.fn(async () => {}),
      AFTER_FIRST_UNLOCK: 'AFTER_FIRST_UNLOCK',
    }));
    jest.doMock('../startupDiagnostics', () => ({ markStartupMilestone: jest.fn() }));
    jest.doMock('../locationEngine', () => ({ stop: jest.fn(async () => {}) }));
    secure = require('expo-secure-store');
    stop = require('../locationEngine').stop;
    sharing = require('../initialOwnershipReads');
    api = require('../api');
  });

  it.each(['save', 'clear'])('%s invalidates on entry AND completion without changing notifications', async method => {
    const io = pending();
    const notify = jest.fn(); api.subscribeToTokenChanges(notify);
    if (method === 'save') secure.setItemAsync.mockReturnValueOnce(io.promise);
    else secure.deleteItemAsync.mockReturnValueOnce(io.promise);
    const before = sharing.ownershipSession();
    const mutation = method === 'save' ? api.saveToken('same-token') : api.clearToken();
    expect(sharing.ownershipSessionCurrent(before)).toBe(false);
    const during = sharing.ownershipSession();
    expect(during.mutating).toBe(true);
    io.resolve(); await mutation;
    expect(sharing.ownershipSessionCurrent(during)).toBe(false);
    expect(sharing.ownershipSession().mutating).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(method === 'save' ? 'same-token' : null);
    if (method === 'clear') expect(stop).toHaveBeenCalledWith('signout', 'clear_session_token');
  });

  it('failed token writes still invalidate old flights and release the mutation boundary', async () => {
    secure.setItemAsync.mockRejectedValueOnce(new Error('storage failed'));
    const before = sharing.ownershipSession();
    await expect(api.saveToken('replacement')).rejects.toThrow('storage failed');
    expect(sharing.ownershipSessionCurrent(before)).toBe(false);
    expect(sharing.ownershipSession().mutating).toBe(false);
  });

  it('overlapping mutations stay fenced until both finish', async () => {
    const a = pending(), b = pending();
    secure.setItemAsync.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const first = api.saveToken('a'), second = api.saveToken('b');
    a.resolve(); await first;
    expect(sharing.ownershipSession().mutating).toBe(true);
    b.resolve(); await second;
    expect(sharing.ownershipSession().mutating).toBe(false);
  });

  it('old flight cleanup cannot remove a replacement, and settlements are never cached', async () => {
    let resolveOld!: (v: [unknown, unknown, unknown]) => void;
    let resolveNew!: (v: [unknown, unknown, unknown]) => void;
    const loadOld = jest.fn(() => new Promise<[unknown, unknown, unknown]>(r => { resolveOld = r; }));
    const old = sharing.initialOwnershipReads('private-key', loadOld);
    const end = sharing.beginOwnershipSessionChange(); end();
    const loadNew = jest.fn(() => new Promise<[unknown, unknown, unknown]>(r => { resolveNew = r; }));
    const next = sharing.initialOwnershipReads('private-key', loadNew);
    resolveOld([1, 2, 3]); await old;
    expect(sharing.initialOwnershipReads('private-key', loadNew)).toBe(next);
    expect(loadNew).toHaveBeenCalledTimes(1);
    resolveNew([4, 5, 6]); await next;
    const loadAgain = jest.fn(async (): Promise<[unknown, unknown, unknown]> => [7, 8, 9]);
    expect(await sharing.initialOwnershipReads('private-key', loadAgain)).toEqual([7, 8, 9]);
    expect(loadAgain).toHaveBeenCalledTimes(1);
  });
});
