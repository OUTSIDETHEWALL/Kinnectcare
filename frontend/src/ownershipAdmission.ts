/**
 * Runtime-local SDK ownership transport admission, not response sharing.
 * Two permits are a controlled candidate setting, not a production optimum.
 * Queues contain callbacks only; no credentials, responses or cached verdicts.
 */
export type OwnershipPriority = 'motion' | 'other';
type Entry = { priority: OwnershipPriority; start: () => void };
const queues: Record<OwnershipPriority, Entry[]> = { motion: [], other: [] };
const LIMIT = 2;
let active = 0;
let motionStreak = 0;
let peak = 0;
let submitted = 0;
let completed = 0;
let maxWaitMs = 0;
const clock = () => globalThis.performance?.now?.() ?? Date.now();

function drain() {
  while (active < LIMIT && (queues.motion.length || queues.other.length)) {
    // FIFO within a class; at most two motion admissions may overtake other work.
    const priority = queues.motion.length && (!queues.other.length || motionStreak < 2)
      ? 'motion' : 'other';
    motionStreak = priority === 'motion' ? Math.min(2, motionStreak + 1) : 0;
    const entry = queues[priority].shift()!;
    active++;
    peak = Math.max(peak, active);
    entry.start();
  }
}

export function ownershipAdmissionStats() {
  return { budget: LIMIT, active, queued: queues.motion.length + queues.other.length,
    peak, submitted, completed, maxWaitMs };
}

export function admitOwnershipHttp<T>(
  priority: OwnershipPriority, run: () => Promise<T>,
): Promise<T> {
  const queuedAt = clock();
  submitted++;
  return new Promise<T>((resolve, reject) => {
    queues[priority].push({ priority, start: () => {
      maxWaitMs = Math.max(maxWaitMs, Math.max(0, clock() - queuedAt));
      // Each HTTP helper owns its permit until THAT helper settles, not until
      // a sibling or Promise.all settles. No lifecycle/GPS FIFO is held here.
      void Promise.resolve().then(run).then(resolve, reject).finally(() => {
        active--;
        completed++;
        drain();
      });
    } });
    drain();
  });
}
