/**
 * Kinnship time-format utilities.
 *
 * The backend stores times in two canonical shapes:
 *   - 24-hour HH:MM strings for reminder slots and the daily check-in time
 *     (e.g. "08:00", "21:30").
 *   - ISO-8601 datetime strings (UTC) for alert/checkin/created_at timestamps.
 *
 * Every UI surface should DISPLAY these in 12-hour AM/PM format in the user's
 * local device timezone — never the backend's UTC representation directly.
 */

const TWELVE_HOUR_OPTS: Intl.DateTimeFormatOptions = {
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
};

/** Detect the device's IANA timezone (e.g. "America/Los_Angeles"). */
export function getDeviceTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && tz !== 'Etc/Unknown') return tz;
  } catch (_e) {
    // fall through
  }
  return 'UTC';
}

/** Parse a "HH:MM" string into {hour24, minute}. Returns null if invalid. */
export function parseHHMM(s?: string | null): { hour24: number; minute: number } | null {
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const hour24 = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isFinite(hour24) || !Number.isFinite(minute)) return null;
  if (hour24 < 0 || hour24 > 23 || minute < 0 || minute > 59) return null;
  return { hour24, minute };
}

/** Convert a 24h hour to 12h {hour12, ampm}. */
export function to12Hour(hour24: number): { hour12: number; ampm: 'AM' | 'PM' } {
  const ampm: 'AM' | 'PM' = hour24 >= 12 ? 'PM' : 'AM';
  let hour12 = hour24 % 12;
  if (hour12 === 0) hour12 = 12;
  return { hour12, ampm };
}

/** Convert {hour12, minute, ampm} into a canonical "HH:MM" 24-hour string. */
export function to24Hour(hour12: number, minute: number, ampm: 'AM' | 'PM'): string {
  let h24 = hour12 % 12; // 12 -> 0
  if (ampm === 'PM') h24 += 12;
  const hh = h24 < 10 ? `0${h24}` : `${h24}`;
  const mm = minute < 10 ? `0${minute}` : `${minute}`;
  return `${hh}:${mm}`;
}

/**
 * Format a "HH:MM" 24-hour string as 12-hour AM/PM (e.g. "8:00 AM").
 * Falls back to the input if parsing fails.
 */
export function formatTime12(hhmm?: string | null): string {
  const parsed = parseHHMM(hhmm);
  if (!parsed) return hhmm || '';
  const { hour12, ampm } = to12Hour(parsed.hour24);
  const mm = parsed.minute < 10 ? `0${parsed.minute}` : `${parsed.minute}`;
  return `${hour12}:${mm} ${ampm}`;
}

/**
 * Format an ISO-8601 datetime as a friendly "MMM D, h:mm AM/PM" string in the
 * device's local timezone. Used for alert timestamps, check-in timestamps,
 * compliance chart labels, etc.
 */
export function formatDateTimeLocal(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const datePart = d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  const timePart = d.toLocaleTimeString(undefined, TWELVE_HOUR_OPTS);
  return `${datePart}, ${timePart}`;
}

/**
 * Format an ISO-8601 datetime as a relative "Today/Yesterday/MMM D" + time.
 * Useful for last-seen and last-checkin contextual strings.
 */
export function formatRelativeLocal(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();

  const timePart = d.toLocaleTimeString(undefined, TWELVE_HOUR_OPTS);
  if (sameDay) return `Today, ${timePart}`;
  if (isYesterday) return `Yesterday, ${timePart}`;
  return formatDateTimeLocal(iso);
}

/**
 * Format a timestamp (ISO string OR epoch ms) as a compact "time ago" label.
 * Tuned for the dashboard location freshness indicator — we want the most
 * frequent values ("just now", "30 s ago", "2 min ago") to read at a glance
 * without needing the user to do math.
 *
 *   <10s     → "just now"
 *   10-59s   → "Xs ago"
 *   60-3599s → "X min ago"
 *   1-23h    → "Xh ago"
 *   >=24h    → "Xd ago"
 *
 * Returns '' for invalid / null input so callers can ?? past it.
 */
export function formatTimeAgo(input?: string | number | null): string {
  if (input === null || input === undefined) return '';
  let ms: number;
  if (typeof input === 'number') {
    ms = input;
  } else {
    const d = new Date(input);
    if (isNaN(d.getTime())) return '';
    ms = d.getTime();
  }
  const deltaSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (deltaSec < 10) return 'just now';
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const min = Math.floor(deltaSec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

/** Format a YYYY-MM-DD date string (in local tz) as a short day label like "Sat 5/17". */
export function formatShortDate(ymd?: string | null): string {
  if (!ymd) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  // Build the Date locally (avoid UTC interpretation).
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (isNaN(d.getTime())) return ymd;
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'numeric', day: 'numeric' });
}

/**
 * Format a check-in setting (fixed time OR interval) for display.
 *   {daily_checkin_time:"08:00"}              -> "🕐 8:00 AM (daily)"
 *   {checkin_interval_hours:4}                -> "🔁 Every 4 hours"
 *   neither set                               -> "— Not set"
 */
export function formatCheckinSetting(
  daily_checkin_time?: string | null,
  checkin_interval_hours?: number | null,
): string {
  if (checkin_interval_hours && checkin_interval_hours > 0) {
    return `🔁 Every ${checkin_interval_hours} hours`;
  }
  if (daily_checkin_time) {
    return `🕐 ${formatTime12(daily_checkin_time)} (daily)`;
  }
  return '— Not set';
}
