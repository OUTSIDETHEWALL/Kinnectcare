import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, Alert,
  ActivityIndicator, Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, Stack } from 'expo-router';
import Icon from '@expo/vector-icons/Ionicons';
import { Colors } from '../src/theme';
import { api } from '../src/api';

export default function ManageSubscription() {
  const router = useRouter();
  const [status, setStatus] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // Fetch error — when the /billing/status call fails (timeout, transient
  // 5xx, dropped network) we MUST NOT silently fall back to "Free Plan"
  // because that hides a paid subscription behind an Upgrade button. We
  // surface an explicit error state with Retry instead.
  const [fetchError, setFetchError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setFetchError(null);
    try {
      const r = await api.get('/billing/status');
      setStatus(r.data);
    } catch (e: any) {
      // Keep any previously-loaded status so the user doesn't lose info
      // on a transient failure; only flip into the error banner if we
      // never successfully loaded.
      const detail = e?.response?.data?.detail || e?.message || 'Could not load subscription status.';
      setFetchError(detail);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const isPaid = status?.plan === 'family_plan' || status?.plan === 'premium';
  const cancellingAtEnd = !!status?.cancel_at_period_end;
  const cpe = status?.current_period_end || null;
  // Full date in user's local tz.
  const renewalLabel = cpe ? new Date(cpe).toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  }) : null;
  const intervalLabel = status?.interval === 'year' ? 'Annual' : (status?.interval === 'month' ? 'Monthly' : '');
  const priceLabel = (() => {
    const cents = status?.paid_plan?.amount_cents;
    if (!cents) return null;
    return `$${(cents / 100).toFixed(2)}`;
  })();

  const onCancel = () => {
    if (!isPaid) {
      Alert.alert('Already on Free', 'You are not currently subscribed.');
      return;
    }
    if (cancellingAtEnd) {
      Alert.alert('Already cancelling', `Your subscription will end on ${renewalLabel}.`);
      return;
    }
    Alert.alert(
      'Cancel Family Plan?',
      `You'll keep Family Plan features until ${renewalLabel || 'the end of this billing period'}. After that you'll be moved to the free tier (2 members max). You won't be charged again.`,
      [
        { text: 'Keep my plan', style: 'cancel' },
        {
          text: 'Cancel subscription',
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            try {
              const r = await api.post('/billing/cancel', {});
              setStatus(r.data.billing_status || status);
              Alert.alert(
                r.data.immediate ? 'Subscription ended' : 'Subscription cancelled',
                r.data.immediate
                  ? 'You are now on the free tier.'
                  : `You'll keep Family Plan access until ${renewalLabel || 'the end of this period'}.`
              );
            } catch (e: any) {
              Alert.alert('Failed', e?.response?.data?.detail || 'Could not cancel. Please try again.');
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  };

  const onResume = async () => {
    setBusy(true);
    try {
      const r = await api.post('/billing/resume', {});
      setStatus(r.data.billing_status || status);
      Alert.alert('Subscription resumed', 'Your Family Plan will continue to auto-renew.');
    } catch (e: any) {
      Alert.alert('Failed', e?.response?.data?.detail || 'Could not resume. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const onUpgrade = () => router.push('/upgrade');

  const onOpenPortal = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Explicitly ask the backend to mint a fresh portal URL (?portal=1).
      // The regular /billing/status request does NOT include manage_url
      // because portal session creation is rate-limited and slow — we only
      // pay that cost when the user taps "Payment methods & invoices".
      const r = await api.get('/billing/status?portal=1');
      setStatus(r.data);
      const url: string | null = r.data?.manage_url;
      if (!url) {
        Alert.alert('Unavailable', 'The billing portal is currently unavailable. Please try again in a moment.');
        return;
      }
      const supported = await Linking.canOpenURL(url);
      if (supported) await Linking.openURL(url);
      else Alert.alert('Cannot open portal', 'Your device could not open the billing portal link.');
    } catch (e: any) {
      Alert.alert('Failed', e?.response?.data?.detail || 'Could not open the billing portal.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}><ActivityIndicator color={Colors.primary} /></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity
          testID="subscription-back"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/settings'))}
          style={styles.backBtn}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Icon name="arrow-back" size={28} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Manage Subscription</Text>
        <View style={{ width: 52 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        {/* Fetch-error banner — visible at top whenever the most recent
            /billing/status call failed. CRITICAL: do NOT fall back to
            "Free Plan" rendering — that wrongly suggests the user is
            unsubscribed when their card is being charged $9.99/mo.
            Instead, surface the error explicitly and let them retry. */}
        {fetchError && (
          <View testID="subscription-fetch-error" style={styles.errorCard}>
            <Icon name="cloud-offline-outline" size={20} color={Colors.error} />
            <View style={{ flex: 1, marginLeft: 10 }}>
              <Text style={styles.errorTitle}>Couldn't load subscription</Text>
              <Text style={styles.errorSub}>
                Your plan info isn't shown below because we couldn't reach the billing
                service. {status ? 'Showing last-known status.' : ''} {String(fetchError).slice(0, 120)}
              </Text>
            </View>
            <TouchableOpacity onPress={load} style={styles.retryBtn} testID="subscription-retry">
              <Text style={styles.retryBtnText}>Retry</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* When we have no status at all AND fetch failed, show a clean
            error placeholder INSTEAD of the misleading Free Plan card. */}
        {!status && fetchError ? (
          <View style={styles.unknownPlanCard}>
            <Text style={styles.planEmoji}>📡</Text>
            <Text style={styles.planName}>Plan status unavailable</Text>
            <Text style={styles.planSub}>
              Pull down to refresh or tap Retry above. Your subscription is
              unaffected — this is only a display issue.
            </Text>
          </View>
        ) : (
          <>
            {/* Current plan card */}
            <View style={[styles.planCard, isPaid && styles.planCardPaid]}>
              <Text style={styles.planEmoji}>{isPaid ? '👨‍👩‍👧‍👦' : '🆓'}</Text>
              <Text
                style={[styles.planName, isPaid && styles.planNamePaid]}
                testID="current-plan-name"
              >
                {isPaid ? 'Family Plan' : 'Free Plan'}
              </Text>
              {isPaid && (
                <Text style={[styles.planSub, styles.planSubPaid]}>
                  {intervalLabel}{priceLabel ? ` · ${priceLabel}/${status?.interval === 'year' ? 'year' : 'month'}` : ''}
                </Text>
              )}
              {!isPaid && (
                <Text style={styles.planSub}>Up to 2 family members</Text>
              )}
            </View>

            {/* Renewal info */}
            {isPaid && renewalLabel && (
              <View style={styles.infoCard}>
                <Text style={styles.infoLabel}>
                  {cancellingAtEnd ? '⏳ Ends on' : '🔁 Renews on'}
                </Text>
                <Text style={styles.infoValue} testID="renewal-date">{renewalLabel}</Text>
                {cancellingAtEnd && (
                  <Text style={styles.warnNote}>
                    Your subscription will not auto-renew. You'll keep Family Plan
                    features until this date, then move to the free tier.
                  </Text>
                )}
              </View>
            )}

            {/* Member usage */}
            <View style={styles.infoCard}>
              <Text style={styles.infoLabel}>👥 Family members</Text>
              <Text style={styles.infoValue}>
                {status?.member_count ?? 0}
                {status?.member_limit ? ` / ${status.member_limit}` : ' (unlimited)'}
              </Text>
            </View>
          </>
        )}

        {/* Action buttons */}
        <View style={{ height: 24 }} />

        {/* Billing portal (payment methods, invoices, history) — paid users only */}
        {isPaid && (
          <TouchableOpacity
            testID="subscription-portal"
            onPress={onOpenPortal}
            activeOpacity={0.85}
            style={[styles.portalBtn, { marginBottom: 12 }]}
            disabled={busy}
          >
            <Icon name="card-outline" size={20} color={Colors.primary} />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={styles.portalBtnTitle}>Payment methods & invoices</Text>
              <Text style={styles.portalBtnSub}>Update card, view receipts, download invoices.</Text>
            </View>
            {busy
              ? <ActivityIndicator color={Colors.primary} />
              : <Icon name="open-outline" size={18} color={Colors.textTertiary} />}
          </TouchableOpacity>
        )}

        {!isPaid && (
          <TouchableOpacity
            testID="subscription-upgrade-cta"
            onPress={onUpgrade}
            activeOpacity={0.85}
            style={styles.primaryBtn}
          >
            <Text style={styles.primaryBtnText}>Upgrade to Family Plan</Text>
          </TouchableOpacity>
        )}

        {isPaid && !cancellingAtEnd && (
          <TouchableOpacity
            testID="subscription-cancel"
            onPress={onCancel}
            activeOpacity={0.85}
            style={styles.dangerBtn}
            disabled={busy}
          >
            {busy
              ? <ActivityIndicator color={Colors.error} />
              : <Text style={styles.dangerBtnText}>Cancel Subscription</Text>}
          </TouchableOpacity>
        )}

        {isPaid && cancellingAtEnd && (
          <TouchableOpacity
            testID="subscription-resume"
            onPress={onResume}
            activeOpacity={0.85}
            style={styles.primaryBtn}
            disabled={busy}
          >
            {busy
              ? <ActivityIndicator color={Colors.surface} />
              : <Text style={styles.primaryBtnText}>Resume Auto-Renewal</Text>}
          </TouchableOpacity>
        )}

        <Text style={styles.fineprint}>
          Billing is handled securely by Stripe. Cancelling here disables
          auto-renewal — your card will not be charged again.
          {isPaid ? ' Use "Payment methods & invoices" above to update your card or download receipts.' : ''}
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}


const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 6,
  },
  backBtn: {
    width: 52, height: 52, alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: { fontSize: 18, fontWeight: '800', color: Colors.textPrimary },
  scroll: { padding: 20, paddingBottom: 56 },

  planCard: {
    backgroundColor: Colors.surface,
    borderRadius: 18, padding: 20,
    alignItems: 'center',
    borderWidth: 1, borderColor: Colors.border,
  },
  planCardPaid: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  planEmoji: { fontSize: 38, marginBottom: 6 },
  planName: { fontSize: 22, fontWeight: '900', color: Colors.textPrimary },
  planSub: { marginTop: 4, fontSize: 14, color: Colors.textSecondary, fontWeight: '600' },
  // High-contrast white variants used when the card switches to the dark
  // green Family Plan background — improves WCAG contrast for senior users.
  planNamePaid: { color: Colors.surface },
  planSubPaid: { color: Colors.surface, opacity: 0.95 },

  infoCard: {
    marginTop: 14,
    backgroundColor: Colors.surface,
    borderRadius: 14, padding: 16,
    borderWidth: 1, borderColor: Colors.border,
  },
  infoLabel: { fontSize: 12, fontWeight: '800', color: Colors.textTertiary, textTransform: 'uppercase', letterSpacing: 0.5 },
  infoValue: { marginTop: 6, fontSize: 18, fontWeight: '800', color: Colors.textPrimary },
  warnNote: { marginTop: 10, fontSize: 13, color: Colors.warning, fontWeight: '600', lineHeight: 18 },

  primaryBtn: {
    backgroundColor: Colors.primary,
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: 'center',
  },
  primaryBtnText: { color: Colors.surface, fontSize: 16, fontWeight: '800' },
  dangerBtn: {
    backgroundColor: Colors.errorBg || '#FEE2E2',
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: 'center',
    borderWidth: 1, borderColor: Colors.error,
  },
  dangerBtnText: { color: Colors.error, fontSize: 16, fontWeight: '800' },

  portalBtn: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: 14, paddingVertical: 14, paddingHorizontal: 16,
    borderWidth: 1, borderColor: Colors.border,
  },
  portalBtnTitle: { fontSize: 15, fontWeight: '800', color: Colors.textPrimary },
  portalBtnSub: { marginTop: 2, fontSize: 12.5, color: Colors.textSecondary, lineHeight: 17 },

  fineprint: {
    marginTop: 24,
    fontSize: 12, color: Colors.textTertiary, textAlign: 'center', lineHeight: 18,
  },
  errorCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.errorBg || '#FEE2E2',
    borderRadius: 14,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: Colors.error,
  },
  errorTitle: { fontSize: 14, fontWeight: '800', color: Colors.error },
  errorSub: { marginTop: 2, fontSize: 12, color: Colors.textSecondary, lineHeight: 16 },
  retryBtn: {
    backgroundColor: Colors.error,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    marginLeft: 10,
  },
  retryBtnText: { color: '#fff', fontSize: 13, fontWeight: '800' },
  unknownPlanCard: {
    backgroundColor: Colors.surface,
    borderRadius: 18, padding: 20,
    alignItems: 'center',
    borderWidth: 1, borderColor: Colors.border,
  },
});
