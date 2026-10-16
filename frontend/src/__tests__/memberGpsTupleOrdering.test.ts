import * as store from '../store/memberStore';
jest.mock('../api', () => ({ api: {} }));
jest.mock('../refreshPipelineLog', () => ({ logPipelineEvent: jest.fn() }));
jest.mock('../pipelineSnapshot', () => ({ observeStoreCommit: jest.fn() }));

describe('caregiver store GPS provenance', () => {
  beforeEach(() => store.clearAll());
  const row = {
    id: 'gps-ordering-member', user_id: 'self', name: 'Test', location_sharing_enabled: true,
    location_consent_generation: 3, latitude: 35, longitude: -114,
    coordinate_captured_at: '2026-10-16T12:00:00Z', captured_at: '2026-10-16T12:00:00Z',
    location_name: 'Current point', last_seen: '2026-10-16T12:00:00Z',
  } as any;
  it.each([null, '2026-10-16T11:59:00Z'])('keeps the verified tuple after an out-of-order poll with capture %s', capture => {
    store.upsertOne(row);
    store.upsertOne({ ...row, latitude: 99, longitude: 99, location_name: null,
      coordinate_captured_at: capture, captured_at: capture, battery_level: .69,
      last_seen: '2026-10-16T12:01:00Z' });
    expect(store.getMyMember('self')).toMatchObject({
      latitude: 35, longitude: -114, coordinate_captured_at: row.coordinate_captured_at,
      location_name: 'Current point', battery_level: .69, last_seen: '2026-10-16T12:01:00Z',
    });
  });
  it('does not retain GPS after explicit sharing withdrawal or lifetime replacement', () => {
    store.upsertOne(row);
    store.upsertOne({ ...row, location_sharing_enabled: false,
      latitude: null, longitude: null, coordinate_captured_at: null, location_name: null });
    expect(store.getMyMember('self')?.latitude).toBeNull();
    expect(store.getMyMember('self')?.location_name).toBeNull();
    store.upsertOne(row);
    store.upsertOne({ ...row, location_consent_generation: 4,
      latitude: null, longitude: null, coordinate_captured_at: null, location_name: null });
    expect(store.getMyMember('self')?.coordinate_captured_at).toBeNull();
    expect(store.getMyMember('self')?.location_name).toBeNull();
  });
  it('does not attach a previous point label to a newer different coordinate', () => {
    store.upsertOne(row);
    store.upsertOne({ ...row, latitude: 36, location_name: null,
      coordinate_captured_at: '2026-10-16T12:02:00Z' });
    expect(store.getMyMember('self')).toMatchObject({ latitude: 36, location_name: null });
  });
  it('a pre-withdrawal response cannot resurrect sharing or coordinates', () => {
    store.upsertOne({ ...row, location_consent_generation: 4, location_sharing_enabled: false,
      latitude: null, longitude: null, location_name: null, coordinate_captured_at: null });
    store.upsertOne({ ...row, coordinate_captured_at: '2026-10-16T13:00:00Z' });
    expect(store.getMyMember('self')).toMatchObject({
      location_sharing_enabled: false, location_consent_generation: 4,
      latitude: null, coordinate_captured_at: null,
    });
  });
});
