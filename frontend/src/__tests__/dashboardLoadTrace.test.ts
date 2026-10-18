import { createDashboardLoadTrace } from '../dashboardLoadTrace';
import * as log from '../dashboardLoadLog';

jest.mock('../dashboardLoadLog', () => ({
  startLoad: jest.fn(), markGetSent: jest.fn(), markGetReceived: jest.fn(),
  markSetState: jest.fn(), markError: jest.fn(), recordStalenessTrigger: jest.fn(),
}));
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
describe('non-blocking dashboard trace', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const method of Object.values(log)) {
      if (jest.isMockFunction(method)) method.mockReset().mockResolvedValue(undefined);
    }
  });
  afterEach(() => jest.restoreAllMocks());
  it('does not wait for persistence, but retains event order and call-site times', async () => {
    let release!: (id: string) => void;
    (log.startLoad as jest.Mock).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1000);
    const trace = createDashboardLoadTrace('focus');
    clock.mockReturnValue(1100);
    expect(trace.sent()).toBeUndefined();
    clock.mockReturnValue(1200);
    trace.received({ status: 200, raw_members: [] });
    clock.mockReturnValue(1300);
    trace.committed();
    expect(log.markGetSent).not.toHaveBeenCalled();
    clock.mockReturnValue(20000);
    release('load-id'); await flush();
    expect(log.startLoad).toHaveBeenCalledWith('focus', 1000);
    expect(log.markGetSent).toHaveBeenCalledWith('load-id', 1100, expect.any(Function));
    expect(log.markGetReceived).toHaveBeenCalledWith('load-id', { status: 200, raw_members: [] }, 1200, expect.any(Function));
    expect(log.markSetState).toHaveBeenCalledWith('load-id', 1300, expect.any(Function));
  });
  it('discards queued family evidence after the load/session lifetime changes', async () => {
    let release!: (id: string) => void;
    let current = true;
    (log.startLoad as jest.Mock).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const trace = createDashboardLoadTrace('focus', () => current);
    trace.received({ status: 200, raw_members: [{ id: 'test-member' }] });
    trace.stale('test-member'); trace.committed();
    current = false; release('obsolete-load'); await flush();
    expect(log.markGetReceived).not.toHaveBeenCalled();
    expect(log.recordStalenessTrigger).not.toHaveBeenCalled();
    expect(log.markSetState).not.toHaveBeenCalled();
  });
  it('contains failed optional persistence without an unhandled rejection', async () => {
    (log.startLoad as jest.Mock).mockRejectedValue(new Error('storage unavailable'));
    const trace = createDashboardLoadTrace('focus');
    trace.sent(); trace.failed('network failure'); await flush();
    expect(log.markGetSent).not.toHaveBeenCalled();
  });
});
