const mockMark = jest.fn();
jest.mock('../startupDiagnostics', () => ({ markStartupMilestone: (...args: any[]) => mockMark(...args) }));

import { beginStartupApiTiming, startStartupApiTiming } from '../startupApiTiming';

describe('bounded startup API observation', () => {
  let close: () => void;
  beforeEach(() => { jest.useFakeTimers(); mockMark.mockReset(); close = beginStartupApiTiming(); });
  afterEach(() => { close(); jest.useRealTimers(); });

  it('claims only the first request for each allowlisted endpoint, not arbitrary URLs or tracking uploads', () => {
    for (const endpoint of ['/auth/me', '/members', '/summary', '/alerts']) {
      expect(startStartupApiTiming(endpoint)).not.toBeNull();
      expect(startStartupApiTiming(endpoint)).toBeNull();
    }
    for (const endpoint of ['/me/preferences', '/members/private-id/location', '/alerts?secret=value']) {
      expect(startStartupApiTiming(endpoint)).toBeNull();
    }
    expect(jest.getTimerCount()).toBe(4);
    close();
    expect(jest.getTimerCount()).toBe(0);
    expect(startStartupApiTiming('/members')).toBeNull();
  });

  it('bounds sampling and eligibility even for a request that never settles', () => {
    const trace = startStartupApiTiming('/members')!;
    jest.advanceTimersByTime(16_000);
    expect(jest.getTimerCount()).toBe(0);
    expect(startStartupApiTiming('/summary')).toBeNull();
    trace.finish('failed');
    expect(mockMark).toHaveBeenCalledWith('startup_api_stage_timing', expect.objectContaining({
      probeLimited: true, probeCoveredWholeRequest: false, totalMs: 16_000,
    }));
  });

  it('new roots get a new observation without an old cleanup closing the replacement', () => {
    startStartupApiTiming('/members');
    const nextClose = beginStartupApiTiming();
    expect(jest.getTimerCount()).toBe(0);
    close();
    const next = startStartupApiTiming('/members')!;
    expect(next).not.toBeNull();
    next.finish('completed', 200);
    next.finish('completed', 200);
    expect(mockMark).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    nextClose();
  });

  it('reports actual timer delivery lag, not total network wait or accumulated harmless drift', () => {
    const trace = startStartupApiTiming('/members')!;
    // Advance the observed clock without dispatching a due JS callback.
    const now = performance.now();
    const spy = jest.spyOn(performance, 'now').mockReturnValue(now + 1_000);
    trace.finish('completed', 200);
    expect(mockMark).toHaveBeenCalledWith('startup_api_stage_timing', expect.objectContaining({
      totalMs: 1_000, maxJsTimerDelayMs: 750, timerSamples: 0,
    }));
    spy.mockRestore();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('contains logging failures and stops timers without changing the request outcome', () => {
    const trace = startStartupApiTiming('/members')!;
    mockMark.mockImplementation(() => { throw new Error('diagnostic failure'); });
    expect(() => trace.finish('completed', 200)).not.toThrow();
    expect(jest.getTimerCount()).toBe(0);
  });
});
