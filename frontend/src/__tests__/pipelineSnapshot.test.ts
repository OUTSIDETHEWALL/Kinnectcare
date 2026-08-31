const mockStorage = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (key: string) => mockStorage.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => { mockStorage.set(key, value); }),
  removeItem: jest.fn(async (key: string) => { mockStorage.delete(key); }),
}));

import {
  clearPipelineSnapshots,
  observeMapProps,
  observeMapRendered,
  observeStoreCommit,
  readPipelineSnapshots,
  stampMembersResponse,
} from '../pipelineSnapshot';

const old = { latitude: 35.1000, longitude: -114.6000 };
const fresh = { latitude: 35.1400, longitude: -114.5700 };

function member(coords = fresh, overrides: Record<string, unknown> = {}): any {
  return {
    id: 'member-001',
    name: 'Test Member',
    latitude: coords.latitude,
    longitude: coords.longitude,
    last_seen: '2026-08-28T18:00:01.000Z',
    location_pipeline: {
      trace_id: 'trace-1',
      native_gps_at: '2026-08-28T18:00:00.000Z',
      native_latitude: fresh.latitude,
      native_longitude: fresh.longitude,
      upload_at: '2026-08-28T18:00:01.000Z',
      upload_timestamp_source: 'backend_first_observed',
      backend_received_at: '2026-08-28T18:00:01.000Z',
      mongo_write_at: '2026-08-28T18:00:01.010Z',
      stored_latitude: fresh.latitude,
      stored_longitude: fresh.longitude,
      speed_mps: 12,
      accuracy_m: 8,
      provider: 'fused',
      is_moving: true,
      members_response_at: '2026-08-28T18:00:02.000Z',
    },
    ...overrides,
  };
}

describe('stale-location pipeline snapshot', () => {
  beforeEach(async () => {
    mockStorage.clear();
    await clearPipelineSnapshots();
  });

  it('emits one complete UI-stage smoking gun when the map renders the prior coordinate', async () => {
    const apiMember = stampMembersResponse([member()], Date.parse('2026-08-28T18:00:03Z'))[0];
    observeStoreCommit(apiMember, apiMember, member(old), Date.parse('2026-08-28T18:00:04Z'));
    observeMapProps('member-001', fresh.latitude, fresh.longitude, Date.parse('2026-08-28T18:00:05Z'));

    const emitted = observeMapRendered(
      'member-001', old.latitude, old.longitude, 'trace-1', Date.parse('2026-08-28T18:00:06Z'),
    );
    expect(emitted).toMatchObject({
      kind: 'STALE_LOCATION_PIPELINE_SNAPSHOT',
      trace_id: 'trace-1',
      failure_stage: 'ui',
      native_gps_timestamp: '2026-08-28T18:00:00.000Z',
      native_gps_coordinates: fresh,
      map_render_coordinates: old,
      dashboard_store_timestamp: '2026-08-28T18:00:04.000Z',
      members_response_timestamp: '2026-08-28T18:00:02.000Z',
      dashboard_response_timestamp: '2026-08-28T18:00:03.000Z',
    });

    // Same trace cannot create a second snapshot.
    expect(observeMapRendered('member-001', old.latitude, old.longitude, 'trace-1')).toBeNull();
    const saved = await readPipelineSnapshots();
    expect(saved).toHaveLength(1);
    expect(saved[0].trace_id).toBe('trace-1');
  });

  it('does not emit when the moving coordinate reaches the map', async () => {
    const m = member();
    observeStoreCommit(m, m, member(old));
    observeMapProps('member-001', fresh.latitude, fresh.longitude);
    expect(observeMapRendered('member-001', fresh.latitude, fresh.longitude, 'trace-1')).toBeNull();
    expect(await readPipelineSnapshots()).toEqual([]);
  });

  it('does not reopen a completed moving trace when the same API record is fetched again', async () => {
    const m = member();
    observeStoreCommit(m, m, member(old));
    observeMapProps('member-001', fresh.latitude, fresh.longitude);
    expect(observeMapRendered('member-001', fresh.latitude, fresh.longitude, 'trace-1')).toBeNull();

    observeStoreCommit(m, m, m);
    observeMapProps('member-001', fresh.latitude, fresh.longitude);
    expect(observeMapRendered('member-001', fresh.latitude, fresh.longitude, 'trace-1')).toBeNull();
    expect(await readPipelineSnapshots()).toEqual([]);
  });

  it('identifies the store as the first stage that retained the old coordinate', () => {
    const apiMember = member();
    const staleStore = member(old);
    observeStoreCommit(apiMember, staleStore, member(old));
    observeMapProps('member-001', old.latitude, old.longitude);
    const emitted = observeMapRendered('member-001', old.latitude, old.longitude, 'trace-1');
    expect(emitted?.failure_stage).toBe('store');
  });

  it('identifies a speed-without-coordinate-progress trace as device-originated', () => {
    const noProgress = member(old, {
      location_pipeline: {
        ...member().location_pipeline,
        trace_id: 'trace-device',
        native_latitude: old.latitude,
        native_longitude: old.longitude,
        stored_latitude: old.latitude,
        stored_longitude: old.longitude,
      },
    });
    observeStoreCommit(noProgress, noProgress, member(old));
    observeMapProps('member-001', old.latitude, old.longitude);
    const emitted = observeMapRendered('member-001', old.latitude, old.longitude, 'trace-device');
    expect(emitted?.failure_stage).toBe('device');
    expect(emitted?.trigger).toBe('speed_over_5_mph');
  });

  it('ignores a delayed acknowledgement from an older map generation', async () => {
    const m = member();
    observeStoreCommit(m, m, member(old));
    observeMapProps('member-001', fresh.latitude, fresh.longitude);
    expect(observeMapRendered('member-001', old.latitude, old.longitude, 'older-trace')).toBeNull();
    expect(await readPipelineSnapshots()).toEqual([]);
  });
});