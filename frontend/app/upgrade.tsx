import { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  Alert, Linking, Platform,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as WebBrowser from 'expo-web-browser';
import { Icon } from '../src/Icon';
import { Colors } from '../src/theme';
import { getBillingStatus, createCheckoutSession, BillingStatus, PaidPlan } from '../src/api';

function formatPrice(cents: number, currency = 'usd'): string {
  const amount = (cents / 100).toFixed(2);
  return `$${amount}`;
}

function priceLine(p: PaidPlan): string {
  return `${formatPrice(p.amount_cents)} / ${p.interval === 'year' ? 'year' : 'month'}`;
}

function findPlan(s: BillingStatus | null, interval: 'month' | 'year'): PaidPlan | null {
  return s?.paid_plans?.find((p) => p.interval === interval) || null;
}

const FEATURES = [
  '✓  Unlimited family members',
  '✓  Daily check-ins & SOS',
  '✓  Medications & routines',
  '✓  Weekly compliance charts',
  '✓  Priority SOS push to family',
  '✓  Cancel anytime',
];

export default function UpgradeScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ status?: string }>();
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState<'month' | 'year' | null>(null);

  const load = async () => {
    try {
      setLoading(true);
      const s = await getBillingStatus();
      setStatus(s);
    } catch (_e) {
      // ignore — show defaults
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (params?.status === 'success') {
      Alert.alert('Subscription Active', 'Welcome to Kinnship Family Plan!');
      load();
    } else if (params?.status === 'cancel') {
      Alert.alert('Checkout Canceled', 'No worries — you can upgrade anytime.');
    }
  }, [params?.status]);

  const onUpgrade = async (interval: 'month' | 'year') => {
    if (submitting) return;
    setSubmitting(interval);
    try {
      const base = process.env.EXPO_PUBLIC_BACKEND_URL || '';
      const returnUrl = `${base}/upgrade`;
      const { checkout_url } = await createCheckoutSession(returnUrl, interval);
      if (!checkout_url) throw new Error('No checkout URL returned');
      if (Platform.OS === 'web') {
        window.location.href = checkout_url;
        return;
      }
      const result = await WebBrowser.openAuthSessionAsync(checkout_url, returnUrl);
      if (result.type === 'success' || result.type === 'cancel' || result.type === 'dismiss') {
        await load();
      }
    } catch (e: any) {
      Alert.alert('Could not start checkout', e?.response?.data?.detail || e?.message || 'Please try again.');
    } finally {
      setSubmitting(null);
    }
  };

  const onManage = async () => {
    if (!status?.manage_url) return;
    if (Platform.OS === 'web') {
      window.open(status.manage_url, '_blank');
    } else {
      await WebBrowser.openBrowserAsync(status.manage_url);
    }
  };

  const isPaid = status?.plan === 'family_plan';
  const monthly = findPlan(status, 'month');
  const annual = findPlan(status, 'year');
  const savings = (status?.annual_savings_cents || annual?.savings_cents || 0);
  const savingsLabel = savings > 0 ? `Save ${formatPrice(savings)}` : null;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity
          testID="upgrade-back"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/dashboard'))}
          style={styles.backBtn}
        >
          <Icon name="arrow-back" size={22} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{isPaid ? 'Your Plan' : 'Upgrade'}</Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        {loading ? (
          <ActivityIndicator color={Colors.primary} style={{ marginTop: 40 }} />
        ) : (
          <>
            <View style={styles.heroCard}>
              <Text style={styles.heroEmoji}>{isPaid ? '⭐' : '🚀'}</Text>
              <Text style={styles.heroTitle}>
                {isPaid ? 'Kinnship Family Plan' : 'Upgrade to Family Plan'}
              </Text>
              <Text style={styles.heroSub}>
                {isPaid
                  ? `You're on the ${status?.plan_label || 'Family Plan'}. All premium features are unlocked.`
                  : 'Unlock unlimited family members and every premium feature. Cancel anytime.'}
              </Text>
              {isPaid && status?.current_period_end ? (
                <Text style={styles.periodLine}>
                  Renews on {new Date(status.current_period_end).toLocaleDateString()}
                </Text>
              ) : null}
            </View>

            {/* Features list */}
            <View style={styles.featuresCard}>
              <Text style={styles.featuresLabel}>WHAT'S INCLUDED</Text>
              {FEATURES.map((f) => (
                <Text key={f} style={styles.featureLine}>{f}</Text>
              ))}
            </View>

            {!isPaid ? (
              <>
                {/* Annual plan (recommended, highlighted) */}
                {annual ? (
                  <PlanOption
                    testID="upgrade-plan-annual"
                    title="Annual"
                    price={priceLine(annual)}
                    pricePerMonth={`Just $${(annual.amount_cents / 12 / 100).toFixed(2)}/mo billed yearly`}
                    badge="Best Value"
                    savings={savingsLabel}
                    highlighted
                    ctaLabel={submitting === 'year' ? 'Loading…' : 'Choose Annual'}
                    ctaTestID="upgrade-cta-annual"
                    submitting={submitting === 'year'}
                    onPress={() => onUpgrade('year')}
                  />
                ) : null}

                {/* Monthly plan */}
                {monthly ? (
                  <PlanOption
                    testID="upgrade-plan-monthly"
                    title="Monthly"
                    price={priceLine(monthly)}
                    pricePerMonth="Billed every month · cancel anytime"
                    ctaLabel={submitting === 'month' ? 'Loading…' : 'Choose Monthly'}
                    ctaTestID="upgrade-cta-monthly"
                    submitting={submitting === 'month'}
                    onPress={() => onUpgrade('month')}
                  />
                ) : null}
              </>
            ) : (
              <View style={styles.activePlanCard} testID="upgrade-current-plan">
                <Text style={styles.activePlanEyebrow}>YOUR CURRENT PLAN</Text>
                <Text style={styles.activePlanTitle}>
                  {status?.plan_label || 'Family Plan'}
                </Text>
                <Text style={styles.activePlanPrice}>
                  {status?.paid_plan ? (
                    `${formatPrice(status.paid_plan.amount_cents)} / ${status.paid_plan.interval}`
                  ) : '—'}
                </Text>
                <TouchableOpacity
                  testID="upgrade-manage"
                  style={[styles.ctaSecondary]}
                  onPress={onManage}
                  disabled={!status?.manage_url}
                  activeOpacity={0.85}
                >
                  <Text style={styles.ctaSecondaryText}>
                    {status?.manage_url ? 'Manage Subscription' : 'Manage Subscription (unavailable)'}
                  </Text>
                </TouchableOpacity>
              </View>
            )}

            <Text style={styles.footer}>
              Payments are processed securely by Stripe. Test mode — use card number
              4242 4242 4242 4242 with any future expiry and any CVC.
            </Text>

            <View style={{ height: 16 }} />
            <TouchableOpacity
              onPress={() => Linking.openURL('https://stripe.com/legal/consumer')}
              hitSlop={10}
            >
              <Text style={styles.fineprint}>Powered by Stripe · Test Mode</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function PlanOption(props: {
  testID: string;
  title: string;
  price: string;
  pricePerMonth: string;
  badge?: string;
  savings?: string | null;
  highlighted?: boolean;
  ctaLabel: string;
  ctaTestID: string;
  submitting: boolean;
  onPress: () => void;
}) {
  return (
    <View
      testID={props.testID}
      style={[styles.planOption, props.highlighted && styles.planOptionHighlighted]}
    >
      {props.badge ? (
        <View style={[styles.bestBadge, !props.highlighted && styles.bestBadgeDim]}>
          <Text style={styles.bestBadgeText}>⭐ {props.badge}</Text>
        </View>
      ) : null}
      <View style={styles.planOptionTop}>
        <View style={{ flex: 1, paddingRight: 8 }}>
          <Text style={styles.planOptionTitle}>{props.title}</Text>
          <Text style={styles.planOptionPrice}>{props.price}</Text>
          <Text style={styles.planOptionPerMonth}>{props.pricePerMonth}</Text>
        </View>
        {props.savings ? (
          <View style={styles.savingsPill}>
            <Text style={styles.savingsPillText}>{props.savings}</Text>
          </View>
        ) : null}
      </View>
      <TouchableOpacity
        testID={props.ctaTestID}
        style={[
          styles.cta,
          props.highlighted ? styles.ctaPrimary : styles.ctaMonochrome,
          props.submitting && { opacity: 0.6 },
        ]}
        onPress={props.onPress}
        disabled={props.submitting}
        activeOpacity={0.85}
      >
        {props.submitting ? (
          <ActivityIndicator color={props.highlighted ? Colors.surface : Colors.primary} />
        ) : (
          <Text
            style={[
              styles.ctaText,
              !props.highlighted && { color: Colors.primary },
            ]}
          >
            {props.ctaLabel}
          </Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 8,
    borderBottomWidth: 1, borderBottomColor: Colors.border, backgroundColor: Colors.surface,
  },
  backBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 17, fontWeight: '800', color: Colors.textPrimary, flex: 1, textAlign: 'center' },
  scroll: { padding: 20, paddingBottom: 56 },
  heroCard: {
    backgroundColor: Colors.surface, borderRadius: 18, padding: 20, alignItems: 'center',
    borderWidth: 1, borderColor: Colors.border,
    boxShadow: '0px 6px 18px rgba(27,94,53,0.10)' as any,
  },
  heroEmoji: { fontSize: 40, marginBottom: 6 },
  heroTitle: { fontSize: 22, fontWeight: '900', color: Colors.textPrimary, textAlign: 'center' },
  heroSub: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center', marginTop: 6, lineHeight: 20 },
  periodLine: { marginTop: 8, fontSize: 13, color: Colors.textTertiary, fontWeight: '600' },

  featuresCard: {
    marginTop: 16,
    backgroundColor: Colors.surface,
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  featuresLabel: { fontSize: 11, fontWeight: '800', color: Colors.textTertiary, letterSpacing: 1.2, marginBottom: 8 },
  featureLine: { fontSize: 14, color: Colors.textPrimary, lineHeight: 24 },

  planOption: {
    marginTop: 16,
    backgroundColor: Colors.surface,
    borderRadius: 18,
    padding: 18,
    borderWidth: 1.5,
    borderColor: Colors.border,
    position: 'relative',
  },
  planOptionHighlighted: {
    borderColor: Colors.primary,
    borderWidth: 2.5,
    boxShadow: '0px 10px 22px rgba(27,94,53,0.18)' as any,
    transform: [{ scale: 1.0 }],
  },
  bestBadge: {
    position: 'absolute',
    top: -12,
    left: 18,
    backgroundColor: Colors.primary,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 999,
    boxShadow: '0px 4px 8px rgba(27,94,53,0.30)' as any,
  },
  bestBadgeDim: { backgroundColor: Colors.textTertiary },
  bestBadgeText: { color: Colors.surface, fontSize: 11, fontWeight: '900', letterSpacing: 0.4 },

  planOptionTop: { flexDirection: 'row', alignItems: 'center', marginTop: 4, marginBottom: 14 },
  planOptionTitle: { fontSize: 16, fontWeight: '800', color: Colors.textPrimary, marginBottom: 2 },
  planOptionPrice: { fontSize: 26, fontWeight: '900', color: Colors.primary, marginTop: 2 },
  planOptionPerMonth: { fontSize: 12.5, color: Colors.textSecondary, marginTop: 4, lineHeight: 18 },

  savingsPill: {
    backgroundColor: Colors.successBg,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: Colors.success,
  },
  savingsPillText: { fontSize: 13, fontWeight: '900', color: Colors.success },

  cta: {
    height: 52, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
  },
  ctaPrimary: {
    backgroundColor: Colors.primary,
    boxShadow: '0px 6px 12px rgba(27,94,53,0.22)' as any,
  },
  ctaMonochrome: {
    backgroundColor: Colors.surface,
    borderWidth: 2,
    borderColor: Colors.primary,
  },
  ctaText: { color: Colors.surface, fontSize: 16, fontWeight: '800' },
  ctaSecondary: {
    marginTop: 16,
    height: 52,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.surface,
    borderWidth: 2,
    borderColor: Colors.primary,
  },
  ctaSecondaryText: { color: Colors.primary, fontSize: 16, fontWeight: '800' },

  activePlanCard: {
    marginTop: 16, backgroundColor: Colors.surface, borderRadius: 18, padding: 18,
    borderWidth: 2, borderColor: Colors.primary,
    boxShadow: '0px 6px 14px rgba(27,94,53,0.14)' as any,
  },
  activePlanEyebrow: { fontSize: 11, fontWeight: '800', color: Colors.textTertiary, letterSpacing: 1.2 },
  activePlanTitle: { fontSize: 20, fontWeight: '900', color: Colors.textPrimary, marginTop: 4 },
  activePlanPrice: { fontSize: 18, fontWeight: '800', color: Colors.primary, marginTop: 4 },

  footer: { marginTop: 24, fontSize: 12, color: Colors.textTertiary, textAlign: 'center', lineHeight: 18 },
  fineprint: { fontSize: 12, color: Colors.textTertiary, textAlign: 'center', textDecorationLine: 'underline' },
});
