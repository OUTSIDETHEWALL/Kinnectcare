import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const mockStatus = jest.fn();
const mockCheckout = jest.fn();
const mockPurchase = jest.fn();
const mockBrowser = jest.fn();
const mockManagementPost = jest.fn();
const mockGoogle = {
  enabled: true, error: null, plans: {
    month: { product: { priceString: 'store monthly' } },
    year: { product: { priceString: 'store annual' } },
  },
  purchase: mockPurchase, restore: jest.fn(),
};
jest.mock('../api', () => ({
  getBillingStatus: () => mockStatus(), createCheckoutSession: (...args: unknown[]) => mockCheckout(...args),
  api: {
    get: async () => ({ data: await mockStatus() }),
    post: (...args: unknown[]) => mockManagementPost(...args),
  },
}));
jest.mock('../useGoogleBilling', () => ({ useGoogleBilling: () => mockGoogle }));
jest.mock('react-native', () => ({
  Platform: { OS: 'android' }, NativeModules: { RNPurchases: { setupPurchases: jest.fn() } },
  View: 'View', Text: 'Text', ScrollView: 'ScrollView', TouchableOpacity: 'TouchableOpacity',
  ActivityIndicator: 'Spinner', StyleSheet: { create: (x: any) => x },
  Linking: { openURL: jest.fn() }, Alert: { alert: jest.fn() },
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }), useLocalSearchParams: () => ({}),
  Stack: { Screen: () => null },
}));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: (...args: unknown[]) => mockBrowser(...args) }));
jest.mock('../Icon', () => ({ Icon: 'Icon' }));
jest.mock('@expo/vector-icons/Ionicons', () => 'Icon');
import Upgrade from '../../app/upgrade';
import Manage from '../../app/manage-subscription';

let tree: ReturnType<typeof TestRenderer.create>;
beforeEach(() => {
  jest.clearAllMocks();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  process.env.EXPO_PUBLIC_GOOGLE_BILLING_ENABLED = 'true';
  process.env.EXPO_PUBLIC_GOOGLE_PURCHASES_ENABLED = 'true';
  mockStatus.mockResolvedValue({ plan: 'free', google_billing: { purchases_enabled: true } });
  mockCheckout.mockResolvedValue({ checkout_url: 'https://checkout.example.test/session' });
  mockBrowser.mockResolvedValue({ type: 'cancel' });
  mockPurchase.mockResolvedValue({ plan: 'family_plan' });
});
afterEach(async () => {
  if (tree) await act(async () => { tree.unmount(); });
  delete process.env.EXPO_PUBLIC_GOOGLE_BILLING_ENABLED;
  delete process.env.EXPO_PUBLIC_GOOGLE_PURCHASES_ENABLED;
});
async function mount() { await act(async () => { tree = TestRenderer.create(<Upgrade />); }); }

test.each(['integration', 'client-purchase', 'server-purchase'])(
  '%s disabled preserves the existing Android Stripe checkout end to end', async flag => {
    if (flag === 'integration') process.env.EXPO_PUBLIC_GOOGLE_BILLING_ENABLED = 'false';
    if (flag === 'client-purchase') process.env.EXPO_PUBLIC_GOOGLE_PURCHASES_ENABLED = 'false';
    if (flag === 'server-purchase') mockStatus.mockResolvedValue({ plan: 'free', google_billing: { purchases_enabled: false } });
    await mount();
    const button = tree.root.findByProps({ testID: 'upgrade-cta-annual' });
    await act(async () => { await button.props.onPress(); });
    expect(mockCheckout).toHaveBeenCalledWith('kinnship://upgrade', 'year');
    expect(mockBrowser).toHaveBeenCalledWith('https://checkout.example.test/session', 'kinnship://upgrade');
    expect(mockPurchase).not.toHaveBeenCalled();
  },
);

test('explicit two-sided Google rollout uses store purchase and never Stripe', async () => {
  await mount();
  await act(async () => { await tree.root.findByProps({ testID: 'upgrade-google-buy-year' }).props.onPress(); });
  expect(mockPurchase).toHaveBeenCalledWith('year');
  expect(mockCheckout).not.toHaveBeenCalled();
});

test('a started or failed Google purchase never falls through to Stripe', async () => {
  mockPurchase.mockRejectedValueOnce(new Error('Verification pending'));
  await mount();
  await act(async () => { await tree.root.findByProps({ testID: 'upgrade-google-buy-year' }).props.onPress(); });
  expect(mockCheckout).not.toHaveBeenCalled();
});

test.each(['cancel', 'resume'])('dual-provider %s UI explicitly manages Stripe without claiming Google was changed', async action => {
  const status = {
    plan: 'family_plan', billing_provider: 'stripe', billing_providers: ['stripe', 'google_play'],
    is_billing_owner: true, cancel_at_period_end: action === 'resume',
    current_period_end: '2027-01-01T00:00:00Z',
  };
  mockStatus.mockResolvedValue(status);
  mockManagementPost.mockResolvedValue({ data: { cancelled: true, resumed: true, immediate: false, billing_status: status } });
  await act(async () => { tree = TestRenderer.create(<Manage />); });
  const alerts = require('react-native').Alert.alert as jest.Mock;
  await act(async () => { await tree.root.findByProps({ testID: `subscription-${action}` }).props.onPress(); });
  if (action === 'cancel') {
    const [title, message, buttons] = alerts.mock.calls[alerts.mock.calls.length - 1];
    expect(title).toContain('Stripe');
    expect(message).toContain('Google Play subscription continues');
    await act(async () => { await buttons.find((b: any) => b.style === 'destructive').onPress(); });
  }
  expect(mockManagementPost).toHaveBeenCalledWith(`/billing/${action}`, { provider: 'stripe' });
  expect(alerts.mock.calls[alerts.mock.calls.length - 1][0]).toContain('Stripe');
});
