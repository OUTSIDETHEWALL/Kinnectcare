import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Member } from './api';

const SNAPSHOT_KEY = 'kc_stale_location_pipeline_snapshots_v1';
const MAX_SNAPSHOTS = 20;
export const MOVING_SPEED_MPS = 2.2352; // 5 mph
export const SIGNIFICANT_CHANGE_METERS = 100;
export const COORDINATE_MATCH_METERS = 30;

export type Coordinate = { latitude: number; longitude: number };

export type LocationPipelineTrace = {
  trace_id: string;
  native_gps_at: string | null;
  native_latitude: number | null;
  native_longitude: number | null;
  upload_at: string;
  upload_timestamp_source: string;
  backend_received_at: string;
  mongo_write_at: string;
  stored_latitude: number | null;
  stored_longitude: number | null;
  speed_mps: number | null;
  accuracy_m: number | null;
  provider: string | null;
  is_moving: boolean | null;
  members_response_at?: string | null;
  dashboard_response_at?: string | null;
};

export type PipelineFailureStage = 'device' | 'backend' | 'api' | 'store' | 'ui';

export type StaleLocationPipelineSnapshot = {
  kind: 'STALE_LOCATION_PIPELINE_SNAPSHOT';
  trace_id: string;
  member_id: string;
  created_at: string;
  trigger: 'speed_over_5_mph' | 'significant_location_change';
  failure_stage: PipelineFailureStage;
  native_gps_timestamp: string | null;
  native_gps_coordinates: Coordinate | null;
  upload_timestamp: string;
  upload_timestamp_source: string;
  backend_receive_timestamp: string;
  mongo_write_timestamp: string;
  members_response_timestamp: string | null;
  dashboard_response_timestamp: string | null;
  dashboard_store_timestamp: string;
  map_props_timestamp: string | null;
  map_props_coordinates: Coordinate | null;
  map_render_timestamp: string;
  map_render_coordinates: Coordinate;
  backend_stored_coordinates: Coordinate | null;
  api_response_coordinates: Coordinate | null;
  dashboard_store_coordinates: Coordinate | null;
  previous_dashboard_coordinates: Coordinate | null;
  speed_mps: number | null;
  speed_mph: number | null;
  accuracy_m: number | null;
  provider: string | null;
  is_moving: boolean | null;
  distances_m: {
    native_to_backend: number | null;
    backend_to_api: number | null;
    api_to_store: number | null;
    store_to_map: number | null;
    previous_to_native: number | null;
  };
};

const FAILURE_STAGES = new Set<PipelineFailureStage>(['device', 'backend', 'api', 'store', 'ui']);

function isCoordinate(value: unknown): value is Coordinate {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Coordinate>;
  return typeof candidate.latitude === 'number'
    && Number.isFinite(candidate.latitude)
    && typeof candidate.longitude === 'number'
    && Number.isFinite(candidate.longitude);
}

function isNullableCoordinate(value: unknown): value is Coordinate | null {
  return value === null || isCoordinate(value);
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isPipelineSnapshot(value: unknown): value is StaleLocationPipelineSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<StaleLocationPipelineSnapshot>;
  return snapshot.kind === 'STALE_LOCATION_PIPELINE_SNAPSHOT'
    && typeof snapshot.trace_id === 'string'
    && snapshot.trace_id.length > 0
    && typeof snapshot.member_id === 'string'
    && typeof snapshot.created_at === 'string'
    && (snapshot.trigger === 'speed_over_5_mph' || snapshot.trigger === 'significant_location_change')
    && typeof snapshot.failure_stage === 'string'
    && FAILURE_STAGES.has(snapshot.failure_stage as PipelineFailureStage)
    && isNullableString(snapshot.native_gps_timestamp)
    && isNullableCoordinate(snapshot.native_gps_coordinates)
    && typeof snapshot.upload_timestamp === 'string'
    && typeof snapshot.upload_timestamp_source === 'string'
    && typeof snapshot.backend_receive_timestamp === 'string'
    && typeof snapshot.mongo_write_timestamp === 'string'
    && isNullableString(snapshot.members_response_timestamp)
    && isNullableString(snapshot.dashboard_response_timestamp)
    && typeof snapshot.dashboard_store_timestamp === 'string'
    && isNullableString(snapshot.map_props_timestamp)
    && isNullableCoordinate(snapshot.map_props_coordinates)
    && typeof snapshot.map_render_timestamp === 'string'
    && isCoordinate(snapshot.map_render_coordinates)
    && isNullableCoordinate(snapshot.backend_stored_coordinates)
    && isNullableCoordinate(snapshot.api_response_coordinates)
    && isNullableCoordinate(snapshot.dashboard_store_coordinates)
    && isNullableCoordinate(snapshot.previous_dashboard_coordinates)
    && isNullableFiniteNumber(snapshot.speed_mps)
    && isNullableFiniteNumber(snapshot.speed_mph)
    && isNullableFiniteNumber(snapshot.accuracy_m)
    && isNullableString(snapshot.provider)
    && (snapshot.is_moving === null || typeof snapshot.is_moving === 'boolean')
    && !!snapshot.distances_m
    && typeof snapshot.distances_m === 'object';
}

/**
 * AsyncStorage JSON is untrusted at runtime. Keep malformed or partially
 * written records out of Diagnostics so one bad entry cannot blank the screen.
 */
export function normalizePipelineSnapshots(value: unknown): StaleLocationPipelineSnapshot[] {
  return Array.isArray(value) ? value.filter(isPipelineSnapshot) : [];
}

type Candidate = Omit<
  StaleLocationPipelineSnapshot,
  | 'kind'
  | 'created_at'
  | 'failure_stage'
  | 'map_props_timestamp'
  | 'map_props_coordinates'
  | 'map_render_timestamp'
  | 'map_render_coordinates'
  | 'distances_m'
> & {
  map_props_timestamp: string | null;
  map_props_coordinates: Coordinate | null;
};

const pending = new Map<string, Candidate>();
const emittedTraceIds = new Set<string>();
const processedTraceIds = new Set<string>();
let snapshots: StaleLocationPipelineSnapshot[] = [];
let loaded = false;
let writeQueue: Promise<void> = Promise.resolve();

function coord(latitude: unknown, longitude: unknown): Coordinate | null {
  return typeof latitude === 'number' && Number.isFinite(latitude)
    && typeof longitude === 'number' && Number.isFinite(longitude)
    ? { latitude, longitude }
    : null;
}

export function distanceMeters(a: Coordinate | null, b: Coordinate | null): number | null {
  if (!a || !b) return null;
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const lat1 = a.latitude * rad;
  const lat2 = b.latitude * rad;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function differs(a: Coordinate | null, b: Coordinate | null): boolean {
  const d = distanceMeters(a, b);
  return d === null || d > COORDINATE_MATCH_METERS;
}

function iso(at: number): string {
  return new Date(at).toISOString();
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await AsyncStorage.getItem(SNAPSHOT_KEY);
    snapshots = normalizePipelineSnapshots(raw ? JSON.parse(raw) : []);
    for (const item of snapshots) emittedTraceIds.add(item.trace_id);
  } catch {
    snapshots = [];
  }
}

function persistSnapshot(snapshot: StaleLocationPipelineSnapshot): void {
  writeQueue = writeQueue.then(async () => {
    await ensureLoaded();
    if (emittedTraceIds.has(snapshot.trace_id)) return;
    emittedTraceIds.add(snapshot.trace_id);
    snapshots.push(snapshot);
    snapshots = snapshots.slice(-MAX_SNAPSHOTS);
    await AsyncStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshots));
  }).catch(() => {});
}

/**
 * Add the caregiver's actual axios receive time without replacing the
 * backend-generated /members response timestamp.
 */
export function stampMembersResponse<T extends Member>(members: T[], at = Date.now()): T[] {
  return members.map((member) => {
    const trace = (member as any).location_pipeline as LocationPipelineTrace | undefined;
    if (!trace?.trace_id) return member;
    return {
      ...member,
      location_pipeline: { ...trace, dashboard_response_at: iso(at) },
    };
  });
}

/**
 * Start one possible smoking-gun snapshot after the canonical store commit.
 * Nothing is persisted until the map confirms that it rendered a coordinate
 * inconsistent with the moving fix.
 */
export function observeStoreCommit(
  apiMember: Member,
  committedMember: Member,
  previousMember?: Member,
  at = Date.now(),
): void {
  const trace = (apiMember as any).location_pipeline as LocationPipelineTrace | undefined;
  if (!trace?.trace_id || emittedTraceIds.has(trace.trace_id) || processedTraceIds.has(trace.trace_id)) return;
  const existing = pending.get(apiMember.id);
  if (existing?.trace_id === trace.trace_id) return;

  const native = coord(trace.native_latitude, trace.native_longitude);
  const previous = coord(previousMember?.latitude, previousMember?.longitude);
  const backend = coord(trace.stored_latitude, trace.stored_longitude);
  const api = coord(apiMember.latitude, apiMember.longitude);
  const store = coord(committedMember.latitude, committedMember.longitude);
  const speed = typeof trace.speed_mps === 'number' ? trace.speed_mps : null;
  const significant = (distanceMeters(previous, native) ?? 0) >= SIGNIFICANT_CHANGE_METERS;
  const movingBySpeed = speed !== null && speed > MOVING_SPEED_MPS;
  if (!movingBySpeed && !significant) return;

  pending.set(apiMember.id, {
    trace_id: trace.trace_id,
    member_id: apiMember.id,
    trigger: movingBySpeed ? 'speed_over_5_mph' : 'significant_location_change',
    native_gps_timestamp: trace.native_gps_at,
    native_gps_coordinates: native,
    upload_timestamp: trace.upload_at,
    upload_timestamp_source: trace.upload_timestamp_source,
    backend_receive_timestamp: trace.backend_received_at,
    mongo_write_timestamp: trace.mongo_write_at,
    members_response_timestamp: trace.members_response_at ?? null,
    dashboard_response_timestamp: trace.dashboard_response_at ?? null,
    dashboard_store_timestamp: iso(at),
    map_props_timestamp: null,
    map_props_coordinates: null,
    backend_stored_coordinates: backend,
    api_response_coordinates: api,
    dashboard_store_coordinates: store,
    previous_dashboard_coordinates: previous,
    speed_mps: speed,
    speed_mph: speed === null ? null : speed * 2.236936,
    accuracy_m: typeof trace.accuracy_m === 'number' ? trace.accuracy_m : null,
    provider: trace.provider ?? null,
    is_moving: trace.is_moving ?? null,
  });
}

export function observeMapProps(
  memberId: string | null | undefined,
  latitude: number,
  longitude: number,
  at = Date.now(),
): void {
  if (!memberId) return;
  const candidate = pending.get(memberId);
  if (!candidate) return;
  candidate.map_props_timestamp = iso(at);
  candidate.map_props_coordinates = coord(latitude, longitude);
}

function firstFailureStage(
  candidate: Candidate,
  rendered: Coordinate,
): PipelineFailureStage {
  const native = candidate.native_gps_coordinates;
  if (
    candidate.trigger === 'speed_over_5_mph'
    && !differs(native, candidate.previous_dashboard_coordinates)
  ) return 'device';
  if (differs(native, candidate.backend_stored_coordinates)) return 'backend';
  if (differs(candidate.backend_stored_coordinates, candidate.api_response_coordinates)) return 'api';
  if (differs(candidate.api_response_coordinates, candidate.dashboard_store_coordinates)) return 'store';
  if (
    differs(candidate.dashboard_store_coordinates, candidate.map_props_coordinates)
    || differs(candidate.map_props_coordinates, rendered)
  ) return 'ui';
  return 'device';
}

/**
 * Finalize exactly one snapshot when the WebView confirms that the rendered
 * marker remained at the previous coordinate instead of the moving fix.
 */
export function observeMapRendered(
  memberId: string | null | undefined,
  latitude: number,
  longitude: number,
  traceId: string | null | undefined,
  at = Date.now(),
): StaleLocationPipelineSnapshot | null {
  if (!memberId) return null;
  const candidate = pending.get(memberId);
  if (!candidate) return null;
  // A WebView callback can arrive after a newer store commit. Never attach an
  // old marker acknowledgement to a newer GPS trace.
  if (!traceId || traceId !== candidate.trace_id) return null;
  const rendered = coord(latitude, longitude);
  if (!rendered) return null;

  const previous = candidate.previous_dashboard_coordinates;
  const native = candidate.native_gps_coordinates;
  const significantMoveButOldRender =
    (distanceMeters(previous, native) ?? 0) >= SIGNIFICANT_CHANGE_METERS
    && !differs(rendered, previous)
    && differs(rendered, native);
  const movingSpeedButNoCoordinateProgress =
    candidate.trigger === 'speed_over_5_mph'
    && !differs(native, previous)
    && !differs(rendered, previous);
  if (!significantMoveButOldRender && !movingSpeedButNoCoordinateProgress) {
    // Healthy movement reached the rendered marker. This trace is complete.
    pending.delete(memberId);
    processedTraceIds.add(candidate.trace_id);
    return null;
  }

  const snapshot: StaleLocationPipelineSnapshot = {
    ...candidate,
    kind: 'STALE_LOCATION_PIPELINE_SNAPSHOT',
    created_at: iso(at),
    failure_stage: firstFailureStage(candidate, rendered),
    map_render_timestamp: iso(at),
    map_render_coordinates: rendered,
    distances_m: {
      native_to_backend: distanceMeters(native, candidate.backend_stored_coordinates),
      backend_to_api: distanceMeters(candidate.backend_stored_coordinates, candidate.api_response_coordinates),
      api_to_store: distanceMeters(candidate.api_response_coordinates, candidate.dashboard_store_coordinates),
      store_to_map: distanceMeters(candidate.dashboard_store_coordinates, rendered),
      previous_to_native: distanceMeters(previous, native),
    },
  };
  pending.delete(memberId);
  processedTraceIds.add(candidate.trace_id);
  persistSnapshot(snapshot);
  return snapshot;
}

export async function readPipelineSnapshots(): Promise<StaleLocationPipelineSnapshot[]> {
  await writeQueue;
  await ensureLoaded();
  return [...snapshots].reverse();
}

export async function clearPipelineSnapshots(): Promise<void> {
  await writeQueue;
  snapshots = [];
  emittedTraceIds.clear();
  processedTraceIds.clear();
  pending.clear();
  loaded = true;
  await AsyncStorage.removeItem(SNAPSHOT_KEY).catch(() => {});
}
