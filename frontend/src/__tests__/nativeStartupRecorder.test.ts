let mockModule: unknown = null;

jest.mock('expo', () => ({
  requireOptionalNativeModule: jest.fn(() => mockModule),
}));

describe('native startup recorder adapter', () => {
  beforeEach(() => {
    jest.resetModules();
    mockModule = null;
  });

  test('is safe when the bridge is unavailable', async () => {
    const recorder = await import('../nativeStartupRecorder');
    expect(recorder.recordNativeStartupCheckpoint('native_test')).toBe(false);
    expect(recorder.readNativeStartupCheckpoints()).toEqual({ records: [] });
    expect(recorder.clearNativeStartupCheckpoints()).toBe(false);
  });

  test('uses the blocking bridge method synchronously', async () => {
    const record = jest.fn(() => true);
    mockModule = { record, read: () => '{"records":[]}', clear: () => true };
    const recorder = await import('../nativeStartupRecorder');
    expect(recorder.recordNativeStartupCheckpoint('native_test', { authenticated: true })).toBe(true);
    expect(record).toHaveBeenCalledWith('native_test', '{"authenticated":true}');
    expect(record.mock.results[0].value).toBe(true);
  });

  test('parses records and returns them in sequence order', async () => {
    mockModule = {
      record: () => true,
      clear: () => true,
      read: () => JSON.stringify({ records: [
        { wallClockMs: 2, elapsedRealtimeMs: 2, runId: 'r', sequence: 2, event: 'second' },
        { wallClockMs: 1, elapsedRealtimeMs: 1, runId: 'r', sequence: 1, event: 'first' },
      ] }),
    };
    const { readNativeStartupCheckpoints } = await import('../nativeStartupRecorder');
    expect(readNativeStartupCheckpoints().records.map((entry) => entry.event)).toEqual(['first', 'second']);
  });

  test('isolates native bridge failures', async () => {
    mockModule = {
      record: () => { throw new Error('disk failure'); },
      read: () => { throw new Error('disk failure'); },
      clear: () => { throw new Error('disk failure'); },
    };
    const recorder = await import('../nativeStartupRecorder');
    expect(recorder.recordNativeStartupCheckpoint('native_test')).toBe(false);
    expect(recorder.readNativeStartupCheckpoints()).toEqual({ records: [] });
    expect(recorder.clearNativeStartupCheckpoints()).toBe(false);
  });
});