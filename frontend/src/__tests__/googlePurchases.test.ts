// Real controller under a mocked native/store boundary; never hits live billing.
const mockPost = jest.fn();
const mockSDK = {
  configure: jest.fn(),
  setLogLevel: jest.fn(),
  LOG_LEVEL: { ERROR: 'ERROR' },
  getAppUserID: jest.fn(),
  logIn: jest.fn(),
  getOfferings: jest.fn(),
  purchasePackage: jest.fn(),
  restorePurchases: jest.fn(),
  getCustomerInfo: jest.fn(),
};
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('../api', () => ({ api: { post: (...args: unknown[]) => mockPost(...args) } }));
jest.mock('react-native-purchases', () => ({ __esModule: true, default: mockSDK }));

let subject: typeof import('../googlePurchases');
const monthly = { identifier: '$rc_monthly', product: { identifier: 'family_plan:monthly', priceString: '$11.99' } };
const annual = { identifier: '$rc_annual', product: { identifier: 'family_plan:annual', priceString: '$99.99' } };
const binding = {
  user_id: 'buyer', app_user_id: 'opaque-server-identity', can_purchase: true,
  products: { month: 'family_plan:monthly', year: 'family_plan:annual' },
};
const backendStatus = { plan: 'family_plan', billing_provider: 'google_play' };

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  process.env.EXPO_PUBLIC_GOOGLE_BILLING_ENABLED = 'true';
  process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY = 'goog_synthetic_public_key';
  mockPost.mockImplementation(async (url: string) => ({
    data: url.endsWith('identity') ? binding : backendStatus,
  }));
  mockSDK.getOfferings.mockResolvedValue({ current: { availablePackages: [monthly, annual] } });
  mockSDK.getAppUserID.mockResolvedValue(binding.app_user_id);
  mockSDK.purchasePackage.mockResolvedValue({ customerInfo: { entitlements: { active: { untrusted: {} } } } });
  mockSDK.getCustomerInfo.mockResolvedValue({});
  mockSDK.restorePurchases.mockResolvedValue({});
  subject = require('../googlePurchases');
});

afterEach(() => {
  delete process.env.EXPO_PUBLIC_GOOGLE_BILLING_ENABLED;
  delete process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY;
});

test('maps both store-priced base plans and configures only opaque identity plus public key', async () => {
  const plans = await subject.loadGooglePlans('buyer', () => 'buyer');
  expect(plans.month).toEqual(monthly);
  expect(plans.year).toEqual(annual);
  expect(mockSDK.configure).toHaveBeenCalledWith({
    apiKey: 'goog_synthetic_public_key', appUserID: binding.app_user_id,
  });
  expect(mockPost).toHaveBeenCalledWith('/billing/google/identity', {});
});

test('disabled flag never loads or configures the native SDK or calls backend', async () => {
  process.env.EXPO_PUBLIC_GOOGLE_BILLING_ENABLED = 'false';
  await expect(subject.purchaseGooglePlan('month', 'buyer', () => 'buyer')).rejects.toThrow('not enabled');
  expect(mockSDK.configure).not.toHaveBeenCalled();
  expect(mockPost).not.toHaveBeenCalled();
});

test('rejects a secret or test-store key in the Android public configuration', async () => {
  process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY = 'sk_synthetic_not_public';
  await expect(subject.loadGooglePlans('buyer', () => 'buyer')).rejects.toThrow('not configured');
  expect(mockSDK.configure).not.toHaveBeenCalled();
});

test.each(['month', 'year'] as const)('purchase %s returns backend state, never CustomerInfo grants', async interval => {
  mockPost.mockImplementation(async (url: string) => ({ data: url.endsWith('identity') ? binding : { plan: 'free' } }));
  const status = await subject.purchaseGooglePlan(interval, 'buyer', () => 'buyer');
  expect(mockSDK.purchasePackage).toHaveBeenCalledWith(interval === 'month' ? monthly : annual);
  expect(status.plan).toBe('free');
  expect(mockPost).toHaveBeenLastCalledWith('/billing/google/reconcile', {});
});

test('an existing Stripe or family entitlement prevents another Google purchase', async () => {
  mockPost.mockResolvedValue({ data: { ...binding, can_purchase: false } });
  await expect(subject.purchaseGooglePlan('month', 'buyer', () => 'buyer')).rejects.toThrow('already has');
  expect(mockSDK.purchasePackage).not.toHaveBeenCalled();
});

test('restore uses original authenticated identity and backend verification', async () => {
  expect(await subject.restoreGooglePurchases('buyer', () => 'buyer')).toEqual(backendStatus);
  expect(mockSDK.restorePurchases).toHaveBeenCalledTimes(1);
  expect(mockPost).toHaveBeenLastCalledWith('/billing/google/reconcile', {});
});

test('cross-account identity response never reaches SDK configuration', async () => {
  mockPost.mockResolvedValue({ data: { ...binding, user_id: 'another-user' } });
  await expect(subject.restoreGooglePurchases('buyer', () => 'buyer')).rejects.toThrow('mismatch');
  expect(mockSDK.configure).not.toHaveBeenCalled();
});

test('sign out or account switch during purchase never reconciles under the new account', async () => {
  let current: string | undefined = 'buyer';
  mockSDK.purchasePackage.mockImplementationOnce(async () => { current = undefined; return {}; });
  await expect(subject.purchaseGooglePlan('month', 'buyer', () => current)).rejects.toThrow('Account changed');
  expect(mockPost.mock.calls.filter(c => c[0].endsWith('reconcile'))).toHaveLength(0);
});

test('failed purchase never grants or reconciles', async () => {
  mockSDK.purchasePackage.mockRejectedValueOnce({ userCancelled: true });
  await expect(subject.purchaseGooglePlan('month', 'buyer', () => 'buyer')).rejects.toEqual({ userCancelled: true });
  expect(mockPost.mock.calls.filter(c => c[0].endsWith('reconcile'))).toHaveLength(0);
});

test('foreground reconciliation never calls restore or trusts cached customer entitlements', async () => {
  expect(await subject.reconcileGooglePurchases('buyer', () => 'buyer')).toEqual(backendStatus);
  expect(mockSDK.getCustomerInfo).toHaveBeenCalled();
  expect(mockSDK.restorePurchases).not.toHaveBeenCalled();
});

test('unavailable store product never falls back to Stripe or a hardcoded purchase', async () => {
  mockSDK.getOfferings.mockResolvedValueOnce({ current: null });
  await expect(subject.purchaseGooglePlan('year', 'buyer', () => 'buyer')).rejects.toThrow('not available');
  expect(mockSDK.purchasePackage).not.toHaveBeenCalled();
});
