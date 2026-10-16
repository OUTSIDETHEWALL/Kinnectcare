import AsyncStorage from '@react-native-async-storage/async-storage';
import type { EngineLogEvent } from './locationEngine';

const PREFIX = 'kc_engine_evidence_v2:';
const DAY = 24 * 60 * 60_000;
const runtime = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
let sequence = 0;
let queue: Promise<unknown> = Promise.resolve();
let lastPrune = 0;
const PRUNED_AT = 'kc_engine_evidence_pruned_at';
const category = (e: EngineLogEvent) =>
  /motion|activity|startup_outcome|ready_|Enabled|state_observed|app_background|app_foreground/i.test(e.event) ? 'transition'
    : /heartbeat/i.test(e.event) ? 'heartbeat'
      : /verified_coordinate|native_capture_observed|sdk_onHttp/i.test(e.event) ? 'delivery' : 'operational';
// Separate quotas prevent polling/retry noise from evicting a drive's transitions,
// stationary heartbeats or delivery receipts. Preserve one day, bounded per class.
const limits = { transition: 512, heartbeat: 512, delivery: 1024, operational: 50 };

async function entries(): Promise<{ key: string; record: EngineLogEvent }[]> {
  const keys = (await AsyncStorage.getAllKeys()).filter(k => k.startsWith(PREFIX));
  const values = await AsyncStorage.multiGet(keys);
  return values.flatMap(([key, raw]) => {
    try {
      const record = JSON.parse(raw ?? 'null');
      return record && Number.isFinite(record.at) && typeof record.event === 'string'
        ? [{ key, record }] : [];
    } catch { return []; }
  });
}

export function appendEngineEvidence(record: EngineLogEvent): Promise<unknown> {
  // Immutable per-event keys: no runtime can overwrite another runtime's array.
  const key = `${PREFIX}${record.at}:${runtime}:${++sequence}`;
  queue = queue.catch(() => {}).then(async () => {
    await AsyncStorage.setItem(key, JSON.stringify(record));
    if (Date.now() - lastPrune < 60_000) return;
    lastPrune = Date.now();
    const sharedPruneAt = Number(await AsyncStorage.getItem(PRUNED_AT));
    if (sharedPruneAt <= Date.now() && Date.now() - sharedPruneAt < 60_000) return;
    await AsyncStorage.setItem(PRUNED_AT, String(Date.now()));
    const all = (await entries()).sort((a, b) => b.record.at - a.record.at);
    const counts: Record<string, number> = {};
    const obsolete = all.filter(item => {
      const kind = category(item.record);
      counts[kind] = (counts[kind] ?? 0) + 1;
      return item.record.at < Date.now() - DAY || counts[kind] > limits[kind];
    }).map(item => item.key);
    // Only delete keys observed in this snapshot; concurrent appends are safe.
    if (obsolete.length) await AsyncStorage.multiRemove(obsolete);
  });
  return queue.catch(() => {});
}

export async function readEngineEvidence(): Promise<EngineLogEvent[]> {
  await queue.catch(() => {});
  try {
    return (await entries()).map(item => item.record)
      .filter(e => e.at >= Date.now() - DAY).sort((a, b) => a.at - b.at);
  } catch { return []; }
}

export async function clearEngineEvidence(): Promise<void> {
  await queue.catch(() => {});
  try {
    const keys = (await AsyncStorage.getAllKeys()).filter(k => k.startsWith(PREFIX));
    if (keys.length) await AsyncStorage.multiRemove(keys);
  } catch { /* Storage unavailable: diagnostic clearing must not mutate tracking. */ }
}
