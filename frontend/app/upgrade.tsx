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
import { getBillingStatus, createCheckoutSession, BillingStatus } from '../src/api';

function priceLabel(s?: BillingStatus | null): string {
  if (!s) return '$9.99 / month';
  const amount = (s.paid_plan.amount_cents / 100).toFixed(2);
  const cur = (s.paid_plan.currency || 'usd').toUpperCase();
  return `$${amount} ${cur} / ${s.paid_plan.interval}`;
}

const FEATURES_FREE = [
  { ok: true, text: 'Up to 2 family members' },
  { ok: true, text: 'Daily check-ins' },
  { ok: true, text: 'Medications & routines' },
  { ok: true, text: 'SOS emergency button' },
  { ok: false, text: 'Unlimited family members' },
  { ok: false, text: 'Weekly compliance charts' },
  { ok: false, text: 'Priority SOS push to family' },
];

const FEATURES_PAID = [
  { ok: true, text: 'Unlimited family members' },
  { ok: true, text: 'Daily check-ins' },
  { ok: true, text: 'Medications & routines' },
  { ok: true, text: 'SOS emergency button' },
  { ok: true, text: 'Weekly compliance charts' },
  { ok: true, text: 'Priority SOS push to family' },
  { ok: true, text: 'Cancel anytime' },
];

export default function UpgradeScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ status?: string }>();
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const load = async () => {
    try {
      setLoading(true);
      const s = await getBillingStatus();
      setStatus(s);
    } catch (e) {
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

  const onUpgrade = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const base = process.env.EXPO_PUBLIC_BACKEND_URL || '';
      // We bring users back to /upgrade so the screen can refresh state.
      const returnUrl = `${base}/upgrade`;
      const { checkout_url } = await createCheckoutSession(returnUrl);
      if (!checkout_url) throw new Error('No checkout URL returned');
      if (Platform.OS === 'web') {
        window.location.href = checkout_url;
        return;
      }
      const result = await WebBrowser.openAuthSessionAsync(checkout_url, returnUrl);
      if (result.type === 'success' || result.type === 'cancel' || result.type === 'dismiss') {
        // refresh status after returning
        await load();
      }
    } catch (e: any) {
      Alert.alert('Could not start checkout', e?.response?.data?.detail || e?.message || 'Please try again.');
    } finally {
      setSubmitting(false);
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
              <Text style={styles.heroPrice}>{priceLabel(status)}</Text>
              <Text style={styles.heroSub}>
                {isPaid
                  ? 'Thanks for supporting Kinnship! All premium features are unlocked.'
                  : 'Unlock unlimited family members and every premium feature. Cancel anytime.'}
              </Text>
              {isPaid && status?.current_period_end ? (
                <Text style={styles.periodLine}>
                  Renews on {new Date(status.current_period_end).toLocaleDateString()}
                </Text>
              ) : null}
            </View>

            <View style={styles.plansRow}>
              <PlanCard
                title="Free"
                price="$0"
                subtitle="Up to 2 members"
                features={FEATURES_FREE}
                highlighted={!isPaid && (status?.plan === 'free')}
                badge={!isPaid ? 'Current' : undefined}
              />
              <PlanCard
                title="Family Plan"
                price={priceLabel(status)}
                subtitle="Unlimited members"
                features={FEATURES_PAID}
                highlighted={isPaid}
                badge={isPaid ? 'Current' : 'Recommended'}
              />
            </View>

            {!isPaid ? (
              <TouchableOpacity
                testID="upgrade-cta"
                style={[styles.cta, submitting && { opacity: 0.6 }]}
                onPress={onUpgrade}
                disabled={submitting}
                activeOpacity={0.85}
              >
                {submitting ? (
                  <ActivityIndicator color={Colors.surface} />
                ) : (
                  <Text style={styles.ctaText}>Continue to Checkout</Text>
                )}
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                testID="upgrade-manage"
                style={[styles.cta, styles.ctaSecondary]}
                onPress={onManage}
                disabled={!status?.manage_url}
                activeOpacity={0.85}
              >
                <Text style={[styles.ctaText, { color: Colors.primary }]}>
                  {status?.manage_url ? 'Manage Subscription' : 'Manage Subscription (unavailable)'}
                </Text>
              </TouchableOpacity>
            )}

            <Text style={styles.footer}>
              Payments are processed securely by Stripe. Test mode — use card number
              4242 4242 4242 4242 with any future expiry and any CVC.
            </Text>

            <View style={{ height: 24 }} />
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

function PlanCard(props: {
  title: string;
  price: string;
  subtitle: string;
  features: { ok: boolean; text: string }[];
  highlighted?: boolean;
  badge?: string;
}) {
  return (
    <View style={[styles.planCard, props.highlighted && styles.planCardActive]}>
      {props.badge ? (
        <View style={[styles.badge, props.highlighted && styles.badgeActive]}>
          <Text style={[styles.badgeText, props.highlighted && { color: Colors.surface }]}>
            {props.badge}
          </Text>
        </View>
      ) : null}
      <Text style={styles.planTitle}>{props.title}</Text>
      <Text style={styles.planPrice}>{props.price}</Text>
      <Text style={styles.planSub}>{props.subtitle}</Text>
      <View style={{ marginTop: 12 }}>
        {props.features.map((f, i) => (
          <View key={i} style={styles.featRow}>
            <Text style={[styles.featDot, !f.ok && { color: Colors.textTertiary }]}>
              {f.ok ? '✓' : '–'}
            </Text>
            <Text style={[styles.featText, !f.ok && { color: Colors.textTertiary }]} numberOfLines={2}>
              {f.text}
            </Text>
          </View>
        ))}
      </View>
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
    backgroundColor: Colors.surface, borderRadius: 18, padding: 22, alignItems: 'center',
    borderWidth: 1, borderColor: Colors.border,
    boxShadow: '0px 6px 18px rgba(27,94,53,0.10)' as any,
  },
  heroEmoji: { fontSize: 44, marginBottom: 8 },
  heroTitle: { fontSize: 20, fontWeight: '800', color: Colors.textPrimary, textAlign: 'center' },
  heroPrice: { fontSize: 28, fontWeight: '900', color: Colors.primary, marginTop: 6 },
  heroSub: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center', marginTop: 8, lineHeight: 20 },
  periodLine: { marginTop: 10, fontSize: 13, color: Colors.textTertiary, fontWeight: '600' },
  plansRow: {
    flexDirection: 'row', gap: 12, marginTop: 20,
  },
  planCard: {
    flex: 1, backgroundColor: Colors.surface, borderRadius: 14, padding: 14,
    borderWidth: 1, borderColor: Colors.border, minHeight: 220,
  },
  planCardActive: {
    borderColor: Colors.primary, borderWidth: 2,
    boxShadow: '0px 6px 14px rgba(27,94,53,0.12)' as any,
  },
  badge: {
    alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8,
    backgroundColor: Colors.tertiary, marginBottom: 8,
  },
  badgeActive: { backgroundColor: Colors.primary },
  badgeText: { fontSize: 11, fontWeight: '700', color: Colors.primary },
  planTitle: { fontSize: 16, fontWeight: '800', color: Colors.textPrimary },
  planPrice: { fontSize: 18, fontWeight: '900', color: Colors.primary, marginTop: 2 },
  planSub: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  featRow: { flexDirection: 'row', alignItems: 'flex-start', marginVertical: 3, gap: 6 },
  featDot: { width: 14, fontSize: 14, fontWeight: '800', color: Colors.primary },
  featText: { flex: 1, fontSize: 12.5, color: Colors.textPrimary, lineHeight: 18 },
  cta: {
    marginTop: 24, height: 56, borderRadius: 14,
    backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center',
    boxShadow: '0px 8px 14px rgba(27,94,53,0.22)' as any,
  },
  ctaSecondary: {
    backgroundColor: Colors.surface, borderWidth: 2, borderColor: Colors.primary,
    boxShadow: 'none' as any,
  },
  ctaText: { color: Colors.surface, fontSize: 16, fontWeight: '800' },
  footer: { marginTop: 18, fontSize: 12, color: Colors.textTertiary, textAlign: 'center', lineHeight: 18 },
  fineprint: { fontSize: 12, color: Colors.textTertiary, textAlign: 'center', textDecorationLine: 'underline' },
});
