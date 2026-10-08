const mockIsAvailable = jest.fn();
const mockStartTransistor = jest.fn();
const mockStartLegacy = jest.fn();
const mockStopLegacy = jest.fn();
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));

jest.mock('../locationEngine', () => ({
  isAvailable: (...args: unknown[]) => mockIsAvailable(...args),
  start: (...args: unknown[]) => mockStartTransistor(...args),
}));

jest.mock('../backgroundLocation', () => ({
  startBackgroundLocation: (...args: unknown[]) => mockStartLegacy(...args),
  stopBackgroundLocation: (...args: unknown[]) => mockStopLegacy(...args),
}));

import {
  ensureTransistorLocationEngine,
  needsLocationEngineBootstrap,
  startLegacyLocationFallback,
} from '../locationEngineExclusivity';
import { Platform as mockPlatform } from 'react-native';

describe('background-location engine exclusivity', () => {
  beforeEach(() => {
    mockPlatform.OS = 'android';
    jest.clearAllMocks();
    mockStartTransistor.mockResolvedValue('background-ready');
    mockStartLegacy.mockResolvedValue(true);
    mockStopLegacy.mockResolvedValue(true);
  });

  it('preserves iOS false when legacy tracking cannot be stopped', async () => {
    mockPlatform.OS = 'ios';
    mockIsAvailable.mockReturnValue(true);
    mockStopLegacy.mockResolvedValue(false);
    expect(await ensureTransistorLocationEngine({
      backendBaseUrl: 'https://example.test', memberId: 'member-1', jwt: 'jwt',
    })).toBe(false);
    expect(mockStartTransistor).not.toHaveBeenCalled();
  });

  it('preserves iOS successful-adapter semantics after an unsuccessful SDK attempt', async () => {
    mockPlatform.OS = 'ios';
    mockIsAvailable.mockReturnValue(true);
    mockStartTransistor.mockResolvedValue('failed');
    expect(await ensureTransistorLocationEngine({
      backendBaseUrl: 'https://example.test', memberId: 'member-1', jwt: 'jwt',
    })).toBe(true);
  });

  it('stops a persisted legacy task before starting Transistor', async () => {
    mockIsAvailable.mockReturnValue(true);
    const order: string[] = [];
    mockStopLegacy.mockImplementation(async () => {
      order.push('stop-legacy');
      return true;
    });
    mockStartTransistor.mockImplementation(async () => { order.push('start-transistor'); return 'background-ready'; });

    const started = await ensureTransistorLocationEngine({
      backendBaseUrl: 'https://example.test',
      memberId: 'member-1',
      jwt: 'jwt',
    });

    expect(started).toBe('background-ready');
    expect(order).toEqual(['stop-legacy', 'start-transistor']);
    expect(mockStartLegacy).not.toHaveBeenCalled();
  });

  it('uses Expo Location only when Transistor is unavailable', async () => {
    mockIsAvailable.mockReturnValue(false);

    const started = await startLegacyLocationFallback('member-1');

    expect(started).toBe(true);
    expect(mockStartLegacy).toHaveBeenCalledTimes(1);
    expect(mockStartLegacy).toHaveBeenCalledWith('member-1', false);
    expect(mockStopLegacy).not.toHaveBeenCalled();
    expect(mockStartTransistor).not.toHaveBeenCalled();
  });

  it('never starts the legacy task when Transistor is available', async () => {
    mockIsAvailable.mockReturnValue(true);

    const started = await startLegacyLocationFallback('member-1');

    expect(started).toBe(false);
    expect(mockStopLegacy).toHaveBeenCalledTimes(1);
    expect(mockStartLegacy).not.toHaveBeenCalled();
  });

  it('does not start Transistor when the legacy task cannot be confirmed stopped', async () => {
    mockIsAvailable.mockReturnValue(true);
    mockStopLegacy.mockResolvedValue(false);

    const started = await ensureTransistorLocationEngine({
      backendBaseUrl: 'https://example.test',
      memberId: 'member-1',
      jwt: 'jwt',
    });

    expect(started).toBe('failed');
    expect(mockStartTransistor).not.toHaveBeenCalled();
  });

  it('coalesces concurrent bootstrap reconciliation into one start', async () => {
    mockIsAvailable.mockReturnValue(true);
    let releaseStop: (() => void) | undefined;
    mockStopLegacy.mockImplementation(
      () => new Promise<boolean>((resolve) => {
        releaseStop = () => resolve(true);
      }),
    );

    const first = ensureTransistorLocationEngine({
      backendBaseUrl: 'https://example.test',
      memberId: 'member-1',
      jwt: 'jwt',
    });
    const second = ensureTransistorLocationEngine({
      backendBaseUrl: 'https://example.test',
      memberId: 'member-1',
      jwt: 'jwt',
    });
    releaseStop?.();
    await Promise.all([first, second]);

    expect(mockStopLegacy).toHaveBeenCalledTimes(1);
    expect(mockStartLegacy).not.toHaveBeenCalled();
    expect(mockStartTransistor).toHaveBeenCalledTimes(1);
  });

  it('serializes different member configurations and applies the newer one last', async () => {
    mockIsAvailable.mockReturnValue(true);
    let releaseFirstStop: (() => void) | undefined;
    mockStopLegacy
      .mockImplementationOnce(
        () => new Promise<boolean>((resolve) => {
          releaseFirstStop = () => resolve(true);
        }),
      )
      .mockResolvedValueOnce(true);

    const firstConfig = {
      backendBaseUrl: 'https://example.test',
      memberId: 'member-1',
      jwt: 'jwt-1',
    };
    const secondConfig = {
      backendBaseUrl: 'https://example.test',
      memberId: 'member-2',
      jwt: 'jwt-2',
    };

    const first = ensureTransistorLocationEngine(firstConfig);
    const second = ensureTransistorLocationEngine(secondConfig);
    releaseFirstStop?.();
    await Promise.all([first, second]);

    expect(mockStopLegacy).toHaveBeenCalledTimes(2);
    expect(mockStartTransistor.mock.calls).toEqual([
      [firstConfig],
      [secondConfig],
    ]);
  });

  it('does not bootstrap the same user twice', () => {
    expect(needsLocationEngineBootstrap(null, 'user-1')).toBe(true);
    expect(needsLocationEngineBootstrap('user-1', 'user-1')).toBe(false);
    expect(needsLocationEngineBootstrap('user-1', 'user-2')).toBe(true);
  });

  it('keeps the Me toggle on the guarded fallback path', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../app/(tabs)/me.tsx'),
      'utf8',
    );

    expect(source).toContain('startLegacyLocationFallback(memberId)');
    expect(source).not.toContain('startBackgroundLocation(memberId)');
  });

  it('guards every direct legacy start, including SOS cadence changes', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../backgroundLocation.ts'),
      'utf8',
    );
    const startFunction = source.slice(
      source.indexOf('export async function startBackgroundLocation'),
      source.indexOf('/** Stop the foreground service'),
    );

    expect(startFunction).toContain('if (locationEngine.isAvailable())');
    expect(startFunction).toContain('await stopBackgroundLocation()');
    expect(startFunction.indexOf('if (locationEngine.isAvailable())'))
      .toBeLessThan(startFunction.indexOf('Location.startLocationUpdatesAsync'));
  });
});