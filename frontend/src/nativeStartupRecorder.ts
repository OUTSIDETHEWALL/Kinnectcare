export type NativeStartupCheckpoint = {
  wallClockMs: number;
  elapsedRealtimeMs: number;
  runId: string;
  sequence: number;
  event: string;
  metadata?: Record<string, boolean | number>;
};

export type NativeStartupSnapshot = {
  records: NativeStartupCheckpoint[];
  latest?: NativeStartupCheckpoint;
};

/**
 * The native boundary persists only these startup-state primitives. Keep this
 * closed so future call sites cannot accidentally add identifying metadata.
 */
export type NativeStartupMetadataKey =
  | 'authenticated'
  | 'pathnameObserved'
  | 'coldStart'
  | 'urlPresent'
  | 'invitePresent'
  | 'accepted'
  | 'alreadyConsumed'
  | 'persistenceFailed'
  | 'android';

type StartupDiagnosticsModule = {
  record(event: string, metadataJson?: string): boolean;
  read(): string;
  clear(): boolean;
};

type OptionalModuleResolver = <T>(moduleName: string) => T | null;

function module(): StartupDiagnosticsModule | null {
  try {
    // Keep this lazy: Jest's existing transform deliberately does not transpile
    // expo-modules-core sources, and web/older clients may not ship this module.
    // `expo` is the SDK-supported public surface for Expo Module lookup.
    const expo = require('expo') as {
      requireOptionalNativeModule?: OptionalModuleResolver;
    };
    return expo.requireOptionalNativeModule?.<StartupDiagnosticsModule>('StartupDiagnostics') ?? null;
  } catch {
    return null;
  }
}

/** Synchronous: a true result means the native SharedPreferences commit completed. */
export function recordNativeStartupCheckpoint(
  event: string,
  metadata?: Partial<Record<NativeStartupMetadataKey, boolean | number>>,
): boolean {
  try {
    return module()?.record(event, metadata ? JSON.stringify(metadata) : undefined) === true;
  } catch {
    return false;
  }
}

export function readNativeStartupCheckpoints(): NativeStartupSnapshot {
  try {
    const raw = module()?.read();
    if (!raw) return { records: [] };
    const parsed = JSON.parse(raw) as Partial<NativeStartupSnapshot>;
    const records = Array.isArray(parsed.records)
      ? parsed.records.filter(isCheckpoint).sort((a, b) => a.sequence - b.sequence)
      : [];
    return { records, latest: isCheckpoint(parsed.latest) ? parsed.latest : undefined };
  } catch {
    return { records: [] };
  }
}

export function clearNativeStartupCheckpoints(): boolean {
  try {
    return module()?.clear() === true;
  } catch {
    return false;
  }
}

function isCheckpoint(value: unknown): value is NativeStartupCheckpoint {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.wallClockMs === 'number'
    && typeof item.elapsedRealtimeMs === 'number'
    && typeof item.runId === 'string'
    && typeof item.sequence === 'number'
    && typeof item.event === 'string';
}