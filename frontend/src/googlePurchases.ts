// Native billing is loaded only on an explicitly enabled Android billing screen.
// Never import this native package at module scope: older OTA runtimes lack it.
import { Platform } from 'react-native';
import { api, BillingStatus } from './api';
import type { PurchasesPackage } from 'react-native-purchases';

type Binding = {
  user_id: string;
  app_user_id: string;
  can_purchase: boolean;
  products: { month: string; year: string };
};
type SDK = typeof import('react-native-purchases').default;
export type GooglePlans = Partial<Record<'month' | 'year', PurchasesPackage>>;

export function googlePurchasesEnabled() {
  return Platform.OS === 'android' && process.env.EXPO_PUBLIC_GOOGLE_BILLING_ENABLED === 'true';
}

// Serializes native SDK identity changes across screens and rapid account switches.
let queue: Promise<unknown> = Promise.resolve();
let configured = false;
function exclusive<T>(action: () => Promise<T>): Promise<T> {
  const next = queue.catch(() => undefined).then(action);
  queue = next;
  return next;
}

async function bind(expectedUser: string, currentUser: () => string | undefined) {
  if (!googlePurchasesEnabled()) throw new Error('Google Play billing is not enabled.');
  const apiKey = process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY;
  if (!apiKey?.startsWith('goog_')) throw new Error('Google Play billing is not configured.');
  const check = () => {
    if (!expectedUser || currentUser() !== expectedUser) throw new Error('Account changed. Reopen your plan screen.');
  };
  check();
  const { data: binding } = await api.post<Binding>('/billing/google/identity', {});
  check();
  if (binding.user_id !== expectedUser) throw new Error('Billing account mismatch.');
  const Purchases: SDK = (await import('react-native-purchases')).default;
  check();
  if (!configured) {
    Purchases.setLogLevel(Purchases.LOG_LEVEL.ERROR);
    Purchases.configure({ apiKey, appUserID: binding.app_user_id });
    configured = true;
  } else if (await Purchases.getAppUserID() !== binding.app_user_id) {
    check();
    await Purchases.logIn(binding.app_user_id);
  }
  check();
  return { Purchases, binding, check };
}

function selectPlans(packages: PurchasesPackage[], products: Binding['products']): GooglePlans {
  const result: GooglePlans = {};
  for (const interval of ['month', 'year'] as const) {
    result[interval] = packages.find(p => p.product.identifier === products[interval]);
  }
  return result;
}

export function loadGooglePlans(userId: string, current: () => string | undefined) {
  return exclusive(async () => {
    const { Purchases, binding, check } = await bind(userId, current);
    const offerings = await Purchases.getOfferings();
    check();
    return selectPlans(offerings.current?.availablePackages || [], binding.products);
  });
}

export function purchaseGooglePlan(interval: 'month' | 'year', userId: string, current: () => string | undefined) {
  return exclusive(async () => {
    const { Purchases, binding, check } = await bind(userId, current);
    if (!binding.can_purchase) throw new Error('Your account or family already has Family Plan access.');
    const offerings = await Purchases.getOfferings();
    check();
    const selected = selectPlans(offerings.current?.availablePackages || [], binding.products)[interval];
    if (!selected) throw new Error('This plan is not available from Google Play. Please try again later.');
    await Purchases.purchasePackage(selected);
    check();
    // A successful purchase callback is not authorization for family access.
    const response = await api.post<BillingStatus>('/billing/google/reconcile', {});
    check();
    return response.data;
  });
}

export function restoreGooglePurchases(userId: string, current: () => string | undefined) {
  return exclusive(async () => {
    const { Purchases, check } = await bind(userId, current);
    await Purchases.restorePurchases();
    check();
    const response = await api.post<BillingStatus>('/billing/google/reconcile', {});
    check();
    return response.data;
  });
}

export function reconcileGooglePurchases(userId: string, current: () => string | undefined) {
  return exclusive(async () => {
    const { Purchases, check } = await bind(userId, current);
    // Fetching CustomerInfo lets the SDK finish queued purchases. Never grant
    // access from CustomerInfo or automatically alias accounts with a restore.
    await Purchases.getCustomerInfo();
    check();
    const response = await api.post<BillingStatus>('/billing/google/reconcile', {});
    check();
    return response.data;
  });
}
