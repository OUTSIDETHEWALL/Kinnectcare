/**
 * Build #50 hotfix — SOS auto-resume decision log.
 *
 * Every AppState→active foreground transition may or may not auto-navigate
 * the user to an active SOS incident screen.  This ring buffer records the
 * REASON for every decision — resumed OR suppressed — so post-mortem
 * debugging (e.g. "why did the app trap me on a 4-hour-old alert") is
 * evidence-based rather than guesswork.
 *
 * Suppression reasons we care about (per user directive):
 *   • no-cached-alert            — /alerts returned zero unresolved SOS
 *   • already-viewing            — pathname already on /alert/<same-id>
 *   • stale-alert                — SOS older than 5 min → dashboard banner instead
 *   • already-resolved           — alert.resolved === true
 *   • dismissed-this-session     — user already got a 404 for this id
 *   • fetch-failed               — /alerts network / auth error
 *   • cross-tenant-404           — resolve/GET returned 404 (foreign or deleted)
 *   • cooldown                   — < 3 s since last check (prevents tight loop)
 *
 * Resume reasons:
 *   • resumed                    — successful redirect to /alert/<id>
 *   • resumed-banner             — dashboard banner shown (stale-but-active)
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DIAG_BUFFER_SIZES, pruneBuffer } from './diagBufferConfig';

const KEY = '@kinnship/resume_decisions_v1';
const CAP = DIAG_BUFFER_SIZES.resumeDecisions;

export type ResumeDecisionReason =
  | 'resumed'
  | 'resumed-banner'
  | 'no-cached-alert'
  | 'already-viewing'
  | 'stale-alert'
  | 'already-resolved'
  | 'dismissed-this-session'
  | 'fetch-failed'
  | 'cross-tenant-404'
  | 'get-404'
  | 'resolve-404'
  | 'cooldown'
  | 'no-user';

export type ResumeDecisionEntry = {
  t: number;                    // unix ms
  reason: ResumeDecisionReason;
  alertId?: string | null;
  ageMs?: number | null;        // age of the candidate alert at decision time
  fromPathname?: string | null; // what screen the user was on
  detail?: string | null;       // free-form supplementary info
};

export async function logResumeDecision(entry: Omit<ResumeDecisionEntry, 't'>): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    let arr: ResumeDecisionEntry[] = raw ? JSON.parse(raw) : [];
    arr.push({ t: Date.now(), ...entry });
    arr = pruneBuffer(arr, (e) => e.t, CAP);
    await AsyncStorage.setItem(KEY, JSON.stringify(arr));
  } catch (_e) {
    // best-effort — never block routing on a diagnostic write
  }
}

export async function readResumeDecisions(): Promise<ResumeDecisionEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const arr: ResumeDecisionEntry[] = raw ? JSON.parse(raw) : [];
    return pruneBuffer(arr, (e) => e.t, CAP);
  } catch (_e) {
    return [];
  }
}

export async function clearResumeDecisions(): Promise<void> {
  try { await AsyncStorage.removeItem(KEY); } catch (_e) {}
}

/**
 * Session-scoped dismissed-alert-IDs set.  Any alert_id that returned
 * 404 on /alerts GET or /alerts/{id}/resolve is added here so subsequent
 * auto-resume checks skip it (prevents a re-trap loop within the same
 * JS process lifetime).  Cleared on process restart — that's fine, the
 * backend migration will have marked those alerts as resolved by then.
 */
const dismissedThisSession = new Set<string>();

export function markAlertDismissed(id: string): void {
  if (id) dismissedThisSession.add(id);
}
export function isAlertDismissed(id: string): boolean {
  return !!id && dismissedThisSession.has(id);
}
export function clearDismissedSession(): void {
  dismissedThisSession.clear();
}
