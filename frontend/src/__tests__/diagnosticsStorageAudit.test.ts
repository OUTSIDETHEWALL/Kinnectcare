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
  clearDiagnosticsStorageKey,
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

  it('removes only the selected Diagnostics key and retains before/after evidence', async () => {
    storage.set('kc_push_refresh_log', '{not-json');
    storage.set('kc_my_member_id_v1', 'protected-member-id');

    const before = await auditDiagnosticsStorage();
    await clearDiagnosticsStorageKey('kc_push_refresh_log');
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

  it('one-key deletion preserves every other Diagnostics and operational key', async () => {
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

    await clearDiagnosticsStorageKey('kc_push_refresh_log');

    expect(mockAsyncStorage.multiRemove).toHaveBeenCalledWith(['kc_push_refresh_log']);
    expect(storage.has('kc_push_refresh_log')).toBe(false);
    DIAGNOSTICS_STORAGE_KEYS
      .filter((key) => key !== 'kc_push_refresh_log')
      .forEach((key) => expect(storage.get(key)).toBe('remove'));
    protectedKeys.forEach((key) => expect(storage.get(key)).toBe('preserve'));
  });

  it('reports the key schema suffix and explicit record schema version', async () => {
    storage.set('@kinnship/notification_log_v1', JSON.stringify([{
      at: 123,
      source: 'data-push',
      schemaVersion: 2,
    }]));

    const result = await auditDiagnosticsStorage();
    const notification = result.entries.find(
      (entry) => entry.key === '@kinnship/notification_log_v1',
    );

    expect(notification?.schemaVersions).toEqual([
      'key_suffix=v1',
      'schemaVersion=2',
    ]);
  });

  it('inventories tracking, resume-decision, and raw debug-overlay diagnostics', async () => {
    storage.set('@kinnship/tracking_pill_decisions_v1', JSON.stringify([{
      t: 123,
      screen: 'dashboard-card',
      hasCoords: true,
      lastSeenIso: null,
      ageMs: null,
      kind: 'healthy',
      reason: 'fresh location',
    }]));
    storage.set('@kinnship/resume_decisions_v1', JSON.stringify([{
      t: 123,
      reason: 'no-cached-alert',
      alertId: null,
      ageMs: null,
      fromPathname: '/dashboard',
      detail: null,
    }]));
    storage.set('kc_debug_overlay_v1', '1');

    const result = await auditDiagnosticsStorage();

    expect(result.entries.map((entry) => entry.key)).toEqual([...DIAGNOSTICS_STORAGE_KEYS]);
    expect(result.entries.find(
      (entry) => entry.key === '@kinnship/tracking_pill_decisions_v1',
    )?.status).toBe('valid');
    expect(result.entries.find(
      (entry) => entry.key === '@kinnship/resume_decisions_v1',
    )?.status).toBe('valid');
    expect(result.entries.find(
      (entry) => entry.key === 'kc_debug_overlay_v1',
    )?.status).toBe('valid');
  });

  it('deletes resume decision history without touching SOS operational state', async () => {
    storage.set('@kinnship/resume_decisions_v1', JSON.stringify([{ t: 123, reason: 'resumed' }]));
    storage.set('@kinnship/sos_active_v1', 'active-alert');

    await clearDiagnosticsStorageKey('@kinnship/resume_decisions_v1');

    expect(mockAsyncStorage.multiRemove).toHaveBeenCalledWith([
      '@kinnship/resume_decisions_v1',
    ]);
    expect(storage.has('@kinnship/resume_decisions_v1')).toBe(false);
    expect(storage.get('@kinnship/sos_active_v1')).toBe('active-alert');
  });

  it('scans all records for versions while redacting malicious values and field names', async () => {
    const records = Array.from({ length: 25 }, (_, index) => ({
      t: index + 1,
      ...(index === 24 ? { schemaVersion: 3 } : {}),
    }));
    records[0] = {
      t: 1,
      schemaVersion: 'private-payload-should-not-be-copied' as unknown as number,
      ['private-field-name-should-not-be-copied']: 'secret',
    } as unknown as { t: number; schemaVersion?: number };
    storage.set('kc_auth_clear_diag', JSON.stringify(records));

    const result = await auditDiagnosticsStorage();
    const auth = result.entries.find((entry) => entry.key === 'kc_auth_clear_diag');
    const serialized = JSON.stringify(result);

    expect(auth?.schemaVersions).toContain('schemaVersion=3');
    expect(auth?.fieldSets).toContain('schemaVersion,t,<1_unknown_fields>');
    expect(serialized).not.toContain('private-payload-should-not-be-copied');
    expect(serialized).not.toContain('private-field-name-should-not-be-copied');
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