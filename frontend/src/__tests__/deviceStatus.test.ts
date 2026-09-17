import { getDeviceCommunicationStatus } from '../deviceStatus';

const NOW = new Date('2026-09-17T12:00:00.000Z').getTime();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

describe('caregiver device communication status', () => {
  it('keeps an ordinarily sleeping stationary device healthy for one hour', () => {
    expect(getDeviceCommunicationStatus({
      device_presence_at: ago(59),
      last_seen: ago(120),
      is_moving: false,
    }, NOW).kind).toBe('healthy');
  });

  it('classifies stationary communication as delayed and then not responding', () => {
    expect(getDeviceCommunicationStatus({
      device_presence_at: ago(61),
      last_seen: ago(61),
      is_moving: false,
    }, NOW).kind).toBe('delayed');
    expect(getDeviceCommunicationStatus({
      device_presence_at: ago(241),
      last_seen: ago(241),
      is_moving: false,
    }, NOW).kind).toBe('not-responding');
  });

  it('returns to healthy as soon as communication resumes', () => {
    const stale = { device_presence_at: ago(300), last_seen: ago(300), is_moving: false };
    const resumed = { ...stale, device_presence_at: ago(1) };
    expect(getDeviceCommunicationStatus(stale, NOW).kind).toBe('not-responding');
    expect(getDeviceCommunicationStatus(resumed, NOW).kind).toBe('healthy');
  });
});