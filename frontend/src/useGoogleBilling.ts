import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useAuth } from './AuthContext';
import {
  GooglePlans, googlePurchasesEnabled, loadGooglePlans, purchaseGooglePlan,
  reconcileGooglePurchases, restoreGooglePurchases,
} from './googlePurchases';

export function useGoogleBilling(onReconciled: () => void) {
  const { user } = useAuth();
  const current = useRef(user?.id);
  const refreshed = useRef(onReconciled);
  const [plans, setPlans] = useState<GooglePlans>({});
  const [error, setError] = useState<string | null>(null);
  const enabled = googlePurchasesEnabled();
  useLayoutEffect(() => {
    current.current = user?.id;
    refreshed.current = onReconciled;
    return () => { current.current = undefined; };
  });
  useEffect(() => {
    setPlans({});
    setError(null);
    if (!enabled || !user?.id) return;
    let alive = true;
    const id = user.id;
    const getCurrent = () => alive ? current.current : undefined;
    const refresh = async () => {
      try {
        const loaded = await loadGooglePlans(id, getCurrent);
        if (alive) { setPlans(loaded); setError(null); }
        await reconcileGooglePurchases(id, getCurrent);
        if (alive) refreshed.current();
      } catch (e: any) {
        if (alive) setError(e?.message || 'Google Play billing is temporarily unavailable.');
      }
    };
    void refresh();
    const listener = AppState.addEventListener('change', state => {
      if (state === 'active') void refresh();
    });
    return () => { alive = false; listener.remove(); };
  }, [enabled, user?.id]);
  const requireUser = () => {
    if (!user?.id) throw new Error('Sign in before purchasing or restoring.');
    return user.id;
  };
  return {
    enabled, plans, error,
    purchase: (interval: 'month' | 'year') => purchaseGooglePlan(interval, requireUser(), () => current.current),
    restore: () => restoreGooglePurchases(requireUser(), () => current.current),
  };
}
