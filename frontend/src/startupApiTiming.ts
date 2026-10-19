import { markStartupMilestone } from './startupDiagnostics';

// Observe only the first core batch of each mounted AuthProvider. No token,
// account, URL, payload or error text is retained. Nothing awaits this observer.
const ENDPOINTS = new Set(['/auth/me', '/members', '/summary', '/alerts']);
const WINDOW_MS = 15_000;
const SAMPLE_MS = 250;
let nextObservation = 0;
let nextRequest = 0;
type Window = { id: number; until: number; claimed: Set<string>; stops: Set<() => void> };
let observation: Window | null = null;
const clock = () => globalThis.performance?.now?.() ?? Date.now();

export function beginStartupApiTiming(): () => void {
  observation?.stops.forEach(stop => stop());
  const window: Window = {
    id: ++nextObservation, until: clock() + WINDOW_MS, claimed: new Set(), stops: new Set(),
  };
  observation = window;
  return () => {
    window.stops.forEach(stop => stop());
    if (observation === window) observation = null;
  };
}

export function startStartupApiTiming(endpoint: string) {
  const window = observation;
  if (!window || clock() >= window.until || !ENDPOINTS.has(endpoint) || window.claimed.has(endpoint)) return null;
  window.claimed.add(endpoint);
  const requestId = ++nextRequest;
  const start = clock();
  const startedAt = Date.now();
  let tokenStarted: number | null = null;
  let tokenReady: number | null = null;
  let adapterStarted: number | null = null;
  let adapterSettled: number | null = null;
  let responseEntered: number | null = null;
  let persistenceStarted: number | null = null;
  let persistenceEnded: number | null = null;
  let persistenceFailed = false;
  let maxTimerDelayMs = 0;
  let timerSamples = 0;
  let probeStopped = false;
  let probeLimited = false;
  let finished = false;
  let nextDue = start + SAMPLE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    probeStopped = true;
    if (timer !== undefined) clearTimeout(timer);
    window.stops.delete(stop);
  };
  const sample = () => {
    const due = clock() + SAMPLE_MS;
    nextDue = due;
    timer = setTimeout(() => {
      if (probeStopped) return;
      maxTimerDelayMs = Math.max(maxTimerDelayMs, clock() - due);
      timerSamples += 1;
      if (clock() >= window.until) {
        probeLimited = true;
        stop();
      } else sample();
    }, SAMPLE_MS);
  };
  window.stops.add(stop);
  sample();
  const duration = (a: number | null, b: number | null) =>
    a === null || b === null ? null : Math.max(0, Math.round(b - a));

  return {
    tokenStarted: () => { tokenStarted = clock(); },
    tokenReady: () => { tokenReady = clock(); },
    adapterStarted: () => { adapterStarted = clock(); },
    adapterSettled: () => { adapterSettled = clock(); },
    responseEntered: () => { responseEntered = clock(); },
    persistenceStarted: () => { persistenceStarted = clock(); },
    persistenceEnded: (failed: boolean) => {
      persistenceEnded = clock();
      persistenceFailed = failed;
    },
    finish: (outcome: 'completed' | 'failed' | 'token_failed', status: number | null = null) => {
      if (finished) return;
      finished = true;
      const end = clock();
      const probeCoveredWholeRequest = !probeStopped;
      // Also catch a long task that completed before an overdue probe callback.
      if (!probeStopped) maxTimerDelayMs = Math.max(maxTimerDelayMs, end - nextDue);
      stop();
      try {
        markStartupMilestone('startup_api_stage_timing', {
          observation: window.id, requestId, endpoint, outcome, status, startedAt,
          totalMs: duration(start, end),
          preTokenMs: duration(start, tokenStarted),
          tokenReadMs: duration(tokenStarted, tokenReady ?? (outcome === 'token_failed' ? end : null)),
          tokenToAdapterMs: duration(tokenReady, adapterStarted),
          adapterMs: duration(adapterStarted, adapterSettled),
          adapterToResponseMs: duration(adapterSettled, responseEntered),
          responseTokenPersistenceMs: duration(persistenceStarted, persistenceEnded),
          responseTailMs: duration(persistenceEnded ?? responseEntered, end),
          refreshedToken: persistenceStarted !== null, persistenceFailed,
          maxJsTimerDelayMs: Math.max(0, Math.round(maxTimerDelayMs)), timerSamples,
          probeLimited, probeCoveredWholeRequest,
        });
      } catch { /* Observation must never alter the original response/rejection. */ }
    },
  };
}

export type StartupApiTiming = NonNullable<ReturnType<typeof startStartupApiTiming>>;
