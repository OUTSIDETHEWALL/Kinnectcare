/**
 * Alert detail screen — destination for notification-tap deep-links.
 *
 * Fix #3 of the v1.2 beta sprint: when a SOS / fall / missed-checkin /
 * medication-escalation push is tapped, the user lands HERE (after the
 * PIN gate clears in RootNav) instead of the generic alerts list.  The
 * notification's context — WHICH alert fired — is preserved across the
 * cold-start + auth + PIN unlock so the user sees the exact incident
 * they were trying to respond to.
 *
 * Renders type-appropriate primary actions:
 *   SOS / fall_detected        → 📞 Call <member> · 📍 Directions · ✓ Mark resolved
 *   missed_checkin             → 📞 Call <member> · ✓ Acknowledge
 *   medication / family_alert  → uses /(modals)/acknowledge instead
 *                                (this screen only ever sees critical /
 *                                location-bearing alerts)
 *
 * If the alert is no longer in the user's family-group (already
 * resolved + auto-pruned, or accessed cross-tenant), we show a
 * friendly "Alert no longer available" empty state and bounce back
 * to the dashboard after a 2s grace.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Linking,
  Platform,
  Alert as RNAlert,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Icon } from '../../src/Icon';
import { Colors } from '../../src/theme';
import { api, Alert } from '../../src/api';
import MemberMap from '../../src/MemberMap';
import { formatRelativeLocal } from '../../src/timeFormat';

function severityTheme(sev: string) {
  if (sev === 'critical') return { bg: Colors.errorBg, fg: Colors.error };
  if (sev === 'warning') return { bg: Colors.warningBg, fg: Colors.warning };
  return { bg: Colors.tertiary, fg: Colors.primary };
}

function alertIcon(type: string): string {
  if (type === 'sos') return 'warning';
  if (type === 'missed_checkin') return 'time-outline';
  if (type === 'medication') return 'medical-outline';
  return 'alert-circle';
}

function isFallAlert(a: Alert): boolean {
  return a.type === 'sos' && /fall detected/i.test(a.message || '');
}

function openMaps(lat: number, lon: number, label: string) {
  const q = `${lat},${lon}`;
  const url = Platform.select({
    ios: `https://maps.apple.com/?q=${encodeURIComponent(label)}&ll=${q}`,
    android: `geo:${q}?q=${q}(${encodeURIComponent(label)})`,
    default: `https://www.google.com/maps/search/?api=1&query=${q}`,
  }) as string;
  Linking.openURL(url).catch(() => {
    Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${q}`);
  });
}

export default function AlertDetail() {
  const params = useLocalSearchParams<{ id?: string; member_phone?: string }>();
  const router = useRouter();
  const [alert, setAlert] = useState<Alert | null>(null);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState(false);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    if (!params.id) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    try {
      // GET /api/alerts returns the full list — no single-doc endpoint
      // today.  Cheap enough since the list is bounded by retention.
      const res = await api.get('/alerts');
      const list: Alert[] = res.data || [];
      const found = list.find((a) => a.id === params.id) || null;
      if (!found) {
        setNotFound(true);
      } else {
        setAlert(found);
      }
    } catch (_e) {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [params.id]);

  useEffect(() => {
    load();
  }, [load]);

  // If the alert is no longer reachable (resolved + pruned, or never
  // existed) bounce to the alerts tab after a beat so the user can
  // still see SOMETHING — never a dead end.
  useEffect(() => {
    if (!notFound) return;
    const t = setTimeout(() => router.replace('/(tabs)/alerts'), 1800);
    return () => clearTimeout(t);
  }, [notFound, router]);

  const resolveAlert = useCallback(async () => {
    if (!alert || resolving) return;
    setResolving(true);
    try {
      await api.post(`/alerts/${alert.id}/ack`);
      // Fix #4 of v1.2 beta: if this was the SOS that triggered the
      // high-frequency GPS boost, end it now so the device returns
      // to battery-friendly cadence.  Safe no-op for non-SOS alerts
      // (endSosBoost only restarts the bg task — if the boost was
      // never active, the cadence stays at normal).
      try {
        const bg = await import('../../src/backgroundLocation');
        await bg.endSosBoost();
      } catch (_e) {}
      router.replace('/(tabs)/alerts');
    } catch (e: any) {
      RNAlert.alert(
        'Could not mark as resolved',
        e?.response?.data?.detail || 'Please try again from the alerts list.',
        [{ text: 'OK' }],
      );
      setResolving(false);
    }
  }, [alert, resolving, router]);

  if (loading) {
    return (
      <SafeAreaView style={styles.center} edges={['top', 'bottom']}>
        <ActivityIndicator size="large" color={Colors.primary} />
      </SafeAreaView>
    );
  }

  if (notFound || !alert) {
    return (
      <SafeAreaView style={styles.center} edges={['top', 'bottom']}>
        <Icon name="checkmark-circle-outline" size={64} color={Colors.success} />
        <Text style={styles.notFoundTitle}>Alert no longer active</Text>
        <Text style={styles.notFoundBody}>
          This alert has been resolved or is no longer available.
          Taking you to the alerts list…
        </Text>
      </SafeAreaView>
    );
  }

  const sev = severityTheme(alert.severity || 'info');
  const showMap =
    alert.type === 'sos' &&
    typeof alert.latitude === 'number' &&
    typeof alert.longitude === 'number';
  const fall = isFallAlert(alert);
  const phone = (params.member_phone as string | undefined) || '';
  const memberLabel = alert.member_name || 'Family member';

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
      <View style={styles.headerBar}>
        <TouchableOpacity
          onPress={() => router.replace('/(tabs)/alerts')}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="Back to alerts list"
        >
          <Icon name="chevron-back" size={26} color={Colors.text} />
          <Text style={styles.backText}>Alerts</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <View style={[styles.severityChip, { backgroundColor: sev.bg }]}>
          <Icon name={alertIcon(alert.type)} size={18} color={sev.fg} />
          <Text style={[styles.severityText, { color: sev.fg }]}>
            {fall ? 'Fall detected' : (alert.type || '').toUpperCase().replace(/_/g, ' ')}
          </Text>
        </View>

        <Text style={styles.title}>{alert.title}</Text>
        <Text style={styles.timestamp}>
          {formatRelativeLocal(alert.created_at)}
        </Text>

        <Text style={styles.message}>{alert.message}</Text>

        {showMap && (
          <View style={styles.mapCard}>
            <MemberMap
              latitude={alert.latitude as number}
              longitude={alert.longitude as number}
              memberName={memberLabel}
              height={220}
            />
            <TouchableOpacity
              style={styles.mapsBtn}
              onPress={() =>
                openMaps(alert.latitude as number, alert.longitude as number, memberLabel)
              }
            >
              <Icon name="navigate" size={20} color={Colors.surface} />
              <Text style={styles.mapsBtnText}>Open in Maps</Text>
            </TouchableOpacity>
          </View>
        )}

        {!!phone && (
          <TouchableOpacity
            style={styles.callBtn}
            onPress={() => Linking.openURL(`tel:${phone}`).catch(() => {})}
          >
            <Icon name="call" size={24} color={Colors.surface} />
            <Text style={styles.callBtnText}>Call {memberLabel}</Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity
          style={[styles.resolveBtn, resolving && styles.btnDisabled]}
          onPress={resolveAlert}
          disabled={resolving}
        >
          {resolving ? (
            <ActivityIndicator color={Colors.surface} />
          ) : (
            <>
              <Icon name="checkmark-circle" size={24} color={Colors.surface} />
              <Text style={styles.resolveBtnText}>Mark as resolved</Text>
            </>
          )}
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  center: {
    flex: 1,
    backgroundColor: Colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  headerBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingTop: 8 },
  backBtn: { flexDirection: 'row', alignItems: 'center', padding: 8 },
  backText: { fontSize: 17, color: Colors.text, marginLeft: 2 },
  body: { paddingHorizontal: 20, paddingBottom: 40, paddingTop: 8 },
  severityChip: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    marginBottom: 12,
    gap: 6,
  },
  severityText: { fontSize: 13, fontWeight: '700', letterSpacing: 0.4 },
  title: { fontSize: 28, fontWeight: '800', color: Colors.text, lineHeight: 34 },
  timestamp: { fontSize: 14, color: Colors.textSecondary, marginTop: 6 },
  message: { fontSize: 17, color: Colors.text, marginTop: 16, lineHeight: 25 },
  mapCard: { marginTop: 20, borderRadius: 14, overflow: 'hidden' },
  mapsBtn: {
    marginTop: 10,
    height: 50,
    backgroundColor: Colors.primary,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  mapsBtnText: { color: Colors.surface, fontSize: 16, fontWeight: '700' },
  callBtn: {
    marginTop: 18,
    height: 60,
    backgroundColor: Colors.success,
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  callBtnText: { color: Colors.surface, fontSize: 18, fontWeight: '700' },
  resolveBtn: {
    marginTop: 12,
    height: 60,
    backgroundColor: Colors.primary,
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  resolveBtnText: { color: Colors.surface, fontSize: 18, fontWeight: '700' },
  btnDisabled: { opacity: 0.6 },
  notFoundTitle: { fontSize: 20, fontWeight: '700', color: Colors.text, marginTop: 12 },
  notFoundBody: { fontSize: 15, color: Colors.textSecondary, textAlign: 'center', marginTop: 8, lineHeight: 22 },
});
