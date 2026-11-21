import { useEffect, useLayoutEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useAuth } from './AuthContext';
import { googlePurchasesEnabled, reconcileGooglePurchases } from './googlePurchases';

/** Optional work: never awaited by authentication, navigation, SOS or tracking. */
export function useGoogleBillingRecovery() {
  const { user, loading, refreshUser } = useAuth();
  const current = useRef(user?.id);
  const refresh = useRef(refreshUser);
  useLayoutEffect(() => {
    current.current = loading ? undefined : user?.id;
    refresh.current = refreshUser;
    return () => { current.current = undefined; };
  });
  useEffect(() => {
    if (loading || !user?.id || !googlePurchasesEnabled()) return;
    let alive = true;
    let running = false;
    let attempts = 0;
    const id = user.id;
    const getCurrent = () => alive ? current.current : undefined;
    let timer: ReturnType<typeof setTimeout>;
    const run = async () => {
      if (!alive || running || attempts >= 3) return;
      running = true;
      attempts += 1;
      try {
        await reconcileGooglePurchases(id, getCurrent);
        if (alive && getCurrent() === id) void refresh.current?.();
      } catch {
        if (alive && attempts < 3) timer = setTimeout(() => { void run(); }, attempts === 1 ? 5_000 : 30_000);
        // Fail explicitly in logs, but never throw into core app lifecycle.
        if (alive && attempts === 3) console.warn('Google purchase recovery deferred after three attempts.');
      } finally {
        running = false;
      }
    };
    timer = setTimeout(() => { void run(); }, 1_500);
    const listener = AppState.addEventListener('change', state => {
      if (state === 'active' && !running && attempts < 3) {
        clearTimeout(timer);
        void run();
      }
    });
    return () => { alive = false; clearTimeout(timer); listener.remove(); };
  }, [loading, user?.id]);
}
