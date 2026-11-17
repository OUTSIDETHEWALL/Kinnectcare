/**
 * Runtime-local, INITIAL-stage pending reads only.
 * Keys contain credentials: never expose,
 * persist or send them to the diagnostic observer.
 */
import { diagnosticId, deepStage, flightStage } from './deepAsyncTrace';
import type { RequestOrigin } from './requestOrigin';
type Reads = [unknown, unknown, unknown];
const flights = new Map<string, Promise<Reads>>();
const observations = new WeakMap<Promise<Reads>, { id: string; consumers: number }>();
const liveConsumers = new WeakMap<Promise<Reads>, (() => boolean)[]>();
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
  for (const pending of flights.values()) {
    const observation = observations.get(pending);
    if (observation) flightStage(observation.id, 'map_cleared');
  }
  flights.clear(); // Do not abort reads still awaited by another consumer.
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    mutations -= 1;
    revision += 1;
    for (const pending of flights.values()) {
      const observation = observations.get(pending);
      if (observation) flightStage(observation.id, 'map_cleared');
    }
    flights.clear();
  };
}

export function initialOwnershipReads(
  key: string, load: (anyConsumerCurrent: () => boolean) => Promise<Reads>,
  diagnostic?: RequestOrigin, isCurrent: () => boolean = () => true,
): Promise<Reads> {
  const existing = flights.get(key);
  if (existing) {
    liveConsumers.get(existing)?.push(isCurrent);
    const observation = observations.get(existing);
    if (observation) {
      observation.consumers++;
      flightStage(observation.id, 'flight_joined', diagnostic, observation.consumers);
      deepStage(diagnostic, 'consumer_attached', { flight: observation.id, count: observation.consumers });
    }
    return existing;
  }
  const observation = { id: diagnosticId(), consumers: 1 };
  if (diagnostic) diagnostic.flight = observation.id;
  const consumers = [isCurrent];
  const pending = load(() => consumers.some(current => {
    try { return current(); } catch { return false; }
  }));
  flights.set(key, pending);
  liveConsumers.set(pending, consumers);
  observations.set(pending, observation);
  flightStage(observation.id, 'flight_created', diagnostic, 1);
  deepStage(diagnostic, 'consumer_attached', { flight: observation.id, count: 1 });
  const remove = () => {
    // An obsolete flight must not remove a newer same-key replacement.
    if (flights.get(key) === pending) {
      flights.delete(key);
      flightStage(observation.id, 'map_removed');
    }
  };
  void pending.then(() => { flightStage(observation.id, 'aggregate_fulfilled'); remove(); },
    () => { flightStage(observation.id, 'aggregate_rejected'); remove(); });
  return pending;
}
