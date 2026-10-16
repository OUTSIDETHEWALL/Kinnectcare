import type { EngineLogEvent } from './locationEngine';

/** Separate observations; never substitute contact time for capture time. */
export function locationEvidenceSummary(log: EngineLogEvent[], now: number, serverCapture?: number | null) {
  const events = log.filter(e => e.at <= now + 5000).sort((a, b) => a.at - b.at);
  const boundary = [...events].reverse().find(e =>
    e.event === 'tracking_authority_boundary' || e.event === 'stop_ok')?.at ?? 0;
  const state = [...events].reverse().find(e =>
    e.event === 'sdk_state_observed' || e.event === 'sdk_onEnabledChange');
  const current = events.filter(e => e.at >= boundary && (!state?.detail?.owner
    || (e.detail?.owner === state.detail.owner && e.detail?.generation === state.detail.generation))
    && (state?.detail?.consentGeneration == null
      || (e.detail?.consentGeneration ?? 0) === state.detail.consentGeneration));
  const latest = (test: (e: EngineLogEvent) => boolean) => [...current].reverse().find(test);
  const publication = latest(e => e.event === 'verified_coordinate_publication');
  const background = latest(e => e.event === 'verified_coordinate_publication'
    && (e.detail?.origin === 'background' || (e.detail?.origin === 'native-receipt'
      && typeof e.detail.captureId === 'string' && current.some(c =>
        c.event === 'native_capture_observed' && c.detail?.origin === 'background'
        && c.detail.captureId === e.detail?.captureId
        && c.detail.capturedAt === e.detail?.capturedAt
        && c.detail.owner === e.detail?.owner && c.detail.generation === e.detail?.generation
        && (c.detail.consentGeneration ?? 0) === (e.detail?.consentGeneration ?? 0)))));
  const captureCandidates = [Number(publication?.detail?.capturedAt), serverCapture]
    .filter((t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0 && t <= now + 5000);
  return {
    state,
    capture: captureCandidates.length ? Math.max(...captureCandidates) : null,
    background: background?.at ?? null,
    foreground: latest(e => e.event === 'verified_coordinate_publication'
      && (e.detail?.origin === 'one-shot' || e.detail?.origin === 'foreground'))?.at ?? null,
    heartbeat: latest(e => e.event === 'sdk_onHeartbeat')?.at ?? null,
    motion: latest(e => e.event === 'sdk_onMotionChange' || e.event === 'sdk_onActivityChange'
      || e.event === 'headless_motion_observed' || e.event === 'headless_activity_observed')?.at ?? null,
  };
}
