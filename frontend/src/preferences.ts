/**
 * Quiet Hours preferences API (v1.3.3).
 *
 * Thin wrapper around GET/PUT /api/me/preferences.  Keeps the Settings
 * card and any future "snooze for 1 hour" affordances using the same
 * canonical shape so we don't end up with three different definitions
 * of what `quiet_hours.start` means across the codebase.
 */
import { api } from './api';

export type QuietHoursPreference = {
  enabled: boolean;
  start: string; // 'HH:MM' 24h
  end: string;   // 'HH:MM' 24h
};

export type Preferences = {
  quiet_hours: QuietHoursPreference;
};

const DEFAULT_PREFS: Preferences = {
  quiet_hours: {
    enabled: false,
    start: '22:00',
    end: '07:00',
  },
};

export async function getPreferences(): Promise<Preferences> {
  try {
    const r = await api.get('/me/preferences');
    const qh = r?.data?.quiet_hours || {};
    return {
      quiet_hours: {
        enabled: !!qh.enabled,
        start: typeof qh.start === 'string' ? qh.start : DEFAULT_PREFS.quiet_hours.start,
        end: typeof qh.end === 'string' ? qh.end : DEFAULT_PREFS.quiet_hours.end,
      },
    };
  } catch (_e) {
    return DEFAULT_PREFS;
  }
}

export async function updatePreferences(patch: Partial<Preferences>): Promise<Preferences> {
  const r = await api.put('/me/preferences', patch);
  const qh = r?.data?.quiet_hours || {};
  return {
    quiet_hours: {
      enabled: !!qh.enabled,
      start: qh.start || DEFAULT_PREFS.quiet_hours.start,
      end: qh.end || DEFAULT_PREFS.quiet_hours.end,
    },
  };
}

/**
 * Compute whether the user is currently inside their Quiet Hours
 * window (local-device clock).  Used by the frontend ONLY for the
 * "Currently active" status indicator in Settings — the backend has
 * the authoritative gate and is the source of truth for actual push
 * suppression.
 */
export function isCurrentlyInWindow(qh: QuietHoursPreference, now: Date = new Date()): boolean {
  if (!qh.enabled) return false;
  const parse = (s: string): number | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s);
    if (!m) return null;
    const h = parseInt(m[1], 10);
    const mn = parseInt(m[2], 10);
    if (h < 0 || h > 23 || mn < 0 || mn > 59) return null;
    return h * 60 + mn;
  };
  const a = parse(qh.start);
  const b = parse(qh.end);
  if (a === null || b === null || a === b) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  if (a < b) return cur >= a && cur < b;
  // Wrap-around (e.g. 22:00 → 07:00).
  return cur >= a || cur < b;
}

/** Pretty-print a HH:MM string as h:mm AM/PM. */
export function formatHHMM12(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  let h = parseInt(m[1], 10);
  const mn = m[2];
  const ampm = h >= 12 ? 'PM' : 'AM';
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return `${h}:${mn} ${ampm}`;
}
