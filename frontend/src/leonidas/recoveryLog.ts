/**
 * Leonidas Recovery Log — separate ring buffer (per spec section 6).
 *
 * Persisted to AsyncStorage so it survives app kill / restart, same
 * convention as the engine log and dashboard load log.  Shares the
 * global `diagSeq` counter from Build 44 so every Leonidas entry can
 * be cross-correlated with engine / dashboard / card-render entries
 * in a unified timeline.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { nextSeq } from '../diagSeq';
import { pruneBuffer } from '../diagBufferConfig';
import {
  RecoveryLogEntry,
  RECOVERY_LOG_MAX,
  LeonidasEventType,
  HealthState,
} from './types';

const KEY = '@kinnship/leonidas_recovery_log_v1';

let buffer: RecoveryLogEntry[] = [];
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

/**
 * Append a single recovery log entry.  Safe to call from anywhere;
 * never throws.
 */
export async function logRecovery(
  event: LeonidasEventType,
  health_state: HealthState,
  detail?: Record<string, any>,
): Promise<void> {
  await ensureLoaded();
  buffer.push({
    seq: nextSeq(),
    src: 'leonidas',
    at: Date.now(),
    event,
    health_state,
    detail,
  });
  buffer = pruneBuffer(buffer, (e) => e.at, RECOVERY_LOG_MAX);
  await persist();
}

export async function getRecoveryLog(): Promise<RecoveryLogEntry[]> {
  await ensureLoaded();
  buffer = pruneBuffer(buffer, (e) => e.at, RECOVERY_LOG_MAX);
  return [...buffer];
}

export async function clearRecoveryLog(): Promise<void> {
  buffer = [];
  await persist();
}
