import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = '@kinnship/startup_diagnostics_v1';
const CAP = 120;
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const startedAt = Date.now();
let seq = 0;
let writeQueue: Promise<void> = Promise.resolve();

export type StartupPhase =
  | 'app_cold_start'
  | 'session_restore'
  | 'pending_invite_load'
  | 'consumed_token_check'
  | 'deep_link_processing'
  | 'root_navigation_decision'
  | 'final_route_committed';

export type StartupDiagnosticEntry = {
  t: number;
  elapsedMs: number;
  runId: string;
  seq: number;
  phase: StartupPhase;
  event: string;
  route?: string | null;
  reason?: string;
  outcome?: string;
  details?: Record<string, boolean | number | string | null>;
};

/**
 * One process-wide, serialized startup trace. Callers never await this function:
 * diagnostics must preserve ordering without delaying authentication or routing.
 * Tokens, URLs, email addresses, and user IDs must never be included.
 */
export function logStartupEvent(
  entry: Omit<StartupDiagnosticEntry, 't' | 'elapsedMs' | 'runId' | 'seq'>,
): void {
  const diagnostic: StartupDiagnosticEntry = {
    t: Date.now(),
    elapsedMs: Date.now() - startedAt,
    runId,
    seq: ++seq,
    ...entry,
  };

  console.info('[startup-trace]', diagnostic);
  writeQueue = writeQueue
    .then(async () => {
      const raw = await AsyncStorage.getItem(KEY);
      const current: StartupDiagnosticEntry[] = raw ? JSON.parse(raw) : [];
      current.push(diagnostic);
      await AsyncStorage.setItem(KEY, JSON.stringify(current.slice(-CAP)));
    })
    .catch(() => {
      // Diagnostics are best-effort and must never affect startup.
    });
}

export async function readStartupDiagnostics(): Promise<StartupDiagnosticEntry[]> {
  try {
    await writeQueue;
    const raw = await AsyncStorage.getItem(KEY);
    const entries: StartupDiagnosticEntry[] = raw ? JSON.parse(raw) : [];
    return entries.slice(-CAP);
  } catch (_e) {
    return [];
  }
}

logStartupEvent({
  phase: 'app_cold_start',
  event: 'javascript_runtime_started',
});