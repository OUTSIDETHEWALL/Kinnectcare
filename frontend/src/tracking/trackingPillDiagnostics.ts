/**
 * Build 53 — TrackingStatusPill decision log (temporary diagnostic).
 *
 * Records every render of the shared <TrackingStatusPill />: the exact
 * inputs it received and the status kind it chose.  Meant for
 * remote-debugging Charles's "why yellow when Joyce is fine" reports
 * without shipping console.log spam.
 *
 * Hidden behind the Diagnostics screen; will be removed before RC.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DIAG_BUFFER_SIZES, pruneBuffer } from '../diagBufferConfig';

const KEY = '@kinnship/tracking_pill_decisions_v1';
const CAP = DIAG_BUFFER_SIZES.resumeDecisions; // reuse cap size — 30 entries

export type TrackingPillDecisionEntry = {
  t: number;                    // unix ms
  screen: string;               // e.g. 'alert', 'member', 'dashboard-card'
  hasCoords: boolean;
  lastSeenIso: string | null;
  ageMs: number | null;         // now − new Date(lastSeenIso)
  kind: string;                 // 'healthy' | 'updating' | 'last-known' | 'unavailable'
  reason: string;               // human-readable why-this-kind
};

export async function logTrackingPillDecision(
  entry: Omit<TrackingPillDecisionEntry, 't'>,
): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    let arr: TrackingPillDecisionEntry[] = raw ? JSON.parse(raw) : [];
    arr.push({ t: Date.now(), ...entry });
    arr = pruneBuffer(arr, (e) => e.t, CAP);
    await AsyncStorage.setItem(KEY, JSON.stringify(arr));
  } catch (_e) {
    // best-effort — never block a render on a diagnostic write
  }
}

export async function readTrackingPillDecisions(): Promise<TrackingPillDecisionEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const arr: TrackingPillDecisionEntry[] = raw ? JSON.parse(raw) : [];
    return pruneBuffer(arr, (e) => e.t, CAP);
  } catch (_e) {
    return [];
  }
}

export async function clearTrackingPillDecisions(): Promise<void> {
  try { await AsyncStorage.removeItem(KEY); } catch (_e) {}
}
