/**
 * Dashboard Refresh Log — v1.2.0 (43) diagnostic instrumentation.
 *
 * Pure-additive ring buffer that captures, per dashboard `load()`:
 *
 *   1. WHO triggered the load (60-s interval / tab focus / AppState
 *      active / push received / pull-to-refresh / quick-checkin / etc).
 *   2. END-TO-END TIMESTAMPS for the GET /members round-trip:
 *      • `t_load_started` (entry into load())
 *      • `t_get_sent`     (right before axios call)
 *      • `t_get_received` (response back)
 *      • `t_setstate`     (members state replaced)
 *   3. RAW HTTP RESPONSE: the unaltered JSON members array as it came
 *      back from the server.  Each member doc captured with full
 *      shape (id, user_id, family_group_id, last_seen, latitude,
 *      longitude, location_name, every other field).  This is the
 *      single source of truth for "what did the API actually return".
 *   4. CASCADE TRACING: a list of member ids for which the dashboard
 *      then fired `requestMemberRefresh()` (i.e. they failed the
 *      60-s freshness threshold and the dashboard kicked off a
 *      silent push to the device).  This documents the link between
 *      Joyce's per-minute "K" notifications and Charles's stale
 *      view.
 *
 * Buffer persists to AsyncStorage so it survives app kill / restart
 * the same way the engine log does.  Read via `getDashboardLoadLog()`
 * (e.g. from the Diagnostics screen).
 *
 * Scope discipline (per founder directive — "no behavior changes"):
 * this file performs NO mutation of any other state.  It is read-only
 * recording.  Callers in dashboard.tsx instrument their existing
 * code paths to write entries here; no existing behavior changes.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { nextSeq } from './diagSeq';

const KEY = '@kinnship/dashboard_load_log_v1';
const MAX = 50;

export type DashboardLoadTrigger =
  | 'mount'
  | 'focus'
  | 'interval-60s'
  | 'appstate-active'
  | 'notif-received'
  | 'pull-to-refresh'
  | 'quick-checkin'
  | 'unknown';

/**
 * A single load() invocation, captured at every observable step.
 * Times are epoch ms (Date.now()).  Null until the step has run, so
 * a load() that fails partway through still leaves a record up to
 * the failure point.
 */
export type DashboardLoadEntry = {
  /** Global monotonic seq from diagSeq — strict ordering across all diagnostic streams. */
  seq: number;
  /** Source tag — always 'dashboard-load' for entries created by this module. */
  src: 'dashboard-load';
  /** Stable id for cross-referencing within the buffer. */
  id: string;
  /** What caused this load() to fire. */
  trigger: DashboardLoadTrigger;
  /** When the load() function was entered. */
  t_load_started: number;
  /** When axios.get('/members') was about to be issued. */
  t_get_sent: number | null;
  /** When the /members response was fully received. */
  t_get_received: number | null;
  /** When setMembers(...) was called with the parsed payload. */
  t_setstate: number | null;
  /** HTTP status code (null if request threw before response). */
  http_status: number | null;
  /** Number of members returned (null on error). */
  member_count: number | null;
  /**
   * The raw response body — full unfiltered array of member docs as
   * returned by GET /api/members.  Each entry contains every field
   * the server included for that member (id, user_id,
   * family_group_id, last_seen, latitude, longitude, location_name,
   * plus any extra fields the FamilyMember model serialised).
   *
   * Stored verbatim so we can compare what the API returned vs what
   * the UI rendered, byte-for-byte, no synthesis.
   */
  raw_members: any[] | null;
  /**
   * Member ids for which the dashboard then fired
   * requestMemberRefresh() because the member's `last_seen` failed
   * the 60-s freshness threshold.  Documents the silent-push
   * cascade.
   */
  staleness_triggered_for: string[];
  /** Free-form error string if anything threw. */
  error: string | null;
  /**
   * Optional clock-skew snapshot — server `Date` header if the
   * response includes one (Express/FastAPI both emit this).  Useful
   * to confirm device clock vs server clock.
   */
  server_date_header: string | null;
};

let buffer: DashboardLoadEntry[] = [];
let loaded = false;

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) buffer = JSON.parse(raw);
  } catch (_e) {
    buffer = [];
  }
  loaded = true;
}

async function persist(): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(buffer));
  } catch (_e) {
    // best-effort
  }
}

function nextId(): string {
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/**
 * Open a new entry at the top of load().  Returns the entry id so
 * the caller can pass it back into the subsequent update*() calls.
 * Safe to call from anywhere; never throws.
 */
export async function startLoad(trigger: DashboardLoadTrigger): Promise<string> {
  await ensureLoaded();
  const entry: DashboardLoadEntry = {
    seq: nextSeq(),
    src: 'dashboard-load',
    id: nextId(),
    trigger,
    t_load_started: Date.now(),
    t_get_sent: null,
    t_get_received: null,
    t_setstate: null,
    http_status: null,
    member_count: null,
    raw_members: null,
    staleness_triggered_for: [],
    error: null,
    server_date_header: null,
  };
  buffer.push(entry);
  if (buffer.length > MAX) buffer = buffer.slice(-MAX);
  await persist();
  return entry.id;
}

async function patch(id: string, patcher: (e: DashboardLoadEntry) => void): Promise<void> {
  await ensureLoaded();
  const e = buffer.find((x) => x.id === id);
  if (!e) return;
  try {
    patcher(e);
  } catch (_e) {
    // never throw out of the logger
  }
  await persist();
}

export async function markGetSent(id: string): Promise<void> {
  return patch(id, (e) => {
    e.t_get_sent = Date.now();
  });
}

export async function markGetReceived(
  id: string,
  opts: {
    status: number | null;
    raw_members: any[] | null;
    server_date_header?: string | null;
    error?: string | null;
  },
): Promise<void> {
  return patch(id, (e) => {
    e.t_get_received = Date.now();
    e.http_status = opts.status ?? null;
    e.raw_members = opts.raw_members ?? null;
    e.member_count = Array.isArray(opts.raw_members) ? opts.raw_members.length : null;
    e.server_date_header = opts.server_date_header ?? null;
    if (opts.error) e.error = opts.error;
  });
}

export async function markSetState(id: string): Promise<void> {
  return patch(id, (e) => {
    e.t_setstate = Date.now();
  });
}

export async function recordStalenessTrigger(id: string, memberId: string): Promise<void> {
  return patch(id, (e) => {
    if (!e.staleness_triggered_for.includes(memberId)) {
      e.staleness_triggered_for.push(memberId);
    }
  });
}

export async function markError(id: string, error: string): Promise<void> {
  return patch(id, (e) => {
    e.error = error;
  });
}

/** Read the full buffer (oldest-first). */
export async function getDashboardLoadLog(): Promise<DashboardLoadEntry[]> {
  await ensureLoaded();
  return [...buffer];
}

/** Clear the buffer (Diagnostics screen Clear button). */
export async function clearDashboardLoadLog(): Promise<void> {
  buffer = [];
  await persist();
}
