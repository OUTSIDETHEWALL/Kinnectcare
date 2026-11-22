import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api, type Alert } from './api';
import {
  alertScope, alertStorage, decodeDismissals, persistSosDismissals,
  sosResolution, visibleAlerts, type AlertScope, type SosDismissals,
} from './alertDismissals';

type Session = {
  scope: AlertScope; controller: AbortController; rows: Alert[]; marks: SosDismissals;
  ready?: Promise<void>; request: number; applied: number; clearing: boolean;
  deleted: Set<string>; loading: boolean; error: boolean;
};

/** Raw incident cache and local notification dismissals are deliberately separate. */
export function useAlertInbox(user?: { id?: string | null; family_group_id?: string | null } | null) {
  const scope = alertScope(user);
  const key = scope?.key;
  const session = useRef<Session | null>(null);
  const [view, setView] = useState<{ key?: string; rows: Alert[]; loading: boolean; error: boolean; clearing: boolean }>({
    rows: [], loading: true, error: false, clearing: false,
  });
  const current = (s: Session) => session.current === s && !s.controller.signal.aborted;
  const publish = (s: Session) => {
    if (current(s)) setView({
      key: s.scope.key, rows: visibleAlerts(s.rows.filter(a => a.type === 'sos' || !s.deleted.has(a.id)), s.marks),
      loading: s.loading, error: s.error, clearing: s.clearing,
    });
  };
  useLayoutEffect(() => {
    const s: Session | null = scope ? {
      scope, controller: new AbortController(), rows: [], marks: {}, request: 0, applied: 0,
      clearing: false, deleted: new Set(), loading: true, error: false,
    } : null;
    session.current = s;
    return () => {
      s?.controller.abort();
      if (session.current === s) session.current = null;
    };
    // Scope equality, not the freshly-created object, determines ownership.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const hydrate = (s: Session) => {
    if (!s.ready) s.ready = (async () => {
      const [cache, marks] = await Promise.all([
        alertStorage(s.scope.cacheKey, () => AsyncStorage.getItem(s.scope.cacheKey)).catch(() => null),
        alertStorage(s.scope.dismissalsKey, () => AsyncStorage.getItem(s.scope.dismissalsKey)).catch(() => null),
      ]);
      if (!current(s)) return;
      try { s.marks = decodeDismissals(marks); } catch { s.marks = {}; }
      try {
        const rows = cache ? JSON.parse(cache) : null;
        if (Array.isArray(rows)) { s.rows = rows; s.loading = false; }
      } catch { /* An unreadable cache is not authority to hide an emergency. */ }
      publish(s);
    })();
    return s.ready;
  };

  const cache = (s: Session) => alertStorage(s.scope.cacheKey, async () => {
    if (current(s)) await AsyncStorage.setItem(
      s.scope.cacheKey, JSON.stringify(s.rows.filter(a => a.type === 'sos' || !s.deleted.has(a.id))),
    );
  });

  const loadSession = async (s: Session) => {
    await hydrate(s);
    if (!current(s)) return;
    const request = ++s.request;
    try {
      const r = await api.get('/alerts', { signal: s.controller.signal });
      if (!current(s) || request < s.applied) return;
      if (!Array.isArray(r.data)) throw new Error('Invalid alerts response');
      s.applied = request;
      s.rows = r.data;
      s.error = false;
      s.loading = false;
      publish(s);
      try { await cache(s); } catch { /* Raw cache failure does not discard live alerts. */ }
    } catch {
      if (current(s) && request >= s.applied) {
        s.applied = request;
        s.error = true;
        s.loading = false;
        publish(s);
      }
    }
  };

  useFocusEffect(useCallback(() => {
    const s = session.current;
    if (!s) return;
    void loadSession(s);
    const t1 = setTimeout(() => { void loadSession(s); }, 1500);
    const t2 = setTimeout(() => { void loadSession(s); }, 4000);
    return () => { clearTimeout(t1); clearTimeout(t2); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]));

  const load = async () => {
    const s = session.current;
    if (s) await loadSession(s);
  };

  // Snapshot both ownership and resolution generation when opening the dialog.
  const prepareClear = () => {
    const s = session.current;
    const selected = view.rows;
    const ownerKey = key;
    return async () => {
      if (!s || !current(s) || s.scope.key !== ownerKey) throw new Error('Account or family changed. Reopen Clear All.');
      if (s.clearing) return;
      s.clearing = true;
      publish(s);
      try {
        const resolved = selected.filter(a => sosResolution(a) !== null).filter(a =>
          s.rows.some(latest => latest.id === a.id && sosResolution(latest) === sosResolution(a)),
        );
        if (resolved.length) {
          s.marks = await persistSosDismissals(s.scope, resolved, () => current(s));
          if (!current(s)) return;
          // If an incident reopened during persistence, its resolved=false still
          // overrides this mark. A new resolution timestamp also remains visible.
          publish(s);
        }
        if (!current(s)) return;
        if (selected.some(a => a.type !== 'sos')) {
          await api.delete('/alerts', { signal: s.controller.signal });
          if (!current(s)) return;
          selected.filter(a => a.type !== 'sos').forEach(a => s.deleted.add(a.id));
          publish(s); // Preserve SOS and arrivals not in the confirmed snapshot.
          try {
            await alertStorage(s.scope.cacheKey, async () => {
              if (current(s)) await AsyncStorage.removeItem(s.scope.cacheKey);
            });
            await cache(s);
          } catch {
            throw new Error('Ordinary alerts were cleared, but the local cache could not be updated. Refresh before retrying.');
          }
        }
      } catch (error) {
        if (current(s)) throw new Error(
          `Could not finish Clear All. Some completed actions may remain applied. ${
            error instanceof Error ? error.message : 'Please try again.'
          }`,
        );
      } finally {
        if (current(s)) { s.clearing = false; publish(s); }
      }
    };
  };
  const owned = view.key === key;
  return {
    alerts: owned ? view.rows : [], loading: !!key && (!owned || view.loading),
    loadError: owned && view.error, clearing: owned && view.clearing, load, prepareClear,
  };
}
