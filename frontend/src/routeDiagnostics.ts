/**
 * Beta-only routing diagnostics (P6 of the beta stabilization sprint).
 *
 * Captures every notification-tap routing decision into a rolling
 * AsyncStorage buffer (last 50 entries).  Viewable via a hidden
 * 5-tap gesture on the welcome-screen logo, which renders a
 * read-only screen of the log entries.
 *
 * ─────────────────────────────────────────────────────────────
 *  // KEEP THROUGH BETA WAVE 1 — DO NOT REMOVE YET
 *    Per user direction: routing data across different devices /
 *    Android versions is valuable.  Re-evaluate removal after the
 *    first beta wave completes and we have a corpus of logs to
 *    learn from.  When removing: drop this file, the import in
 *    app/_layout.tsx, and the planned Settings → Diagnostics →
 *    Copy Log button (TBD).
 * ─────────────────────────────────────────────────────────────
 *
 * Format of each entry (JSON-stringified, line per event):
 *   {
 *     t:    1719456000123,        // unix ms
 *     type: 'sos' | 'medication' | 'missed_checkin' | 'fall_detected' |
 *           'family_med_alert' | 'checkin' | string,
 *     loggedIn: true | false,
 *     hasPin: true | false | null,    // null = not yet checked
 *     pinUnlocked: true | false | null,
 *     fromSegment: string,        // '/(tabs)/dashboard' etc.
 *     toRoute: string,            // '/alert/[id]' etc.
 *     reason: string,             // 'tap', 'cold-start', 'foreground-deep-link'
 *     alertId: string | null,
 *   }
 *
 * The log is bounded (capacity 50) — older entries roll off
 * automatically so the storage cost never grows unboundedly.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DIAG_BUFFER_SIZES, pruneBuffer } from './diagBufferConfig';

const KEY = '@kinnship/route_diagnostics_v1';
const CAP = DIAG_BUFFER_SIZES.routeLog;

export type RouteDiagEntry = {
  t: number;
  type?: string;
  loggedIn?: boolean;
  hasPin?: boolean | null;
  pinUnlocked?: boolean | null;
  fromSegment?: string;
  toRoute?: string;
  reason?: string;
  alertId?: string | null;
};

export async function logRouteDecision(entry: Omit<RouteDiagEntry, 't'>): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    let arr: RouteDiagEntry[] = raw ? JSON.parse(raw) : [];
    arr.push({ t: Date.now(), ...entry });
    arr = pruneBuffer(arr, (e) => e.t, CAP);
    await AsyncStorage.setItem(KEY, JSON.stringify(arr));
  } catch (_e) {
    // best-effort, never block routing
  }
}

export async function readRouteLog(): Promise<RouteDiagEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const arr: RouteDiagEntry[] = raw ? JSON.parse(raw) : [];
    return pruneBuffer(arr, (e) => e.t, CAP);
  } catch (_e) {
    return [];
  }
}

export async function clearRouteLog(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY);
  } catch (_e) {}
}
