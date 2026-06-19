/**
 * v1.2.8 — Read-path render-trace.
 *
 * Purpose: prove which of these three is happening when Charles sees
 * Joyce stuck at home despite a healthy backend:
 *
 *   A) API returned fresh coords but the WebView still paints the
 *      old marker.  -> we'll see a `dashboard-fetch` or
 *      `member-fetch` entry with fresh lat/lon, then a `map-props`
 *      entry confirming the new coords were handed to MemberMap,
 *      but NO `map-rendered` entry (or one with the OLD coords).
 *
 *   B) API returned stale coords.  -> the `*-fetch` entry itself
 *      will show stale lat/lon and a stale `last_seen`.
 *
 *   C) API returned fresh coords but React state stayed stale.
 *      -> the raw axios response gets logged INSIDE the load()
 *      function before setState, so the log will show fresh data
 *      even though the screen still renders old.  We then know
 *      setData ran but the render didn't pick it up.
 *
 * Always-on rolling buffer (last 200 entries).  The Diagnostics
 * screen surfaces it inline and the Copy Log payload embeds it
 * verbatim under `screenRenderLog`.
 *
 * PRIVACY: coords get rounded to 0.001° (~110 m) which is enough
 * resolution to tell "home vs. Walmart 2 miles away" but not
 * enough to leak a precise position through a support email.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'kc_screen_render_log';
const MAX_ENTRIES = 200;

export type ScreenRenderSrc =
  | 'dashboard-fetch'   // <Dashboard>.load() axios returned
  | 'member-fetch'      // /member/[id].load() axios returned
  | 'map-props'         // MemberMap saw new coords in its props
  | 'map-rendered';     // WebView posted back after marker.setLatLng

export type ScreenRenderEntry = {
  t: number;
  src: ScreenRenderSrc;
  memberId?: string | null;   // last-6 chars surfaced in Diagnostics, full id in payload
  lat?: number | null;        // rounded to 0.001 deg
  lon?: number | null;        // rounded to 0.001 deg
  lastSeen?: string | null;
  locationName?: string | null;
  // dashboard-fetch only: enumerated members count
  memberCount?: number;
  // map-rendered only: ms from prop-change → rendered confirmation
  renderLatencyMs?: number;
};

function r3(n: number | null | undefined): number | null {
  if (typeof n !== 'number') return null;
  return Math.round(n * 1000) / 1000;
}

export async function logScreenRender(entry: Omit<ScreenRenderEntry, 't'> & { t?: number }): Promise<void> {
  try {
    const e: ScreenRenderEntry = {
      t: entry.t ?? Date.now(),
      src: entry.src,
      memberId: entry.memberId ?? null,
      lat: r3(entry.lat ?? null),
      lon: r3(entry.lon ?? null),
      lastSeen: entry.lastSeen ?? null,
      locationName: entry.locationName ?? null,
      memberCount: entry.memberCount,
      renderLatencyMs: entry.renderLatencyMs,
    };
    const raw = await AsyncStorage.getItem(KEY);
    const arr: ScreenRenderEntry[] = raw ? JSON.parse(raw) : [];
    arr.push(e);
    while (arr.length > MAX_ENTRIES) arr.shift();
    await AsyncStorage.setItem(KEY, JSON.stringify(arr));
  } catch (_e) {}
}

export async function readScreenRenderLog(): Promise<ScreenRenderEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (_e) {
    return [];
  }
}

export async function clearScreenRenderLog(): Promise<void> {
  try { await AsyncStorage.removeItem(KEY); } catch (_e) {}
}

// ============================================================
//  Optional on-screen debug overlay
// ============================================================
//
// Toggleable from the Diagnostics screen.  Default OFF — keeps the
// dashboard and member screens clean for non-debugging testers.
// When ON, both screens render a tiny floating panel at the bottom
// with the live values pulled from React state.
const OVERLAY_KEY = 'kc_debug_overlay_v1';

export async function isDebugOverlayEnabled(): Promise<boolean> {
  try {
    const v = await AsyncStorage.getItem(OVERLAY_KEY);
    return v === '1';
  } catch (_e) { return false; }
}

export async function setDebugOverlayEnabled(on: boolean): Promise<void> {
  try { await AsyncStorage.setItem(OVERLAY_KEY, on ? '1' : '0'); } catch (_e) {}
}
