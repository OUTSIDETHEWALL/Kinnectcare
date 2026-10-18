const mockGet = jest.fn();
let mockTokenChanged: () => void;
jest.mock('../api', () => ({
  api: { get: (...args: any[]) => mockGet(...args) },
  subscribeToTokenChanges: (listener: () => void) => { mockTokenChanged = listener; },
}));
jest.mock('../refreshPipelineLog', () => ({ logPipelineEvent: jest.fn() }));
jest.mock('../pipelineSnapshot', () => ({ observeStoreCommit: jest.fn() }));

import { getMembersResponse, invalidateMembersResponse } from '../membersResponse';
import * as store from '../store/memberStore';

function deferred() {
  let resolve!: (value: any) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('overlapping Family members response', () => {
  beforeEach(() => { store.clearAll(); mockGet.mockReset(); });

  it.each(['root-first', 'dashboard-first'])('shares raw response and canonical publication (%s)', async order => {
    const response = deferred();
    mockGet.mockReturnValue(response.promise);
    const raw = { data: [{ id: 'member', name: 'Test' }], status: 200, headers: { date: 'server-date' } };
    let root!: Promise<any>;
    let dashboard!: Promise<any>;
    if (order === 'root-first') { root = store.fetchAll(); dashboard = getMembersResponse(); }
    else { dashboard = getMembersResponse(); root = store.fetchAll(); }
    expect(mockGet).toHaveBeenCalledTimes(1);
    response.resolve(raw);
    expect(await dashboard).toBe(raw);
    expect(await root).toEqual(raw.data);
    expect(store.getAllMembers()).toEqual(raw.data);
    // A later refresh really fetches; this is not a response cache.
    const fresh = getMembersResponse();
    expect(mockGet).toHaveBeenCalledTimes(2);
    await fresh;
  });

  it('preserves rejection for Dashboard while the store retains its existing fallback', async () => {
    const response = deferred();
    mockGet.mockReturnValueOnce(response.promise).mockResolvedValue({ data: [], headers: {}, status: 200 });
    const root = store.fetchAll();
    const dashboard = expect(getMembersResponse()).rejects.toThrow('network failed');
    response.reject(new Error('network failed'));
    await dashboard;
    expect(await root).toEqual([]);
    await getMembersResponse();
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it.each(['token change', 'store clear'])('does not reuse an old flight after %s or let its completion clear the replacement', async boundary => {
    const old = deferred();
    const replacement = deferred();
    mockGet.mockReturnValueOnce(old.promise).mockReturnValueOnce(replacement.promise);
    const first = getMembersResponse();
    if (boundary === 'token change') mockTokenChanged();
    else store.clearAll();
    const second = getMembersResponse();
    expect(second).not.toBe(first);
    old.resolve({ data: [], headers: {} });
    await first;
    expect(getMembersResponse()).toBe(second);
    expect(mockGet).toHaveBeenCalledTimes(2);
    replacement.resolve({ data: [], headers: {} });
    await second;
  });

  afterAll(invalidateMembersResponse);
});
