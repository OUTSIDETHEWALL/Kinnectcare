jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: { currentState: 'active' },
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

import * as SecureStore from 'expo-secure-store';
import { addForegroundPresenceHeader, api } from '../api';
import { selectPresenceTimestamp } from '../timeFormat';

describe('device presence request classification', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('classifies an existing authenticated axios request once, without another request', async () => {
    (SecureStore.getItemAsync as jest.Mock).mockResolvedValue('jwt');
    const adapter = jest.fn().mockResolvedValue({
      data: {}, status: 200, statusText: 'OK', headers: {}, config: {},
    });

    await api.get('/presence-contract', { adapter });

    expect(adapter).toHaveBeenCalledTimes(1);
    expect(adapter.mock.calls[0][0].headers['X-Kinnship-Presence-Source']).toBe('foreground-api');
    expect(adapter.mock.calls[0][0].headers.Authorization).toBe('Bearer jwt');
  });

  it('marks authenticated active requests without replacing explicit telemetry sources', () => {
    const normal: any = { headers: {} };
    addForegroundPresenceHeader(normal, 'jwt', 'active');
    expect(normal.headers['X-Kinnship-Presence-Source']).toBe('foreground-api');

    const telemetry: any = {
      headers: { 'X-Kinnship-Presence-Source': 'location-upload' },
    };
    addForegroundPresenceHeader(telemetry, 'jwt', 'active');
    expect(telemetry.headers['X-Kinnship-Presence-Source']).toBe('location-upload');
  });

  it('does not mark requests without a token or while backgrounded', () => {
    const noToken: any = { headers: {} };
    const background: any = { headers: {} };
    addForegroundPresenceHeader(noToken, null, 'active');
    addForegroundPresenceHeader(background, 'jwt', 'background');
    expect(noToken.headers).not.toHaveProperty('X-Kinnship-Presence-Source');
    expect(background.headers).not.toHaveProperty('X-Kinnship-Presence-Source');
  });

  it('removes a telemetry marker when the axios request has no auth token', async () => {
    (SecureStore.getItemAsync as jest.Mock).mockResolvedValue(null);
    const adapter = jest.fn().mockResolvedValue({
      data: {}, status: 200, statusText: 'OK', headers: {}, config: {},
    });

    await api.put('/members/member-1/location', {}, {
      headers: { 'X-Kinnship-Presence-Source': 'location-upload' },
      adapter,
    });

    expect(adapter.mock.calls[0][0].headers['X-Kinnship-Presence-Source']).toBeUndefined();
  });
});

describe('selectPresenceTimestamp', () => {
  it('prefers a valid device presence timestamp', () => {
    expect(selectPresenceTimestamp({
      device_presence_at: '2025-01-02T03:04:05.000Z',
      last_seen: '2025-01-01T03:04:05.000Z',
    })).toBe('2025-01-02T03:04:05.000Z');
  });

  it('falls back from absent or malformed presence to a valid last_seen', () => {
    expect(selectPresenceTimestamp({
      device_presence_at: 'not-a-date',
      last_seen: '2025-01-01T03:04:05.000Z',
    })).toBe('2025-01-01T03:04:05.000Z');
    expect(selectPresenceTimestamp({ last_seen: 'not-a-date' })).toBeNull();
    expect(selectPresenceTimestamp(null)).toBeNull();
  });
});