/**
 * Foreground location refresh (v1.2.2 — P2 Location Freshness fix).
 *
 * THE BUG WE FIXED:
 *  Joyce's location on Charles's dashboard was 5+ miles stale despite
 *  her phone holding the correct GPS fix.  Investigation traced this
 *  to three converging issues:
 *
 *  1. Android's App Standby Bucket throttles the background-location
 *     foreground service for apps the user hasn't actively engaged
 *     with for a few days.  Our OS-owned task in `backgroundLocation.ts`
 *     stops firing, silently.
 *
 *  2. The dashboard mount effect (the *only* in-app upload path before
 *     this file existed) is gated on `[members.length, user?.id]` —
 *     neither changes on foreground transitions, so the effect never
 *     re-fires when the user opens the app days later.
 *
 *  3. The AppState 'active' listener added in v1.2.1 only refreshed
 *     the push token; there was no parallel location refresh.
 *
 *  Net effect: the only thing that broke Joyce out of stale state was
 *  pressing Check In, which side-effects a `members.location` write
 *  via the `POST /checkins` backend handler (server.py:2081-2083).
 *
 * THE FIX:
 *  On every app-foreground transition (while signed in) we silently
 *  upload a fresh GPS fix to the same `PUT /members/{id}/location`
 *  endpoint the background task uses.  Self-throttled to once per
 *  60 seconds so rapid bg/fg flips don't hammer GPS or the backend.
 *
 *  We also write a rolling diagnostic log so Charles can verify on
 *  Joyce's device that the refresh is firing — same pattern as
 *  push-token diagnostics.
 *
 * PRIVACY NOTE:
 *  Coordinates in the diagnostic log are rounded to 0.01° (~1.1 km
 *  precision) so the Copy Log payload never leaks a precise position.
 *  The actual `PUT` of course sends full precision — that's the whole
 *  point of the refresh.
 */
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { api } from './api';

const MY_MEMBER_ID_KEY = 'kc_my_member_id_v1';
const LOG_KEY = 'kc_location_refresh_log';

// Throttle the foreground refresh — 60 s is the floor.  Background
// task's normal cadence is 5 min; we deliberately want the foreground
// path to be MUCH more aggressive so a user actively opening the app
// always sees a fresh dot.
const MIN_INTERVAL_MS = 60 * 1000;

let lastRefreshAt = 0;

/**
 * Cache the current user's member_id so subsequent refreshes can fire
 * without re-fetching /members.  Call once from RootNav when user.id
 * resolves.  Pass null to clear (e.g. on logout).
 */
export async function setMyMemberId(memberId: string | null): Promise<void> {
  try {
    if (memberId) await AsyncStorage.setItem(MY_MEMBER_ID_KEY, memberId);
    else await AsyncStorage.removeItem(MY_MEMBER_ID_KEY);
  } catch (_e) {}
}

export async function getMyMemberId(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(MY_MEMBER_ID_KEY);
  } catch (_e) {
    return null;
  }
}

export type LocationRefreshEntry = {
  t: number;
  reason: string;
  ok: boolean;
  // Coarse rounding for privacy — see PRIVACY NOTE in file header.
  latApprox: number | null;
  lonApprox: number | null;
  err: string | null;
};

async function appendLog(entry: LocationRefreshEntry): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(LOG_KEY);
    const arr: LocationRefreshEntry[] = raw ? JSON.parse(raw) : [];
    arr.push(entry);
    while (arr.length > 50) arr.shift();
    await AsyncStorage.setItem(LOG_KEY, JSON.stringify(arr));
  } catch (_e) {}
}

export async function readLocationRefreshLog(): Promise<LocationRefreshEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(LOG_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (_e) {
    return [];
  }
}

export async function clearLocationRefreshLog(): Promise<void> {
  try { await AsyncStorage.removeItem(LOG_KEY); } catch (_e) {}
}

function roundCoord(x: number): number {
  return Math.round(x * 100) / 100;
}

/**
 * Silently refresh the device's location to the backend.  Safe to call
 * from any AppState/useEffect handler without throttling yourself —
 * the function self-throttles to once per 60 s.
 *
 * Never throws.  Errors are logged into the rolling diagnostic buffer
 * so they're visible via Settings → Diagnostics.
 */
export async function refreshLocationIfStale(reason: string): Promise<void> {
  try {
    if (Platform.OS === 'web') return;

    const now = Date.now();
    if (now - lastRefreshAt < MIN_INTERVAL_MS) return;

    const memberId = await getMyMemberId();
    if (!memberId) {
      // No cached member id — RootNav probably hasn't run its post-auth
      // /members fetch yet.  Skip silently; the dashboard mount effect
      // is the safety net on cold-start.
      return;
    }

    // Silent permission check — never prompt from a foreground
    // transition.  If the user revoked permission, we have no fresh
    // GPS to upload; the foreground service notification (when bg
    // permission is also granted) gives a separate route.
    let fgStatus: string;
    try {
      const fg = await Location.getForegroundPermissionsAsync();
      fgStatus = fg.status;
    } catch (_e) {
      fgStatus = 'unknown';
    }
    if (fgStatus !== 'granted') {
      lastRefreshAt = now;
      await appendLog({
        t: now,
        reason,
        ok: false,
        latApprox: null,
        lonApprox: null,
        err: `permission_${fgStatus}`,
      });
      return;
    }

    let lat: number;
    let lon: number;
    try {
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      lat = pos.coords.latitude;
      lon = pos.coords.longitude;
    } catch (e: any) {
      lastRefreshAt = now;
      await appendLog({
        t: now,
        reason,
        ok: false,
        latApprox: null,
        lonApprox: null,
        err: `gps_${(e?.message || 'unknown').slice(0, 60)}`,
      });
      return;
    }

    let ok = false;
    let err: string | null = null;
    try {
      await api.put(`/members/${memberId}/location`, {
        latitude: lat,
        longitude: lon,
      });
      ok = true;
    } catch (e: any) {
      const status = e?.response?.status;
      err = status ? `http_${status}` : `network_${(e?.message || 'unknown').slice(0, 40)}`;
    }
    lastRefreshAt = now;
    await appendLog({
      t: now,
      reason,
      ok,
      latApprox: roundCoord(lat),
      lonApprox: roundCoord(lon),
      err,
    });
  } catch (_e) {
    // Never let a refresh failure crash the foreground transition.
  }
}
