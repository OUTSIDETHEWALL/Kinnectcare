import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { Member } from '../api';
import { getFamilyCardStatus } from '../familyCardStatus';
import { getGpsFreshness, gpsFreshnessBoundaryDelay, GPS_STALE_AFTER_MS } from '../gpsFreshness';
import { useGpsFreshnessClock } from '../useGpsFreshnessClock';

const mockListeners = new Set<(state: string) => void>();
jest.mock('react-native', () => ({
  AppState: {
    addEventListener: (_event: string, callback: (state: string) => void) => {
      mockListeners.add(callback);
      return { remove: () => mockListeners.delete(callback) };
    },
  },
}));

const now = Date.parse('2026-11-23T19:41:42Z');
const at = (age: number) => new Date(now - age).toISOString();
function member(age: number, moving = false): Member {
  return {
    id: 'member', user_id: 'owner', status: 'healthy', is_moving: moving,
    coordinate_captured_at: at(age), device_presence_at: at(0), last_seen: at(0),
    battery_updated_at: at(0), battery_level: 0.64, location_sharing_enabled: true,
  } as Member;
}

describe('GPS freshness is separate from communication and motion', () => {
  it.each([true, false])('begins at exactly fifteen minutes with moving=%s', moving => {
    const fresh = getFamilyCardStatus(member(GPS_STALE_AFTER_MS - 1, moving), [], now);
    expect(fresh.gpsWarning).toBeNull();
    expect(fresh.indicator).toBe('healthy');
    const stale = getFamilyCardStatus(member(GPS_STALE_AFTER_MS, moving), [], now);
    expect(stale).toMatchObject({
      gpsWarning: 'GPS location stale — last known location',
      indicator: 'warning', locationLabel: 'Last known location', hasActiveProblem: true,
      device: { kind: 'healthy', label: 'Device communicating' },
    });
  });
  it('does not clear for contact/battery alone, but clears for a newer capture', () => {
    const stale = member(43 * 60_000);
    expect(getFamilyCardStatus(stale, [], now).gpsWarning).not.toBeNull();
    expect(getFamilyCardStatus({ ...stale, coordinate_captured_at: at(0) }, [], now).gpsWarning).toBeNull();
  });
  it('keeps privacy, missing evidence and excessive future clocks neutral', () => {
    const privateMember = { ...member(GPS_STALE_AFTER_MS), location_sharing_enabled: false };
    expect(getFamilyCardStatus(privateMember, [], now)).toMatchObject({ indicator: 'private', gpsWarning: null });
    for (const timestamp of [null, 'invalid', at(-6000)]) {
      expect(getGpsFreshness(timestamp, now).kind).toBe('unknown');
      expect(gpsFreshnessBoundaryDelay(timestamp, now)).toBeNull();
    }
    expect(getGpsFreshness(at(-5000), now).kind).toBe('fresh');
    expect(gpsFreshnessBoundaryDelay(at(-5000), now)).toBe(GPS_STALE_AFTER_MS + 5000);
  });
});

describe('mounted freshness deadline without any server/store update', () => {
  let rendered: ReturnType<typeof getFamilyCardStatus>;
  let tree: TestRenderer.ReactTestRenderer | undefined;
  const fixed = member(GPS_STALE_AFTER_MS - 1000);
  function CardEvidence({ value = fixed }: { value?: Member }) {
    const clock = useGpsFreshnessClock(value.coordinate_captured_at, value.location_sharing_enabled !== false);
    rendered = getFamilyCardStatus(value, [], clock);
    return null;
  }
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(() => {
    if (tree) act(() => tree!.unmount());
    tree = undefined;
    expect(mockListeners.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });
  it('turns stale once at the deadline and keeps communication independent', () => {
    act(() => { tree = TestRenderer.create(<CardEvidence />); });
    expect(rendered!.gpsWarning).toBeNull();
    act(() => jest.advanceTimersByTime(999));
    expect(rendered!.gpsWarning).toBeNull();
    act(() => jest.advanceTimersByTime(1));
    expect(rendered!.gpsWarning).not.toBeNull();
    expect(rendered!.device.kind).toBe('healthy');
    expect(jest.getTimerCount()).toBe(0);
  });
  it('re-evaluates immediately on resume after suspension', () => {
    act(() => { tree = TestRenderer.create(<CardEvidence />); });
    jest.setSystemTime(now + 2 * 60_000);
    act(() => { for (const callback of mockListeners) callback('active'); });
    expect(rendered!.gpsWarning).not.toBeNull();
  });
  it('cancels the old deadline when coordinates refresh or sharing is off', () => {
    act(() => { tree = TestRenderer.create(<CardEvidence />); });
    act(() => tree!.update(<CardEvidence value={member(0)} />));
    act(() => jest.advanceTimersByTime(1000));
    expect(rendered!.gpsWarning).toBeNull();
    act(() => tree!.update(<CardEvidence value={{ ...fixed, location_sharing_enabled: false }} />));
    expect(jest.getTimerCount()).toBe(0);
    expect(rendered!.indicator).toBe('private');
  });
});
