import type { EngineLogEvent } from './locationEngine';

/** Separate observations; never substitute contact time for capture time. */
export function locationEvidenceSummary(log: EngineLogEvent[], now: number, serverCapture?: number | null) {
  const events = log.filter(e => e.at <= now + 5000).sort((a, b) => a.at - b.at);
  const latest = (test: (e: EngineLogEvent) => boolean) => [...events].reverse().find(test);
  const publication = latest(e => e.event === 'verified_coordinate_publication');
  const background = latest(e => e.event === 'verified_coordinate_publication'
    && (e.detail?.origin === 'background' || (e.detail?.origin === 'native-receipt'
      && typeof e.detail.captureId === 'string' && events.some(c =>
        c.event === 'native_capture_observed' && c.detail?.origin === 'background'
        && c.detail.captureId === e.detail?.captureId
        && c.detail.capturedAt === e.detail?.capturedAt
        && c.detail.owner === e.detail?.owner && c.detail.generation === e.detail?.generation))));
  const captureCandidates = [Number(publication?.detail?.capturedAt), serverCapture]
    .filter((t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0 && t <= now + 5000);
  return {
    state: latest(e => e.event === 'sdk_state_observed' || e.event === 'sdk_onEnabledChange'),
    capture: captureCandidates.length ? Math.max(...captureCandidates) : null,
    background: background?.at ?? null,
    foreground: latest(e => e.event === 'verified_coordinate_publication'
      && (e.detail?.origin === 'one-shot' || e.detail?.origin === 'foreground'))?.at ?? null,
    heartbeat: latest(e => e.event === 'sdk_onHeartbeat')?.at ?? null,
    motion: latest(e => e.event === 'sdk_onMotionChange' || e.event === 'sdk_onActivityChange'
      || e.event === 'headless_motion_observed' || e.event === 'headless_activity_observed')?.at ?? null,
  };
}
