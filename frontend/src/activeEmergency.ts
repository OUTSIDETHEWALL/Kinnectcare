/**
 * Build #50 hotfix — Active-Emergency store.
 *
 * Central observable holding the currently-detected unresolved SOS for
 * the signed-in family group.  Populated by the auto-resume detector
 * in `_layout.tsx` and consumed by:
 *   • Dashboard         — renders a "You have an unresolved emergency"
 *                         banner when the alert is stale (>5 min old)
 *                         so the user can tap into it manually instead
 *                         of being auto-yanked.
 *   • Alert screen      — clears this on successful resolve / 404 so
 *                         the banner disappears everywhere at once.
 *
 * Deliberately in-memory only — never persisted.  The auto-resume
 * detector re-populates it on every AppState→active transition, and
 * a session restart implies a fresh backend check anyway.  This
 * avoids the exact class of bug we're fixing (trusting cached
 * emergency state without validating with the backend).
 */

export type ActiveEmergency = {
  id: string;
  member_id: string;
  member_name: string;
  created_at: string;      // ISO8601
  latitude?: number | null;
  longitude?: number | null;
  ageMs: number;           // ms since created_at at detection time
};

type Listener = (v: ActiveEmergency | null) => void;

let _current: ActiveEmergency | null = null;
const _listeners = new Set<Listener>();

export function setActiveEmergency(v: ActiveEmergency | null): void {
  _current = v;
  _listeners.forEach((l) => {
    try { l(v); } catch (_e) {}
  });
}

export function getActiveEmergency(): ActiveEmergency | null {
  return _current;
}

export function subscribeActiveEmergency(listener: Listener): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

/**
 * Convenience React hook — subscribes to changes and returns the
 * current value.  Import lazily so we don't drag `react` into
 * pure-JS modules that only need the setter.
 */
export function useActiveEmergency(): ActiveEmergency | null {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const { useEffect, useState } = require('react') as typeof import('react');
  const [v, setV] = useState<ActiveEmergency | null>(_current);
  useEffect(() => subscribeActiveEmergency(setV), []);
  return v;
}
