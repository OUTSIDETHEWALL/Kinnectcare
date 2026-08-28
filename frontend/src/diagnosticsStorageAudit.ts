import AsyncStorage from '@react-native-async-storage/async-storage';
import { isPipelineSnapshot } from './pipelineSnapshot';

/**
 * Storage owned only by Diagnostics viewers and rolling diagnostic logs.
 *
 * Deliberately excluded:
 * - auth/session and user/member identity
 * - location-sharing and SOS state
 * - background-location member identity
 * - pipeline timestamps and HTTP success/failure counters
 * - battery-optimization prompt state
 */
export const DIAGNOSTICS_STORAGE_KEYS = [
  'kc_auth_clear_diag',
  'kc_push_refresh_log',
  '@kinnship/diagnostics_expanded_v1',
  '@kinnship/notification_log_v1',
  '@kinnship/route_diagnostics_v1',
  'kc_location_refresh_log',
  'kc_bg_task_log',
  '@kinnship/battery_task_log_v1',
  'kc_screen_render_log',
  '@kinnship/dashboard_load_log_v1',
  '@kinnship/card_render_log_v1',
  '@kinnship/refresh_pipeline_log_v1',
  '@kinnship/leonidas_recovery_log_v1',
  '@kinnship/location_engine_log_v1',
  'kc_stale_location_pipeline_snapshots_v1',
  '@kinnship/tracking_pill_decisions_v1',
  '@kinnship/resume_decisions_v1',
  'kc_debug_overlay_v1',
] as const;

export type DiagnosticsStorageKey = (typeof DIAGNOSTICS_STORAGE_KEYS)[number];

const AUDIT_RESULT_KEY = '@kinnship/diagnostics_storage_audit_v1';
const AUDIT_PROGRESS_KEY = '@kinnship/diagnostics_storage_audit_progress_v1';
const AUDIT_HISTORY_KEY = '@kinnship/diagnostics_storage_audit_history_v1';
const CLEANUP_HISTORY_KEY = '@kinnship/diagnostics_storage_cleanup_history_v1';
const MAX_EVIDENCE_HISTORY = 10;
const MAX_FIELD_SETS = 3;

type AuditStatus = 'missing' | 'valid' | 'invalid' | 'read_error';

export type DiagnosticsStorageAuditEntry = {
  key: DiagnosticsStorageKey;
  status: AuditStatus;
  rawBytes: number;
  jsonShape: string;
  recordCount: number | null;
  issue: string | null;
  /** Field names only, never field values. Useful for spotting legacy schemas. */
  fieldSets: string[];
  /** Explicit version markers found in records, without copying record payloads. */
  schemaVersions: string[];
};

export type DiagnosticsStorageAuditResult = {
  version: 1;
  auditId: string;
  createdAt: string;
  entries: DiagnosticsStorageAuditEntry[];
  invalidKeys: DiagnosticsStorageKey[];
};

type StorageDefinition = {
  key: DiagnosticsStorageKey;
  shape: 'array' | 'expansion-state' | 'raw-boolean-flag';
  validateRecord?: (record: Record<string, unknown>) => string | null;
};

type DiagnosticsStorageCleanupRecord = {
  at: string;
  keys: DiagnosticsStorageKey[];
};

export type DiagnosticsStorageEvidence = {
  audits: DiagnosticsStorageAuditResult[];
  cleanups: DiagnosticsStorageCleanupRecord[];
};

const NOTIFICATION_SOURCES = new Set([
  'foreground-handler', 'received-listener', 'response-listener', 'data-push',
]);
const BG_TASK_PHASES = new Set([
  'tick', 'task-error', 'no-locs', 'no-member-id', 'lock-held', 'upload-ok',
  'upload-fail', 'sharing-off', 'battery-sampled', 'battery-error',
]);
const BATTERY_EVENTS = new Set([
  'background_battery_configured', 'background_battery_configure_error',
  'background_battery_task_start', 'background_battery_ok',
  'background_battery_skipped', 'background_battery_error',
  'background_battery_timeout',
]);
const SCREEN_RENDER_SOURCES = new Set([
  'dashboard-fetch', 'member-fetch', 'map-props', 'map-rendered',
]);
const PIPELINE_STAGES = new Set([
  'dashboard-load', 'store-upsert-one', 'store-upsert-many', 'store-fetch-all',
]);
const SAFE_SCHEMA_FIELDS = new Set([
  'ageMs', 'age_label', 'api_to_store', 'at', 'batchAdvanced', 'batchId',
  'alertId', 'body', 'broadcast_last_seen', 'cachedUserId', 'created_at', 'detail',
  'device_coords', 'device_fix_at', 'distances_m', 'error', 'event',
  'failure_detail', 'failure_stage', 'fromPathname', 'hasCoords', 'health_state', 'http_status',
  'id', 'is_newer', 'kind', 'lastSeenIso', 'last_seen', 'latApprox',
  'lonApprox', 'memberCount', 'member_count', 'member_id', 'native_to_backend',
  'ok', 'phase', 'previous_to_native', 'prior_state_last_seen', 'raw_members',
  'reason', 'refreshing', 'response', 'route', 'schemaVersion', 'schema_version',
  'screen', 'seen_ms', 'seq', 'source', 'src', 'stage', 'staleness_triggered_for',
  'status', 'store_to_map', 't', 't_get_received', 't_get_sent', 't_load_started',
  't_setstate', 'tokenSuffix', 'trace_id', 'trigger', 'url', 'v', 'version',
  'wrote', 'rotated', 'backend_coords', 'backend_received_at', 'api_coords',
  'api_returned_at', 'store_coords', 'store_updated_at', 'map_coords',
  'map_rendered_at',
]);

function finiteNumber(record: Record<string, unknown>, field: string): string | null {
  return typeof record[field] === 'number' && Number.isFinite(record[field])
    ? null
    : `${field}_expected_finite_number`;
}

function requiredString(record: Record<string, unknown>, field: string): string | null {
  return typeof record[field] === 'string' && record[field].length > 0
    ? null
    : `${field}_expected_nonempty_string`;
}

function requiredBoolean(record: Record<string, unknown>, field: string): string | null {
  return typeof record[field] === 'boolean' ? null : `${field}_expected_boolean`;
}

function nullableString(record: Record<string, unknown>, field: string): string | null {
  return record[field] === null || typeof record[field] === 'string'
    ? null
    : `${field}_expected_string_or_null`;
}

function nullableNumber(record: Record<string, unknown>, field: string): string | null {
  return record[field] === null
    || (typeof record[field] === 'number' && Number.isFinite(record[field]))
    ? null
    : `${field}_expected_finite_number_or_null`;
}

function optionalObject(record: Record<string, unknown>, field: string): string | null {
  return record[field] === undefined || isObject(record[field])
    ? null
    : `${field}_expected_object`;
}

function optionalNullableString(record: Record<string, unknown>, field: string): string | null {
  return record[field] === undefined ? null : nullableString(record, field);
}

function optionalNullableNumber(record: Record<string, unknown>, field: string): string | null {
  return record[field] === undefined ? null : nullableNumber(record, field);
}

function allValid(...issues: (string | null)[]): string | null {
  return issues.find((issue): issue is string => issue !== null) ?? null;
}

const STORAGE_DEFINITIONS: StorageDefinition[] = [
  { key: 'kc_auth_clear_diag', shape: 'array', validateRecord: (r) => finiteNumber(r, 't') },
  { key: 'kc_push_refresh_log', shape: 'array', validateRecord: (r) => finiteNumber(r, 't') },
  { key: '@kinnship/diagnostics_expanded_v1', shape: 'expansion-state' },
  {
    key: '@kinnship/notification_log_v1',
    shape: 'array',
    validateRecord: (r) => allValid(
      finiteNumber(r, 'at'),
      NOTIFICATION_SOURCES.has(String(r.source)) ? null : 'source_unrecognized',
    ),
  },
  { key: '@kinnship/route_diagnostics_v1', shape: 'array', validateRecord: (r) => finiteNumber(r, 't') },
  {
    key: 'kc_location_refresh_log',
    shape: 'array',
    validateRecord: (r) => allValid(
      finiteNumber(r, 't'),
      requiredString(r, 'reason'),
      requiredBoolean(r, 'ok'),
      nullableNumber(r, 'latApprox'),
      nullableNumber(r, 'lonApprox'),
      nullableString(r, 'err'),
    ),
  },
  {
    key: 'kc_bg_task_log',
    shape: 'array',
    validateRecord: (r) => allValid(
      finiteNumber(r, 't'),
      BG_TASK_PHASES.has(String(r.phase)) ? null : 'phase_unrecognized',
    ),
  },
  {
    key: '@kinnship/battery_task_log_v1',
    shape: 'array',
    validateRecord: (r) => allValid(
      finiteNumber(r, 'seq'),
      finiteNumber(r, 'at'),
      BATTERY_EVENTS.has(String(r.event)) ? null : 'event_unrecognized',
      optionalObject(r, 'detail'),
    ),
  },
  {
    key: 'kc_screen_render_log',
    shape: 'array',
    validateRecord: (r) => allValid(
      finiteNumber(r, 't'),
      SCREEN_RENDER_SOURCES.has(String(r.src)) ? null : 'src_unrecognized',
    ),
  },
  {
    key: '@kinnship/dashboard_load_log_v1',
    shape: 'array',
    validateRecord: (r) => allValid(
      finiteNumber(r, 'seq'),
      r.src === 'dashboard-load' ? null : 'src_unrecognized',
      requiredString(r, 'id'),
      requiredString(r, 'trigger'),
      finiteNumber(r, 't_load_started'),
      nullableNumber(r, 't_get_sent'),
      nullableNumber(r, 't_get_received'),
      nullableNumber(r, 't_setstate'),
      nullableNumber(r, 'http_status'),
      nullableNumber(r, 'member_count'),
      Array.isArray(r.staleness_triggered_for) ? null : 'staleness_triggered_for_expected_array',
      Array.isArray(r.raw_members) ? null : 'raw_members_expected_array',
    ),
  },
  {
    key: '@kinnship/card_render_log_v1',
    shape: 'array',
    validateRecord: (r) => {
      const common = allValid(
        finiteNumber(r, 'seq'),
        finiteNumber(r, 'at'),
        requiredString(r, 'member_id'),
      );
      if (common) return common;
      if (r.src === 'card-render') {
        return allValid(
          nullableString(r, 'last_seen'),
          nullableNumber(r, 'seen_ms'),
          requiredString(r, 'age_label'),
          requiredBoolean(r, 'refreshing'),
        );
      }
      if (r.src === 'broadcast') {
        return allValid(
          nullableString(r, 'broadcast_last_seen'),
          nullableString(r, 'prior_state_last_seen'),
          requiredBoolean(r, 'is_newer'),
        );
      }
      return 'src_unrecognized';
    },
  },
  {
    key: '@kinnship/refresh_pipeline_log_v1',
    shape: 'array',
    validateRecord: (r) => allValid(
      finiteNumber(r, 'seq'),
      finiteNumber(r, 't'),
      PIPELINE_STAGES.has(String(r.stage)) ? null : 'stage_unrecognized',
    ),
  },
  {
    key: '@kinnship/leonidas_recovery_log_v1',
    shape: 'array',
    validateRecord: (r) => allValid(
      finiteNumber(r, 'seq'),
      r.src === 'leonidas' ? null : 'src_unrecognized',
      finiteNumber(r, 'at'),
      requiredString(r, 'event'),
      requiredString(r, 'health_state'),
      optionalObject(r, 'detail'),
    ),
  },
  {
    key: '@kinnship/location_engine_log_v1',
    shape: 'array',
    validateRecord: (r) => allValid(
      finiteNumber(r, 'seq'),
      r.src === 'engine' ? null : 'src_unrecognized',
      finiteNumber(r, 'at'),
      requiredString(r, 'event'),
      optionalObject(r, 'detail'),
    ),
  },
  {
    key: 'kc_stale_location_pipeline_snapshots_v1',
    shape: 'array',
    validateRecord: (r) => isPipelineSnapshot(r) ? null : 'snapshot_schema_invalid',
  },
  {
    key: '@kinnship/tracking_pill_decisions_v1',
    shape: 'array',
    validateRecord: (r) => allValid(
      finiteNumber(r, 't'),
      requiredString(r, 'screen'),
      requiredBoolean(r, 'hasCoords'),
      nullableString(r, 'lastSeenIso'),
      nullableNumber(r, 'ageMs'),
      requiredString(r, 'kind'),
      requiredString(r, 'reason'),
    ),
  },
  {
    key: '@kinnship/resume_decisions_v1',
    shape: 'array',
    validateRecord: (r) => allValid(
      finiteNumber(r, 't'),
      requiredString(r, 'reason'),
      optionalNullableString(r, 'alertId'),
      optionalNullableNumber(r, 'ageMs'),
      optionalNullableString(r, 'fromPathname'),
      optionalNullableString(r, 'detail'),
    ),
  },
  { key: 'kc_debug_overlay_v1', shape: 'raw-boolean-flag' },
];

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function jsonShape(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function safeFieldSignature(record: Record<string, unknown>): string {
  const keys = Object.keys(record);
  const safe = keys.filter((key) => SAFE_SCHEMA_FIELDS.has(key)).sort();
  const unknownCount = keys.length - safe.length;
  return [
    ...safe,
    ...(unknownCount > 0 ? [`<${unknownCount}_unknown_fields>`] : []),
  ].join(',');
}

function fieldSets(value: unknown): string[] {
  if (!Array.isArray(value)) return isObject(value) ? [safeFieldSignature(value)] : [];
  const seen = new Set<string>();
  for (const record of value) {
    if (!isObject(record)) {
      seen.add(`<${jsonShape(record)}>`);
    } else {
      seen.add(safeFieldSignature(record));
    }
    if (seen.size >= MAX_FIELD_SETS) break;
  }
  return [...seen];
}

function schemaVersions(value: unknown, key: DiagnosticsStorageKey): string[] {
  const values = new Set<string>();
  const keySuffix = key.match(/_v(\d+)$/);
  if (keySuffix) values.add(`key_suffix=v${keySuffix[1]}`);
  const records = Array.isArray(value) ? value : [value];
  for (const record of records) {
    if (!isObject(record)) continue;
    for (const field of ['schemaVersion', 'schema_version', 'version', 'v']) {
      const version = record[field];
      if (typeof version === 'number' && Number.isInteger(version) && version >= 0 && version <= 999) {
        values.add(`${field}=${version}`);
      } else if (
        typeof version === 'string'
        && /^v?\d{1,3}(?:\.\d{1,3}){0,2}$/.test(version)
      ) {
        values.add(`${field}=${version}`);
      }
    }
  }
  return [...values];
}

function validateParsedValue(
  definition: StorageDefinition,
  parsed: unknown,
): { valid: boolean; issue: string | null; recordCount: number | null } {
  if (definition.shape === 'expansion-state') {
    if (!isObject(parsed)) {
      return { valid: false, issue: `expected_object_received_${jsonShape(parsed)}`, recordCount: null };
    }
    const invalidField = Object.values(parsed).find((value) => typeof value !== 'boolean');
    return invalidField !== undefined
      ? { valid: false, issue: 'expansion_state_value_expected_boolean', recordCount: null }
      : { valid: true, issue: null, recordCount: null };
  }

  if (definition.shape === 'raw-boolean-flag') {
    return parsed === '0' || parsed === '1'
      ? { valid: true, issue: null, recordCount: null }
      : { valid: false, issue: 'expected_raw_0_or_1', recordCount: null };
  }

  if (!Array.isArray(parsed)) {
    return { valid: false, issue: `expected_array_received_${jsonShape(parsed)}`, recordCount: null };
  }

  for (let index = 0; index < parsed.length; index += 1) {
    const record = parsed[index];
    if (!isObject(record)) {
      return {
        valid: false,
        issue: `record_${index}_expected_object_received_${jsonShape(record)}`,
        recordCount: parsed.length,
      };
    }
    const issue = definition.validateRecord?.(record) ?? null;
    if (issue) {
      return {
        valid: false,
        issue: `record_${index}_${issue}`,
        recordCount: parsed.length,
      };
    }
  }

  return { valid: true, issue: null, recordCount: parsed.length };
}

async function writeProgress(
  auditId: string,
  key: DiagnosticsStorageKey,
  status: 'reading' | 'complete',
): Promise<void> {
  try {
    await AsyncStorage.setItem(AUDIT_PROGRESS_KEY, JSON.stringify({
      version: 1,
      auditId,
      key,
      status,
      at: new Date().toISOString(),
    }));
  } catch {
    // Console tracing remains available even if this independent marker fails.
  }
}

export async function auditDiagnosticsStorage(): Promise<DiagnosticsStorageAuditResult> {
  const auditId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const entries: DiagnosticsStorageAuditEntry[] = [];

  for (const definition of STORAGE_DEFINITIONS) {
    console.info(`[diagnostics-storage] read:start key=${definition.key}`);
    await writeProgress(auditId, definition.key, 'reading');
    let entry: DiagnosticsStorageAuditEntry;

    try {
      const raw = await AsyncStorage.getItem(definition.key);
      if (raw === null) {
        entry = {
          key: definition.key,
          status: 'missing',
          rawBytes: 0,
          jsonShape: 'missing',
          recordCount: null,
          issue: null,
          fieldSets: [],
          schemaVersions: schemaVersions({}, definition.key),
        };
      } else {
        try {
          const parsed: unknown = definition.shape === 'raw-boolean-flag'
            ? raw
            : JSON.parse(raw);
          const validation = validateParsedValue(definition, parsed);
          entry = {
            key: definition.key,
            status: validation.valid ? 'valid' : 'invalid',
            rawBytes: raw.length,
            jsonShape: jsonShape(parsed),
            recordCount: validation.recordCount,
            issue: validation.issue,
            fieldSets: fieldSets(parsed),
            schemaVersions: schemaVersions(parsed, definition.key),
          };
        } catch {
          entry = {
            key: definition.key,
            status: 'invalid',
            rawBytes: raw.length,
            jsonShape: 'unparseable',
            recordCount: null,
            issue: 'json_parse_failed',
            fieldSets: [],
            schemaVersions: schemaVersions({}, definition.key),
          };
        }
      }
    } catch {
      entry = {
        key: definition.key,
        status: 'read_error',
        rawBytes: 0,
        jsonShape: 'unknown',
        recordCount: null,
        issue: 'storage_read_failed',
        fieldSets: [],
        schemaVersions: schemaVersions({}, definition.key),
      };
    }

    entries.push(entry);
    console.info(
      `[diagnostics-storage] read:end key=${entry.key} status=${entry.status}`
      + ` shape=${entry.jsonShape} count=${entry.recordCount ?? 'n/a'}`
      + ` issue=${entry.issue ?? 'none'}`,
    );
    await writeProgress(auditId, definition.key, 'complete');
  }

  const result: DiagnosticsStorageAuditResult = {
    version: 1,
    auditId,
    createdAt: new Date().toISOString(),
    entries,
    invalidKeys: entries
      .filter((entry) => entry.status === 'invalid' || entry.status === 'read_error')
      .map((entry) => entry.key),
  };

  try {
    await AsyncStorage.setItem(AUDIT_RESULT_KEY, JSON.stringify(result));
    const rawHistory = await AsyncStorage.getItem(AUDIT_HISTORY_KEY);
    const parsedHistory = rawHistory ? JSON.parse(rawHistory) : [];
    const history = Array.isArray(parsedHistory) ? parsedHistory : [];
    history.push(result);
    await AsyncStorage.setItem(
      AUDIT_HISTORY_KEY,
      JSON.stringify(history.slice(-MAX_EVIDENCE_HISTORY)),
    );
  } catch {
    console.warn('[diagnostics-storage] could not persist audit');
  }
  return result;
}

export async function readLatestDiagnosticsStorageAudit(): Promise<DiagnosticsStorageAuditResult | null> {
  try {
    const raw = await AsyncStorage.getItem(AUDIT_RESULT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DiagnosticsStorageAuditResult;
    return parsed?.version === 1 && Array.isArray(parsed.entries) ? parsed : null;
  } catch {
    return null;
  }
}

export async function readDiagnosticsStorageEvidence(): Promise<DiagnosticsStorageEvidence> {
  try {
    const [auditRaw, cleanupRaw] = await Promise.all([
      AsyncStorage.getItem(AUDIT_HISTORY_KEY),
      AsyncStorage.getItem(CLEANUP_HISTORY_KEY),
    ]);
    const audits = auditRaw ? JSON.parse(auditRaw) : [];
    const cleanups = cleanupRaw ? JSON.parse(cleanupRaw) : [];
    return {
      audits: Array.isArray(audits) ? audits : [],
      cleanups: Array.isArray(cleanups) ? cleanups : [],
    };
  } catch {
    return { audits: [], cleanups: [] };
  }
}

async function recordCleanup(keys: DiagnosticsStorageKey[]): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(CLEANUP_HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    const history = Array.isArray(parsed) ? parsed : [];
    history.push({ at: new Date().toISOString(), keys });
    await AsyncStorage.setItem(
      CLEANUP_HISTORY_KEY,
      JSON.stringify(history.slice(-MAX_EVIDENCE_HISTORY)),
    );
  } catch {
    console.warn('[diagnostics-storage] could not persist cleanup record');
  }
}

export async function clearDiagnosticsStorageKey(
  key: DiagnosticsStorageKey,
): Promise<void> {
  const allowed = new Set<DiagnosticsStorageKey>(DIAGNOSTICS_STORAGE_KEYS);
  if (!allowed.has(key)) {
    throw new Error('diagnostics_storage_key_not_allowed');
  }
  await AsyncStorage.multiRemove([key]);
  await recordCleanup([key]);
}