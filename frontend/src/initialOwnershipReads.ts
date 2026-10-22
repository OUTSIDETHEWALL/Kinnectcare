/**
 * Runtime-local, pending reads only. Keys contain credentials: never expose,
 * persist or send them to the diagnostic observer.
 */
type Reads = [unknown, unknown, unknown];
const flights = new Map<string, Promise<Reads>>();
let revision = 0;
let mutations = 0;
export type OwnershipSession = { revision: number; mutating: boolean };

export function ownershipSession(): OwnershipSession {
  return { revision, mutating: mutations !== 0 };
}

export function ownershipSessionCurrent(captured: OwnershipSession): boolean {
  return !captured.mutating && mutations === 0 && revision === captured.revision;
}

/** Fence even same-token logout/login and reads during asynchronous token IO. */
export function beginOwnershipSessionChange(): () => void {
  revision += 1;
  mutations += 1;
  flights.clear(); // Do not abort reads still awaited by another consumer.
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    mutations -= 1;
    revision += 1;
    flights.clear();
  };
}

export function initialOwnershipReads(key: string, load: () => Promise<Reads>): Promise<Reads> {
  const existing = flights.get(key);
  if (existing) return existing;
  const pending = load();
  flights.set(key, pending);
  const remove = () => {
    // An obsolete flight must not remove a newer same-key replacement.
    if (flights.get(key) === pending) flights.delete(key);
  };
  void pending.then(remove, remove);
  return pending;
}
