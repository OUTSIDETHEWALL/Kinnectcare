import type { EngineLogEvent } from '../locationEngine';
export const testNow = 1_792_180_000_000;
export const e = (event: string, at = testNow, detail: Record<string, unknown> = {}): EngineLogEvent =>
  ({ seq: at, src: 'engine', at, event, detail });
export function backgroundEvidence(now = testNow, age = 0, generation = 1): EngineLogEvent[] {
  const owner = 'user:member';
  return [65_000, 0].flatMap((ago, index) => [
    e('native_capture_observed', now - age - ago, {
      owner, generation, captureId: `capture-${index}`, capturedAt: now - age - ago, origin: 'background' }),
    e('verified_coordinate_publication', now - age - ago, {
      owner, generation, captureId: `capture-${index}`, capturedAt: now - age - ago, origin: 'native-receipt' }),
  ]).concat(e('sdk_state_observed', now, { enabled: true, owner, generation }));
}
