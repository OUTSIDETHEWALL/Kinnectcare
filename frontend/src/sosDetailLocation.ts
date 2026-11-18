import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { api, type Alert, type Member } from './api';

// These fields are already returned by the family-scoped APIs.
export type FamilyAlert = Alert & { family_group_id: string; owner_id: string };
type FamilyProfile = Member & { family_group_id: string; gps_accuracy?: number | null };

const WAIT_MS = 30_000;
const REQUEST_MS = 5_000;
const SEARCH_POLL_MS = 4_000;
const ACTIVE_RECHECK_MS = 15_000;

export function hasSosCoordinates(lat: unknown, lon: unknown): boolean {
  return typeof lat === 'number' && Number.isFinite(lat) && Math.abs(lat) <= 90
    && typeof lon === 'number' && Number.isFinite(lon) && Math.abs(lon) <= 180;
}

function profileFor(alert: FamilyAlert, profiles: FamilyProfile[]): FamilyProfile | undefined {
  if (!alert.owner_id || !alert.member_id) return undefined;
  const selfSos = alert.member_id === alert.owner_id;
  const matches = profiles.filter(p => p.family_group_id === alert.family_group_id
    && (selfSos ? p.user_id === alert.owner_id : p.id === alert.member_id));
  return matches.length === 1 && matches[0].id ? matches[0] : undefined;
}

type SharedFix = {
  latitude: number;
  longitude: number;
  capturedAt: string | null;
  accuracy: number | null;
  address: string | null;
};

function fixFrom(profile: FamilyProfile): SharedFix | null {
  if (!hasSosCoordinates(profile.latitude, profile.longitude)) return null;
  const capturedAt = profile.coordinate_captured_at;
  return {
    latitude: profile.latitude!,
    longitude: profile.longitude!,
    capturedAt: capturedAt && Number.isFinite(Date.parse(capturedAt)) && Date.parse(capturedAt) <= Date.now()
      ? capturedAt : null,
    accuracy: typeof profile.gps_accuracy === 'number' && Number.isFinite(profile.gps_accuracy)
      && profile.gps_accuracy > 0 ? profile.gps_accuracy : null,
    address: profile.location_name || null,
  };
}

export function isFreshSosFix(fix: SharedFix, alert: FamilyAlert): boolean {
  if (!fix.capturedAt) return false;
  const captured = Date.parse(fix.capturedAt);
  return captured >= Date.parse(alert.created_at) && Date.now() - captured <= WAIT_MS;
}

type State = { fix: SharedFix | null; phone: string | null; waiting: boolean };
const EMPTY: State = { fix: null, phone: null, waiting: false };

// Scoped to this open, foreground incident. Do not populate/use the shared
// member cache: it can hold coordinates from a previous sharing lifetime.
export function useSosDetailLocation(
  incident: FamilyAlert | null,
  onIncidentEnded: (alert: FamilyAlert | null) => void,
) {
  const focused = useIsFocused();
  const [state, setState] = useState(EMPTY);

  useEffect(() => {
    if (!focused || !incident || incident.resolved) {
      setState(EMPTY);
      return;
    }
    const alert = incident;
    let stopRun: (() => void) | undefined;
    let refreshRequested = false;
    let firstRun = true;
    let latestPoint: { id: string; generation: number; fix: SharedFix; watermark: number } | undefined;
    let authority: { id: string; user: string | null; generation: number } | undefined;
    let denied: { id: string; generation: number } | undefined;

    const begin = () => {
      stopRun?.();
      const controller = new AbortController();
      const options = { signal: controller.signal, timeout: REQUEST_MS };
      const current = () => !controller.signal.aborted;
      let poll: ReturnType<typeof setTimeout> | undefined;
      let lease: ReturnType<typeof setTimeout> | undefined;
      let best: SharedFix | null = null;
      const deadline = Date.now() + WAIT_MS;
      stopRun = () => {
        controller.abort();
        clearTimeout(poll);
        clearTimeout(lease);
        clearTimeout(wait);
      };
      setState({ ...EMPTY, waiting: !refreshRequested });
      const wait = setTimeout(() => {
        if (current()) setState(s => ({ ...s, waiting: false }));
      }, WAIT_MS);

      const read = async (initial: boolean) => {
        let checkingAlert = !initial;
        try {
          // The first read follows the scoped alert load. Subsequent reads
          // also check remote resolution/visibility before accepting a point.
          if (!initial) {
            const { data } = await api.get<FamilyAlert[]>('/alerts', options);
            if (!current()) return;
            const latest = data.find(a => a.id === alert.id && a.type === 'sos'
              && a.family_group_id === alert.family_group_id
              && a.owner_id === alert.owner_id && a.member_id === alert.member_id);
            if (!latest || latest.resolved) {
              stopRun?.();
              setState(EMPTY);
              onIncidentEnded(latest ?? null);
              return;
            }
            checkingAlert = false;
          }
          const result = await api.get<FamilyProfile[]>('/members', options);
          if (!current()) return;

          const profile = profileFor(alert, result.data);
          const generation = profile?.location_consent_generation;
          if (!profile || profile.location_sharing_enabled !== true
            || typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0
            || (authority?.id === profile.id && generation < authority.generation)
            || (denied?.id === profile.id && generation <= denied.generation)) {
            if (authority?.id === profile?.id && profile?.location_sharing_enabled === false
              && typeof generation === 'number') denied = { id: profile.id, generation };
            best = null;
            clearTimeout(lease);
            setState({ ...EMPTY, phone: profile?.emergency_contact_phone ?? null });
          } else {
            const user = profile.user_id ?? null;
            if (authority && (authority.id !== profile.id || authority.user !== user
              || authority.generation !== generation)) best = null;
            authority = { id: profile.id, user, generation };
            const candidate = fixFrom(profile);
            const timestamp = candidate?.capturedAt ? Date.parse(candidate.capturedAt) : null;
            if (!candidate) best = null;
            else if (!latestPoint || (timestamp !== null && timestamp > latestPoint.watermark)) {
              best = candidate;
              latestPoint = { id: profile.id, generation, fix: candidate, watermark: timestamp ?? Date.now() };
            } else if (latestPoint.id === profile.id && latestPoint.generation === generation
              && candidate.capturedAt === latestPoint.fix.capturedAt
              && candidate.latitude === latestPoint.fix.latitude
              && candidate.longitude === latestPoint.fix.longitude) {
              // Restore only the identical fix after a fresh authorized read.
              best = candidate;
            }
            const eligible = !!user && Date.now() < deadline;
            setState(s => ({
              fix: best, phone: profile.emergency_contact_phone ?? null,
              waiting: !best && s.waiting && eligible,
            }));
            // A previously authorized map is not kept indefinitely if an
            // authority check hangs. In-flight responses remain scope-bound.
            clearTimeout(lease);
            lease = setTimeout(() => {
              if (current()) setState(s => ({ ...s, fix: null }));
            }, ACTIVE_RECHECK_MS + REQUEST_MS * 2);
            if (eligible && !refreshRequested) {
              refreshRequested = true;
              try {
                const { data } = await api.post(`/members/${encodeURIComponent(profile.id)}/request-location-refresh`, undefined, options);
                if (current() && ((data?.skipped && data.skipped !== 'throttled') || data?.sent_to === 0)) {
                  if (data.skipped === 'target_sharing_off') {
                    denied = { id: profile.id, generation };
                    best = null;
                  }
                  setState(s => ({ ...s, fix: best, waiting: false }));
                }
              } catch (error: any) {
                if (current()) {
                  if ([401, 403, 404].includes(error?.response?.status)) best = null;
                  setState(s => ({ ...s, fix: best, waiting: false }));
                }
              }
            }
          }
        } catch (error: any) {
          if (current()) {
            setState(EMPTY);
            if (checkingAlert && [401, 403].includes(error?.response?.status)) {
              stopRun?.();
              onIncidentEnded(null);
            }
          }
        } finally {
          if (current()) {
            // One fresh request per screen visit. Keep only a low-frequency
            // authority/resolution check after the bounded fresh-fix window.
            const delay = Date.now() < deadline ? SEARCH_POLL_MS : ACTIVE_RECHECK_MS;
            poll = setTimeout(() => { void read(false); }, delay);
          }
        }
      };
      const justLoaded = firstRun;
      firstRun = false;
      void read(justLoaded);
    };

    let foreground = !AppState.currentState || AppState.currentState === 'active';
    if (foreground) begin();
    const sub = AppState.addEventListener('change', next => {
      const active = next === 'active';
      if (foreground === active) return;
      foreground = active;
      if (foreground) begin();
      else {
        stopRun?.();
        stopRun = undefined;
        setState(EMPTY);
      }
    });
    return () => { stopRun?.(); sub.remove(); };
  }, [focused, incident, onIncidentEnded]);

  return focused && incident && !incident.resolved ? state : EMPTY;
}
