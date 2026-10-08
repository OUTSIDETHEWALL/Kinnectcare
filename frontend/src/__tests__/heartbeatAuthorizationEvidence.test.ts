import { computeHealthItems } from '../healthCheck';
import type { EngineLogEvent } from '../locationEngine';

const now = 1_800_000_000_000;
const event = (name: string, detail: any, age = 1000): EngineLogEvent => ({
  seq: 1, src: 'engine', at: now - age, event: name, detail,
});

describe('actual background monitoring evidence', () => {
  it('termination callbacks never count as a heartbeat', () => {
    const items = computeHealthItems([event('headless_task_invoked', { eventName: 'terminate' })], now);
    expect(items[1].label).toBe('Background heartbeat: waiting for first event');
    expect(items[1].status).toBe('unknown');
  });
  it.each(['sdk_onHeartbeat', 'headless_task_invoked'])('accepts an actual %s heartbeat', name => {
    const items = computeHealthItems([event(name, { eventName: 'heartbeat' })], now);
    expect(items[1].status).toBe('ok');
  });
  it('a later terminate cannot hide an old real heartbeat', () => {
    const items = computeHealthItems([
      event('sdk_onHeartbeat', {}, 15 * 60_000),
      event('headless_task_invoked', { eventName: 'terminate' }),
    ], now);
    expect(items[1].status).toBe('error');
  });
  it.each(['foreground-only', 'denied', 'failed'])('does not label %s startup as healthy background monitoring', outcome => {
    const items = computeHealthItems([
      event('sdk_onEnabledChange', { enabled: true }),
      event('startup_outcome', { outcome }),
    ], now);
    expect(items[0].status).not.toBe('ok');
    expect(items[0].label).not.toBe('Background service running');
  });
  it('recognizes verified background startup before an enabled-change event arrives', () => {
    const items = computeHealthItems([event('startup_outcome', { outcome: 'background-ready' })], now);
    expect(items[0].status).toBe('ok');
  });
});
