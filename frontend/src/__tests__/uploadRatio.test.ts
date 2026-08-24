import type { EngineLogEvent } from '../locationEngine';
import { computeUploadRatio } from '../uploadRatio';

let seq = 0;

function makeEvent(
  event: string,
  detail?: Record<string, unknown>,
): EngineLogEvent {
  seq += 1;
  return { seq, src: 'engine', at: seq, event, detail };
}

describe('computeUploadRatio', () => {
  beforeEach(() => {
    seq = 0;
  });

  it('reports no uploads recorded when the engine buffer is empty', () => {
    expect(computeUploadRatio([])).toEqual({
      total: 0,
      ok: 0,
      fail: 0,
      lastFailStatus: null,
    });
  });

  it('reports all successful uploads as ok with no failures', () => {
    const engineLog = [
      makeEvent('sdk_onHttp', { success: true, status: 200 }),
      makeEvent('sdk_onHttp', { success: true, status: 201 }),
      makeEvent('http_upload_success'),
    ];

    expect(computeUploadRatio(engineLog)).toEqual({
      total: 2,
      ok: 2,
      fail: 0,
      lastFailStatus: null,
    });
  });

  it('reports a failure burst and keeps the most recent failure status', () => {
    const engineLog = [
      makeEvent('sdk_onHttp', { success: false, status: 500 }),
      makeEvent('sdk_onHttp', { success: false, status: 502 }),
      makeEvent('sdk_onHttp', { success: false, status: 503 }),
    ];

    expect(computeUploadRatio(engineLog)).toEqual({
      total: 3,
      ok: 0,
      fail: 3,
      lastFailStatus: 503,
    });
  });

  it('reports mixed successes and failures without double-counting named upload events', () => {
    const engineLog = [
      makeEvent('sdk_onHttp', { success: true, status: 200 }),
      makeEvent('headless_http_error', { status: 500 }),
      makeEvent('sdk_onHttp', { success: false, status: 500 }),
      makeEvent('sdk_onHttp', { success: true, status: 200 }),
      makeEvent('sdk_onHttp', { success: false, status: 504 }),
    ];

    expect(computeUploadRatio(engineLog)).toEqual({
      total: 4,
      ok: 2,
      fail: 2,
      lastFailStatus: 504,
    });
  });
});