import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { Member } from '../api';
import { getFamilyCardStatus } from '../familyCardStatus';
import {
  getGpsFreshness, gpsFreshnessBoundaryDelay, GPS_STALE_AFTER_MS,
  GPS_DISPLAY_NEUTRAL_AFTER_MS as NEUTRAL, GPS_DISPLAY_OUTDATED_AFTER_MS as OUTDATED,
} from '../gpsFreshness';
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
  it.each([true, false])('uses display-only thresholds with moving=%s', moving => {
    for (const age of [0, 15 * 60_000, NEUTRAL - 1]) {
      expect(getFamilyCardStatus(member(age, moving), [], now)).toMatchObject({
        gpsWarning: null, locationTone: 'fresh', indicator: 'healthy', locationLabel: 'Location',
      });
    }
    for (const age of [NEUTRAL, OUTDATED - 1]) {
      expect(getFamilyCardStatus(member(age, moving), [], now)).toMatchObject({
        gpsWarning: null, locationTone: 'neutral', indicator: 'neutral', hasActiveProblem: false,
        locationLabel: 'Last known location',
        device: { kind: 'healthy', label: 'Device communicating' },
      });
    }
    const stale = getFamilyCardStatus(member(OUTDATED, moving), [], now);
    expect(stale).toMatchObject({
      gpsWarning: 'Location may be outdated.', locationTone: 'stale',
      indicator: 'warning', locationLabel: 'Last known location', hasActiveProblem: false,
      device: { kind: 'healthy', label: 'Device communicating' },
    });
  });
  it('never escalates GPS age alone to danger or disconnected, even after many hours', () => {
    const value = member(24 * 60 * 60_000, true);
    expect(getFamilyCardStatus(value, [], now)).toMatchObject({
      indicator: 'warning', gpsWarning: 'Location may be outdated.',
      device: { kind: 'healthy', label: 'Device communicating' },
      locationAgeLabel: 'Last location captured 24 hrs ago', hasActiveProblem: false,
    });
    expect(value.coordinate_captured_at).toBe(at(24 * 60 * 60_000));
  });
  it('keeps the fifteen-minute operational recovery threshold unchanged', () => {
    expect(GPS_STALE_AFTER_MS).toBe(15 * 60_000);
  });
  it('schedules each display boundary, stopping after the amber threshold', () => {
    expect(gpsFreshnessBoundaryDelay(at(NEUTRAL - 1), now)).toBe(1);
    expect(gpsFreshnessBoundaryDelay(at(NEUTRAL), now)).toBe(OUTDATED - NEUTRAL);
    expect(gpsFreshnessBoundaryDelay(at(OUTDATED - 1), now)).toBe(1);
    expect(gpsFreshnessBoundaryDelay(at(OUTDATED), now)).toBeNull();
  });
  it('preserves actual timestamps and last-known location instead of rewriting evidence', () => {
    const value = { ...member(NEUTRAL), location_name: 'Home', latitude: 33.1, longitude: -112.1 };
    const before = { ...value };
    expect(getFamilyCardStatus(value, [], now).locationAgeLabel).toBe('Last location captured 30 min ago');
    expect(value).toEqual(before);
  });
  it('does not clear for contact/battery alone, but clears for a newer capture', () => {
    const stale = member(OUTDATED + 60_000);
    expect(getFamilyCardStatus(stale, [], now).gpsWarning).not.toBeNull();
    expect(getFamilyCardStatus({ ...stale, coordinate_captured_at: at(0) }, [], now).gpsWarning).toBeNull();
  });
  it('keeps privacy, missing evidence and excessive future clocks neutral', () => {
    const privateMember = { ...member(OUTDATED), location_sharing_enabled: false };
    expect(getFamilyCardStatus(privateMember, [], now)).toMatchObject({ indicator: 'private', gpsWarning: null });
    for (const timestamp of [null, 'invalid', at(-6000)]) {
      expect(getGpsFreshness(timestamp, now).kind).toBe('unknown');
      expect(gpsFreshnessBoundaryDelay(timestamp, now)).toBeNull();
    }
    expect(getGpsFreshness(at(-5000), now).kind).toBe('fresh');
    expect(gpsFreshnessBoundaryDelay(at(-5000), now)).toBe(NEUTRAL + 5000);
  });
});

describe('mounted freshness deadline without any server/store update', () => {
  let rendered: ReturnType<typeof getFamilyCardStatus>;
  let tree: TestRenderer.ReactTestRenderer | undefined;
  const fixed = member(NEUTRAL - 1000);
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
  it('crosses both boundaries without new data and keeps communication independent', () => {
    act(() => { tree = TestRenderer.create(<CardEvidence />); });
    expect(rendered!.gpsWarning).toBeNull();
    act(() => jest.advanceTimersByTime(999));
    expect(rendered!.gpsWarning).toBeNull();
    act(() => jest.advanceTimersByTime(1));
    expect(rendered!.locationTone).toBe('neutral');
    expect(rendered!.gpsWarning).toBeNull();
    expect(jest.getTimerCount()).toBe(1);
    act(() => jest.advanceTimersByTime(OUTDATED - NEUTRAL - 1));
    expect(rendered!.gpsWarning).toBeNull();
    act(() => jest.advanceTimersByTime(1));
    expect(rendered!.locationTone).toBe('stale');
    expect(rendered!.gpsWarning).not.toBeNull();
    expect(rendered!.device.kind).toBe('healthy');
    expect(jest.getTimerCount()).toBe(0);
  });
  it('re-evaluates immediately on resume after suspension', () => {
    act(() => { tree = TestRenderer.create(<CardEvidence />); });
    jest.setSystemTime(now + OUTDATED);
    act(() => { for (const callback of mockListeners) callback('active'); });
    expect(rendered!.gpsWarning).not.toBeNull();
  });
  it('reschedules the second deadline when resuming in the neutral period', () => {
    act(() => { tree = TestRenderer.create(<CardEvidence />); });
    jest.setSystemTime(now + 2 * 60_000);
    act(() => { for (const callback of mockListeners) callback('active'); });
    expect(rendered!.locationTone).toBe('neutral');
    expect(rendered!.gpsWarning).toBeNull();
    expect(jest.getTimerCount()).toBe(1);
    act(() => jest.advanceTimersByTime(OUTDATED - NEUTRAL - 119_000));
    expect(rendered!.gpsWarning).toBe('Location may be outdated.');
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
