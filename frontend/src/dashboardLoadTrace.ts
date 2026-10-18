import * as log from './dashboardLoadLog';

/**
 * Ordered best-effort persistence, never a dependency of fetching/rendering.
 * Capture timestamps at the call site, not when a slow storage queue drains.
 */
export function createDashboardLoadTrace(trigger: log.DashboardLoadTrigger, isCurrent: () => boolean = () => true) {
  let writes: Promise<string | null> = log.startLoad(trigger, Date.now()).catch(() => null);
  const enqueue = (work: (id: string, at: number) => Promise<unknown>) => {
    const at = Date.now();
    writes = writes.then(async id => {
      if (id && isCurrent()) await work(id, at);
      return id;
    }).catch(() => null);
  };
  return {
    sent: () => enqueue((id, at) => log.markGetSent(id, at, isCurrent)),
    received: (response: Parameters<typeof log.markGetReceived>[1]) =>
      enqueue((id, at) => log.markGetReceived(id, response, at, isCurrent)),
    committed: () => enqueue((id, at) => log.markSetState(id, at, isCurrent)),
    failed: (error: string) => enqueue(id => log.markError(id, error, isCurrent)),
    stale: (member: string) => enqueue(id => log.recordStalenessTrigger(id, member, isCurrent)),
  };
}
