const mockStorage = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn((key: string) => Promise.resolve(mockStorage.get(key) ?? null)),
  setItem: jest.fn((key: string, value: string) => {
    mockStorage.set(key, value);
    return Promise.resolve();
  }),
}));

describe('startup diagnostics', () => {
  beforeEach(() => {
    jest.resetModules();
    mockStorage.clear();
  });

  test('serializes concurrent startup events in chronological sequence', async () => {
    const { logStartupEvent, readStartupDiagnostics } = await import('../startupDiagnostics');

    logStartupEvent({
      phase: 'session_restore',
      event: 'token_read_completed',
      outcome: 'token_present',
    });
    logStartupEvent({
      phase: 'root_navigation_decision',
      event: 'root_navigation_evaluated',
      route: '/(tabs)/dashboard',
      reason: 'authenticated_start_route',
      outcome: 'navigate',
    });

    const entries = await readStartupDiagnostics();
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(entries.map((entry) => entry.event)).toEqual([
      'javascript_runtime_started',
      'token_read_completed',
      'root_navigation_evaluated',
    ]);
    expect(new Set(entries.map((entry) => entry.runId)).size).toBe(1);
  });
});