import AsyncStorage from '@react-native-async-storage/async-storage';

export const LOCATION_UPLOAD_SUCCESS_KEY = 'kc_pts_http_ok';
const LOCATION_UPLOAD_SUCCESS_MARKER_PREFIX = `${LOCATION_UPLOAD_SUCCESS_KEY}:`;
const MARKERS_TO_KEEP = 4;

let writeQueue: Promise<void> = Promise.resolve();

function timestampFromMarkerKey(key: string): number | null {
  if (!key.startsWith(LOCATION_UPLOAD_SUCCESS_MARKER_PREFIX)) return null;
  const value = Number(key.slice(LOCATION_UPLOAD_SUCCESS_MARKER_PREFIX.length));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

async function readMarkerKeys(): Promise<string[]> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    return keys.filter((key) => timestampFromMarkerKey(key) !== null);
  } catch {
    return [];
  }
}

async function pruneOldMarkers(): Promise<void> {
  try {
    const markers = await readMarkerKeys();
    const ordered = markers.sort(
      (a, b) => (timestampFromMarkerKey(b) ?? 0) - (timestampFromMarkerKey(a) ?? 0),
    );
    const obsolete = ordered.slice(MARKERS_TO_KEEP);
    if (obsolete.length > 0) await AsyncStorage.multiRemove(obsolete);
  } catch {
    // Marker cleanup is best-effort and must not affect location uploads.
  }
}

/**
 * Record one server-accepted location upload, regardless of transport.
 *
 * Each success gets its own timestamped marker key. Foreground, headless, and
 * TaskManager runtimes can complete in any order without an older completion
 * overwriting newer evidence. The legacy key remains a compatibility cache.
 */
export function recordLocationUploadSuccess(atMs: number = Date.now()): Promise<void> {
  const candidate = Number.isFinite(atMs) && atMs >= 0 ? atMs : Date.now();
  const markerKey = `${LOCATION_UPLOAD_SUCCESS_MARKER_PREFIX}${candidate}`;

  writeQueue = writeQueue
    .then(async () => {
      try {
        await AsyncStorage.setItem(markerKey, '1');
        await AsyncStorage.setItem(LOCATION_UPLOAD_SUCCESS_KEY, String(candidate));
        await pruneOldMarkers();
      } catch {
        // Diagnostics evidence must never interfere with location uploads.
      }
    })
    .catch(() => {
      // Keep the queue usable after an unexpected promise failure.
    });

  return writeQueue;
}

/** Read the newest success across cross-runtime markers and the legacy cache. */
export async function getLocationUploadSuccessTs(): Promise<number | null> {
  const [legacyRaw, markers] = await Promise.all([
    AsyncStorage.getItem(LOCATION_UPLOAD_SUCCESS_KEY).catch(() => null),
    readMarkerKeys(),
  ]);

  const candidates = markers
    .map(timestampFromMarkerKey)
    .filter((value): value is number => value !== null);
  const legacy = legacyRaw ? Number(legacyRaw) : null;
  if (legacy !== null && Number.isFinite(legacy) && legacy >= 0) candidates.push(legacy);
  return candidates.length > 0 ? Math.max(...candidates) : null;
}