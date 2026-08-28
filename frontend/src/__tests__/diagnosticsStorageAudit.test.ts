/* eslint-disable import/first */
jest.mock('@react-native-async-storage/async-storage', () => {
  const values = new Map<string, string>();
  return {
    __storage: values,
    getItem: jest.fn(async (key: string) => values.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    multiRemove: jest.fn(async (keys: string[]) => {
      keys.forEach((key) => values.delete(key));
    }),
  };
});
jest.mock('../pipelineSnapshot', () => ({
  isPipelineSnapshot: (value: unknown) => (
    !!value
    && typeof value === 'object'
    && (value as { kind?: string }).kind === 'STALE_LOCATION_PIPELINE_SNAPSHOT'
  ),
}));

import {
  auditDiagnosticsStorage,
  clearAllDiagnosticsStorage,
  clearInvalidDiagnosticsStorage,
  DIAGNOSTICS_STORAGE_KEYS,
  readDiagnosticsStorageEvidence,
} from '../diagnosticsStorageAudit';
import AsyncStorage from '@react-native-async-storage/async-storage';

const mockAsyncStorage = AsyncStorage as typeof AsyncStorage & {
  __storage: Map<string, string>;
};
const storage = mockAsyncStorage.__storage;

describe('Diagnostics storage isolation', () => {
  beforeEach(() => {
    storage.clear();
    jest.clearAllMocks();
  });

  it('identifies the exact key and record when legacy data has the wrong shape', async () => {
    storage.set('kc_push_refresh_log', JSON.stringify({ t: 123 }));
    storage.set('kc_auth_clear_diag', JSON.stringify([{ t: 123 }]));

    const result = await auditDiagnosticsStorage();

    expect(result.invalidKeys).toEqual(['kc_push_refresh_log']);
    expect(result.entries.find((entry) => entry.key === 'kc_push_refresh_log')).toMatchObject({
      status: 'invalid',
      jsonShape: 'object',
      issue: 'expected_array_received_object',
    });
    expect(result.entries.find((entry) => entry.key === 'kc_auth_clear_diag')).toMatchObject({
      status: 'valid',
      recordCount: 1,
    });
  });

  it('rejects a malformed record before a Diagnostics renderer can consume it', async () => {
    storage.set('@kinnship/dashboard_load_log_v1', JSON.stringify([{
      seq: 1,
      src: 'dashboard-load',
      id: 'load-1',
      trigger: 'mount',
      t_load_started: 123,
      t_get_sent: null,
      t_get_received: null,
      t_setstate: null,
      http_status: null,
      member_count: null,
      raw_members: [],
      // Legacy record is missing staleness_triggered_for, which the renderer maps.
    }]));

    const result = await auditDiagnosticsStorage();
    const dashboard = result.entries.find(
      (entry) => entry.key === '@kinnship/dashboard_load_log_v1',
    );

    expect(dashboard).toMatchObject({
      status: 'invalid',
      issue: 'record_0_staleness_triggered_for_expected_array',
    });
  });

  it('removes only invalid Diagnostics keys and retains before/after evidence', async () => {
    storage.set('kc_push_refresh_log', '{not-json');
    storage.set('kc_my_member_id_v1', 'protected-member-id');

    const before = await auditDiagnosticsStorage();
    await clearInvalidDiagnosticsStorage(before);
    const after = await auditDiagnosticsStorage();
    const evidence = await readDiagnosticsStorageEvidence();

    expect(mockAsyncStorage.multiRemove).toHaveBeenCalledWith(['kc_push_refresh_log']);
    expect(storage.get('kc_my_member_id_v1')).toBe('protected-member-id');
    expect(before.invalidKeys).toEqual(['kc_push_refresh_log']);
    expect(after.invalidKeys).toEqual([]);
    expect(evidence.audits).toHaveLength(2);
    expect(evidence.audits[0].invalidKeys).toEqual(['kc_push_refresh_log']);
    expect(evidence.cleanups[0].keys).toEqual(['kc_push_refresh_log']);
  });

  it('the full reset allowlist never includes operational or identity state', async () => {
    const protectedKeys = [
      'kc_my_member_id_v1',
      'kc_my_user_id_v1',
      '@kinnship/bg_location_member_id_v1',
      '@kinnship/location_sharing_off_v1',
      '@kinnship/sos_active_v1',
      'kc_pts_http_ok',
      'kc_pts_http_ok_count',
      'kc_pts_http_fail',
    ];
    protectedKeys.forEach((key) => storage.set(key, 'preserve'));
    DIAGNOSTICS_STORAGE_KEYS.forEach((key) => storage.set(key, 'remove'));

    await clearAllDiagnosticsStorage();

    expect(mockAsyncStorage.multiRemove).toHaveBeenCalledWith([...DIAGNOSTICS_STORAGE_KEYS]);
    protectedKeys.forEach((key) => expect(storage.get(key)).toBe('preserve'));
  });

  it('uses fixed error categories rather than copying storage exception text', async () => {
    (mockAsyncStorage.getItem as jest.Mock).mockImplementationOnce(async () => {
      throw new Error('private-payload-should-not-be-copied');
    });

    const result = await auditDiagnosticsStorage();
    const serialized = JSON.stringify(result);

    expect(result.entries[0].issue).toBe('storage_read_failed');
    expect(serialized).not.toContain('private-payload-should-not-be-copied');
  });
});