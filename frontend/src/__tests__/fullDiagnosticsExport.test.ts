import {
  diagnosticsFileName,
  formatFullDiagnostics,
  readNativeSdkEvidence,
  shareFullDiagnostics,
  captureDiagnosticSource,
  redactDiagnosticCredentials,
} from '../fullDiagnosticsExport';

const mockCreate = jest.fn();
const mockWrite = jest.fn();
const mockShareAsync = jest.fn().mockResolvedValue(undefined);
jest.mock('expo-file-system', () => ({
  Paths: { cache: 'file:///cache/' },
  File: jest.fn().mockImplementation(() => ({
    uri: 'file:///cache/Kinnship_Diagnostics.txt', create: mockCreate, write: mockWrite,
  })),
}));
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn().mockResolvedValue(true),
  shareAsync: mockShareAsync,
}));
jest.mock('react-native-background-geolocation', () => ({
  __esModule: true,
  default: {
    getState: jest.fn().mockResolvedValue({
      enabled: true, heartbeatInterval: 60,
      desiredAccuracy: 10, logMaxDays: 3, disableMotionActivityUpdates: false,
      authorization: { accessToken: 'must-not-export' },
      url: 'https://example.org/private',
    }),
    logger: {
      getLog: jest.fn().mockResolvedValue('heartbeat\nAuthorization: Bearer private-token\nmotionchange'),
    },
    getProviderState: jest.fn().mockResolvedValue({ gps: true, enabled: true }),
    isPowerSaveMode: jest.fn().mockResolvedValue(false),
  },
}));

describe('one-tap diagnostics export', () => {
  beforeEach(() => jest.clearAllMocks());

  it('uses local timestamp filename and labels the full text with timezone', () => {
    const date = new Date(2026, 8, 25, 9, 26, 5);
    expect(diagnosticsFileName(date)).toBe('Kinnship_Diagnostics_2026-09-25_092605.txt');
    const text = formatFullDiagnostics({ engineLog: ['heartbeat'] }, date);
    expect(text).toContain('Timezone:');
    expect(text).toContain('"heartbeat"');
  });

  it('exports native log and safe config without native HTTP credentials', async () => {
    const evidence = await readNativeSdkEvidence();
    expect(evidence.config).toMatchObject({ enabled: true, heartbeatInterval: 60 });
    expect(evidence.state).toMatchObject({
      desiredAccuracy: 10, logMaxDays: 3, disableMotionActivityUpdates: false,
    });
    expect(evidence.provider).toEqual({ data: { gps: true, enabled: true } });
    expect(evidence.powerSave).toEqual({ data: false });
    expect(JSON.stringify(evidence)).not.toContain('must-not-export');
    expect(JSON.stringify(evidence)).not.toContain('private-token');
    expect(evidence.nativeLog).toContain('Bearer [REDACTED]');
  });

  it('retains every supplied engine, headless, recovery, battery and upload entry', () => {
    const events = Array.from({ length: 5000 }, (_, index) => ({
      index, event: ['motion', 'heartbeat', 'headless', 'http_failure', 'battery', 'recovery'][index % 6],
    }));
    const text = formatFullDiagnostics({ retainedDiagnosticBuffers: { engine: JSON.stringify(events) } }, new Date());
    expect(text).toContain('\\"index\\":4999');
    expect(text).toContain('http_failure');
    expect(text).toContain('headless');
  });

  it('redacts credentials even in raw persisted JSON without dropping evidence', () => {
    const result = redactDiagnosticCredentials({
      raw: JSON.stringify({ event: 'http_failure', headers: { Authorization: 'Bearer a-secret' }, accessToken: 'other-secret' }),
      nativeState: { license: 'private-license', heartbeatInterval: 60 },
    });
    expect(JSON.stringify(result)).not.toContain('a-secret');
    expect(JSON.stringify(result)).not.toContain('other-secret');
    expect(JSON.stringify(result)).not.toContain('private-license');
    expect(JSON.stringify(result)).toContain('http_failure');
  });

  it('preserves native Date-valued diagnostic timestamps', () => {
    expect(redactDiagnosticCredentials({ lastSeenAt: new Date('2026-10-01T12:34:56Z') }))
      .toEqual({ lastSeenAt: '2026-10-01T12:34:56.000Z' });
  });

  it('marks failed and hung readers instead of blocking the entire export', async () => {
    expect(await captureDiagnosticSource(async () => { throw new Error('reader failed'); }))
      .toEqual({ error: 'Error: reader failed' });
    jest.useFakeTimers();
    try {
      const pending = captureDiagnosticSource(() => new Promise(() => {}), 100);
      await jest.advanceTimersByTimeAsync(100);
      expect(await pending).toEqual({ error: expect.stringContaining('timed out after 100ms') });
    } finally { jest.useRealTimers(); }
  });

  it('still exports native logs when SDK state cannot be read', async () => {
    const sdk = require('react-native-background-geolocation').default;
    sdk.getState.mockRejectedValueOnce(new Error('state unavailable'));
    const evidence = await readNativeSdkEvidence();
    expect(evidence.stateError).toContain('state unavailable');
    expect(evidence.nativeLog).toContain('heartbeat');
  });

  it('writes a text file in cache and shares the file URI rather than text', async () => {
    await shareFullDiagnostics({ batteryTask: [{ event: 'background_battery_ok' }] });
    expect(mockCreate).toHaveBeenCalledWith({ overwrite: true });
    expect(mockWrite.mock.calls[0][0]).toContain('background_battery_ok');
    expect(mockShareAsync).toHaveBeenCalledWith(
      'file:///cache/Kinnship_Diagnostics.txt',
      expect.objectContaining({ mimeType: 'text/plain' }),
    );
  });
});