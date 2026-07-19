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
import * as memberStore from './store/memberStore';

const MY_MEMBER_ID_KEY = 'kc_my_member_id_v1';
// v1.2.5 diagnostic: stash the user_id alongside the member_id so
// the bg-task and foreground diagnostic logs can both surface it
// without having to round-trip /auth/me from inside the OS-task
// context.
const MY_USER_ID_KEY = 'kc_my_user_id_v1';
// v1.2.5 diagnostic: the background-location task writes to a
// SEPARATE AsyncStorage key for historical reasons.  Exposed here
// so locationRefresh can snapshot it on every foreground upload —
// if the two keys hold different member_ids, that's the smoking
// gun for the "background uploads silently going to wrong member"
// hypothesis.
const BG_LOCATION_MEMBER_ID_KEY_MIRROR = '@kinnship/bg_location_member_id_v1';
const LOG_KEY = 'kc_location_refresh_log';

// v1.2.9 — fresh GPS, faster cadence
//
// Pre-v1.2.9 this path was `Location.Accuracy.Balanced` (network +
// coarse GPS, may return cached fix up to a few minutes old) and
// throttled to once per 60 s.  SOS in the same app uses
// `Accuracy.Highest` and is consistently described as "always
// accurate" — that's the difference we're closing.  Passive tracking
// now uses the same fresh-GPS path as SOS.  Throttle drops to 30 s
// so a moving user gets twice as many refreshes per minute.
const MIN_INTERVAL_MS = 30 * 1000;
const FOREGROUND_ACCURACY = Location.Accuracy.Highest;

// Throttle the foreground refresh — 60 s is the floor.  Background
// task's normal cadence is 5 min; we deliberately want the foreground
// path to be MUCH more aggressive so a user actively opening the app
// always sees a fresh dot.
// (v1.2.9: the constants are now declared above with the SOS-matching
// values — this duplicate line is removed.)

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

/**
 * Cache the current user's user_id alongside the member_id (v1.2.5).
 * Lets the OS-detached background task log it without round-tripping
 * /auth/me, and lets foreground diagnostic entries cross-reference
 * the writer identity.  Pass null on logout.
 */
export async function setMyUserId(userId: string | null): Promise<void> {
  try {
    if (userId) await AsyncStorage.setItem(MY_USER_ID_KEY, userId);
    else await AsyncStorage.removeItem(MY_USER_ID_KEY);
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
  // v1.2.5 fields — surface the writer identity and any divergence
  // between foreground / background member-id caches.
  userId?: string | null;
  memberId?: string | null;       // member_id the foreground PUT actually targeted
  bgMemberId?: string | null;     // snapshot of the background key for divergence detection
  divergent?: boolean;            // true iff bgMemberId is set AND != memberId
  // v1.2.6 fields — capture the PUT response body's coords so we can
  // verify the backend's post-write view matches what we just sent.
  // If `writeMismatch: true` ever shows up, the backend rewrote our
  // input OR the find_one after update_one returned a different doc
  // (e.g. duplicate member row collision).
  respLat?: number | null;
  respLon?: number | null;
  writeMismatch?: boolean;
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

// ============================================================
//  v1.2.7 — Reverse-geocode + location_name maintenance
// ============================================================
//
// THE BUG THIS REPAIRS:
//   The backend's PUT /members/{id}/location only updates the
//   `location_name` field if the request body contains it.  Our
//   auto refresh paths (foreground refresh, dashboard mount, bg
//   task) historically only sent latitude/longitude — never the
//   label.  Even the Check-In flow sent a hardcoded
//   'Current Location' literal rather than a real place name.
//   Result: `location_name` was frozen at whatever the original
//   value happened to be ("Home" default from member creation,
//   or "Current Location" from a past check-in).  The dashboard
//   renders `📍 {member.location_name}` as a text label, so even
//   though the BACKEND had Joyce's correct Walmart coordinates,
//   Charles's dashboard read "📍 Home" — looking 5 miles stale.
//
// THE FIX:
//   Reverse-geocode the GPS fix and include a short human label
//   in every foreground PUT.  Cached aggressively — we only call
//   Expo's reverseGeocodeAsync when the device has moved >50 m
//   since the last successful geocode, so a phone sitting on a
//   charger costs zero geocode calls regardless of how often the
//   foreground refresh fires.
//
//   The background task does NOT reverse-geocode — Expo's geocode
//   API requires the platform's geocoder service which has subtle
//   reliability quirks from a detached OS-task JS context.  The
//   label will refresh on the next foreground transition, which
//   is the common path on Joyce's device anyway (v1.2.2's AppState
//   wiring fires the foreground refresh on every app activation).
//
// LABEL FORMAT:
//   Picked to be (a) short enough for one-line MemberCard rendering,
//   (b) recognizable to elderly users, (c) free of literal address
//   numbers (privacy / clutter).  Examples:
//     "Phoenix, AZ"
//     "Sky Harbor Airport, Phoenix"
//     "Walmart Supercenter, Phoenix"     (when the geocoder returns a POI name)
//   Falls back to lat,lon string if the geocoder fails.
const GEOCODE_MIN_MOVE_M = 50;
let lastGeocodedLat: number | null = null;
let lastGeocodedLon: number | null = null;
let lastGeocodedName: string | null = null;

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  // Equirectangular approximation is plenty accurate at the 50 m scale
  // and avoids trig — cheap enough to call on every refresh tick.
  const dLat = (lat2 - lat1) * 111_320;
  const dLon = (lon2 - lon1) * 111_320 * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  return Math.sqrt(dLat * dLat + dLon * dLon);
}

// US state (and common Canadian province) names → 2-letter abbreviations.
// Applied when isoCountryCode === 'US' or 'CA' so labels read
// "Bullhead City, AZ" rather than "Bullhead City, Arizona".
const REGION_ABBREV: Record<string, string> = {
  // US states
  'Alabama': 'AL', 'Alaska': 'AK', 'Arizona': 'AZ', 'Arkansas': 'AR',
  'California': 'CA', 'Colorado': 'CO', 'Connecticut': 'CT', 'Delaware': 'DE',
  'Florida': 'FL', 'Georgia': 'GA', 'Hawaii': 'HI', 'Idaho': 'ID',
  'Illinois': 'IL', 'Indiana': 'IN', 'Iowa': 'IA', 'Kansas': 'KS',
  'Kentucky': 'KY', 'Louisiana': 'LA', 'Maine': 'ME', 'Maryland': 'MD',
  'Massachusetts': 'MA', 'Michigan': 'MI', 'Minnesota': 'MN', 'Mississippi': 'MS',
  'Missouri': 'MO', 'Montana': 'MT', 'Nebraska': 'NE', 'Nevada': 'NV',
  'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY',
  'North Carolina': 'NC', 'North Dakota': 'ND', 'Ohio': 'OH', 'Oklahoma': 'OK',
  'Oregon': 'OR', 'Pennsylvania': 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC',
  'South Dakota': 'SD', 'Tennessee': 'TN', 'Texas': 'TX', 'Utah': 'UT',
  'Vermont': 'VT', 'Virginia': 'VA', 'Washington': 'WA', 'West Virginia': 'WV',
  'Wisconsin': 'WI', 'Wyoming': 'WY', 'District of Columbia': 'DC',
  // Canadian provinces
  'Alberta': 'AB', 'British Columbia': 'BC', 'Manitoba': 'MB',
  'New Brunswick': 'NB', 'Newfoundland and Labrador': 'NL', 'Nova Scotia': 'NS',
  'Ontario': 'ON', 'Prince Edward Island': 'PE', 'Quebec': 'QC',
  'Saskatchewan': 'SK',
};

/**
 * Pick the most useful geocoder result from the array the platform returns.
 *
 * Both Apple MapKit (iOS) and Google Geocoder (Android) may return several
 * results at different granularities.  We prefer the result that has a
 * populated `city` field — that's the clearest signal that an incorporated
 * municipality was found.  A result with only a `district` is better than
 * one with nothing.
 */
function pickBestGeoResult(results: any[]): any {
  if (!results || results.length === 0) return null;
  let best = results[0];
  let bestScore = -Infinity;
  for (const r of results) {
    let score = 0;
    if (r?.city)     score += 10;
    if (r?.district) score += 4;
    if (r?.region)   score += 1;
    if (score > bestScore) { bestScore = score; best = r; }
  }
  return best;
}

function formatGeocodeLabel(addr: any): string {
  const rawName   = (addr?.name       || '').trim();
  const city      = (addr?.city       || '').trim();
  const district  = (addr?.district   || '').trim(); // sublocality / neighborhood
  const subregion = (addr?.subregion  || '').trim(); // county
  const region    = (addr?.region     || '').trim(); // state — full name on iOS
  const isoCode   = (addr?.isoCountryCode || '').trim();

  // Abbreviate state for US/CA so labels read "Bullhead City, AZ" not "Bullhead City, Arizona".
  const regionShort = REGION_ABBREV[region] ?? region;

  // Primary locale: incorporated city is ground truth.
  // Fall through to district (sublocality / unincorporated community) only
  // when the geocoder found no city — common for rural/unincorporated areas.
  const primaryLocale = city || district;

  // `name` in geocoder results is a fine-grained local label: it can be a
  // neighborhood name, a community name (e.g. "Fort Mohave"), or a POI.
  // We only use it as a POI prefix — never as the primary locale — because
  // it is unreliable as a city identifier and frequently points to a
  // sub-locality (like "Fort Mohave") when the actual city ("Bullhead City")
  // is already available in the `city` field.
  //
  // A name qualifies as a POI prefix when ALL four conditions hold:
  //   1. Non-empty
  //   2. Doesn't start with a digit (avoids "123 Main St" street addresses)
  //   3. Doesn't duplicate the city, district, county, or state — geocoders
  //      sometimes echo the city into `name`, which would produce
  //      "Bullhead City, Bullhead City"
  //   4. A real primary locale exists — a POI name without a known city is
  //      ambiguous and not useful as a standalone label
  const looksLikeStreetAddr = rawName.length > 0 && /^\d/.test(rawName);
  const isDuplicate = rawName === city || rawName === district
                   || rawName === subregion || rawName === region;
  const isPoi = rawName && !looksLikeStreetAddr && !isDuplicate && !!primaryLocale;

  if (isPoi)                                return `${rawName}, ${primaryLocale}`;
  if (primaryLocale && regionShort)         return `${primaryLocale}, ${regionShort}`;
  if (primaryLocale)                        return primaryLocale;
  // Remote / unincorporated with no city or district: surface the county so
  // the label is at least regionally meaningful rather than misleading.
  if (subregion && regionShort)             return `${subregion} area, ${regionShort}`;
  if (regionShort)                          return regionShort;
  return '';
}

/**
 * Geocode using Google's Geocoding REST API.
 *
 * Field-test finding (July 2026): iOS (Apple MapKit) and Android (Google Geocoder)
 * return different city names for the same coordinates — "Fort Mohave, AZ" on iOS
 * vs "Bullhead City, AZ" on Android — because the two geocoding backends have
 * different city-boundary datasets.  Using Google's REST API directly gives
 * identical results on both platforms.
 *
 * The key (`EXPO_PUBLIC_GOOGLE_MAPS_API_KEY`) is already embedded in the app for
 * map rendering; using it here adds zero new dependency.
 *
 * Returns empty string on any failure so callers fall through to the platform
 * geocoder.
 */
async function geocodeWithGoogle(lat: number, lon: number): Promise<string> {
  const key = process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY;
  if (!key) return '';
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lon}&key=${key}`;
    const res = await fetch(url);
    if (!res.ok) return '';
    const json = await res.json() as any;
    if (json.status !== 'OK' || !json.results?.length) return '';

    // Walk the first (most specific) result's address_components.
    const components: { types: string[]; long_name: string; short_name: string }[] =
      json.results[0].address_components || [];

    let locality   = '';   // city
    let stateShort = '';   // e.g. "AZ"
    let premise    = '';   // named place / establishment
    let route      = '';   // street (to detect street-address results)

    for (const c of components) {
      if (c.types.includes('locality'))                        locality   = c.long_name;
      if (c.types.includes('administrative_area_level_1'))     stateShort = c.short_name;
      if (c.types.includes('premise') ||
          c.types.includes('establishment') ||
          c.types.includes('point_of_interest'))               premise    = c.long_name;
      if (c.types.includes('route'))                           route      = c.long_name;
    }

    // Skip results that are just a street address (we want a city/place label).
    if (route && !locality) return '';

    if (premise && locality && premise !== locality) return `${premise}, ${locality}`;
    if (locality && stateShort) return `${locality}, ${stateShort}`;
    if (locality) return locality;
    return '';
  } catch (_e) {
    return '';
  }
}

/**
 * Reverse-geocode at most once per 50 m of movement.  Returns the
 * cached name when the device hasn't moved.  Never throws —
 * empty string on failure so callers can ?? past it.
 *
 * Strategy (field-test build):
 *   1. Try Google Geocoding REST API — consistent results on iOS + Android.
 *   2. Fall back to Expo's platform geocoder (Apple MapKit / Google native)
 *      if the REST call fails or returns nothing.
 */
export async function geocodeLabelForCoord(lat: number, lon: number): Promise<string> {
  try {
    if (
      lastGeocodedLat !== null &&
      lastGeocodedLon !== null &&
      lastGeocodedName !== null &&
      haversineM(lastGeocodedLat, lastGeocodedLon, lat, lon) < GEOCODE_MIN_MOVE_M
    ) {
      return lastGeocodedName;
    }

    // 1. Google REST geocoder — platform-consistent.
    let label = await geocodeWithGoogle(lat, lon);

    // 2. Platform fallback (Apple MapKit on iOS, Google native on Android).
    if (!label) {
      const results = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lon });
      label = results?.length > 0 ? formatGeocodeLabel(pickBestGeoResult(results)) : '';
    }

    if (label) {
      lastGeocodedLat = lat;
      lastGeocodedLon = lon;
      lastGeocodedName = label;
      return label;
    }
    return '';
  } catch (_e) {
    return '';
  }
}

/**
 * Format a `last_seen` ISO timestamp as a compact human-readable age.
 *
 * Returns an empty string for null/undefined/invalid timestamps so callers
 * can skip rendering rather than showing a broken label.
 *
 * Examples:
 *   "just now"     (< 10 s)
 *   "45s ago"      (< 1 min)
 *   "3 min ago"    (< 1 h)
 *   "2h ago"       (< 24 h)
 *   "3d ago"       (≥ 24 h)
 */
export function formatLastSeenAge(isoString: string | null | undefined): string {
  if (!isoString) return '';
  try {
    const ms = Date.now() - new Date(isoString).getTime();
    if (!Number.isFinite(ms) || ms < 0) return '';
    const s = Math.round(ms / 1000);
    if (s < 10)   return 'just now';
    if (s < 60)   return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60)   return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24)   return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
  } catch (_e) {
    return '';
  }
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

    // Build #55 — respect the Location Sharing (privacy) opt-out from
    // the Me tab.  If the user has flipped it off, don't upload a
    // foreground fix either.  Silent no-op — no diagnostic log spam.
    try {
      const off = await AsyncStorage.getItem('@kinnship/location_sharing_off_v1');
      if (off === '1') return;
    } catch (_e) {}

    const now = Date.now();
    // v1.3.0 — silent-push pull bypasses the throttle once, because
    // a family member explicitly requested it.  Flag is set in
    // push.ts before the call.
    const forced = !!(global as any).__kc_force_loc_refresh;
    if (forced) (global as any).__kc_force_loc_refresh = false;
    if (!forced && now - lastRefreshAt < MIN_INTERVAL_MS) return;

    // Snapshot BOTH member-id caches at the start of this refresh so
    // we can compare them in the log entry — divergence between the
    // foreground key (MY_MEMBER_ID_KEY) and the background key
    // (BG_LOCATION_MEMBER_ID_KEY_MIRROR) is the smoking gun for the
    // "background uploads going to wrong member row" hypothesis.
    const [memberId, userId, bgMemberId] = await Promise.all([
      AsyncStorage.getItem(MY_MEMBER_ID_KEY),
      AsyncStorage.getItem(MY_USER_ID_KEY),
      AsyncStorage.getItem(BG_LOCATION_MEMBER_ID_KEY_MIRROR),
    ]);
    const divergent = !!bgMemberId && bgMemberId !== memberId;

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
        userId,
        memberId,
        bgMemberId,
        divergent,
      });
      return;
    }

    let lat: number;
    let lon: number;
    try {
      const pos = await Location.getCurrentPositionAsync({
        accuracy: FOREGROUND_ACCURACY,
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
        userId,
        memberId,
        bgMemberId,
        divergent,
      });
      return;
    }

    let ok = false;
    let err: string | null = null;
    let respLat: number | null = null;
    let respLon: number | null = null;
    let writeMismatch = false;
    // v1.2.7 — reverse-geocode the fix so the PUT carries an honest
    // `location_name` for the dashboard label.  Best-effort: if the
    // geocoder fails or returns nothing useful we still PUT the
    // coords; the backend retains the previous label rather than
    // overwriting with junk.
    const locationName = await geocodeLabelForCoord(lat, lon);
    try {
      const body: any = { latitude: lat, longitude: lon };
      if (locationName) body.location_name = locationName;
      const resp = await api.put(`/members/${memberId}/location`, body);
      // v1.2.6: capture the backend's post-write view of the row so we
      // can detect partial / wrong-doc writes.  PUT response body is
      // the FamilyMember model — see server.py:1670.
      const rd: any = resp?.data || {};
      if (typeof rd.latitude === 'number') respLat = rd.latitude;
      if (typeof rd.longitude === 'number') respLon = rd.longitude;
      // Compare with ~5 m tolerance (5e-5 deg ~= 5.5 m at the
      // equator).  Float-round artifacts from JSON serialization are
      // well below this.
      if (respLat !== null && respLon !== null) {
        writeMismatch =
          Math.abs(respLat - lat) > 5e-5 || Math.abs(respLon - lon) > 5e-5;
      }
      // ============================================================
      //  Build 48 — close the data-integrity gap.
      //  The PUT response body is the canonical post-write Member
      //  doc with the fresh server-stamped `last_seen`.  Upsert it
      //  directly into the canonical store so Joyce's own phone
      //  re-renders her Member screen (and Leonidas re-evaluates
      //  her last upload age) with the EXACT same timestamp the
      //  backend just persisted — no waiting for the next /members
      //  poll.  Without this upsert, the senior's local store
      //  could drift many minutes behind the backend while her
      //  Transistor engine was uploading successfully.
      // ============================================================
      if (rd && rd.id) {
        try { memberStore.upsertOne(rd); } catch (_e) {}
      }
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
      userId,
      memberId,
      bgMemberId,
      divergent,
      respLat: respLat !== null ? roundCoord(respLat) : null,
      respLon: respLon !== null ? roundCoord(respLon) : null,
      writeMismatch,
    });
  } catch (_e) {
    // Never let a refresh failure crash the foreground transition.
  }
}
