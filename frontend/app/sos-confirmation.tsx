import { useEffect, useRef, useSyncExternalStore } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Animated, Platform, ScrollView,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors } from '../src/theme';
import { EmergencyCallAction } from '../src/components/EmergencyCallAction';
import { clearSosSendReceipt, readSosSendReceipt, sosAccountScope, subscribeSosSendReceipt } from '../src/sosSendReceipt';
import { useAuth } from '../src/AuthContext';

/**
 * A route/deep link is not evidence. Only this process's matching server receipt
 * confirms recording, not push delivery, GPS freshness, or an emergency call.
 */
export default function SOSConfirmation() {
  const router = useRouter();
  const { receiptId } = useLocalSearchParams<{ receiptId?: string }>();
  const { user } = useAuth();
  const scope = sosAccountScope(user);
  const receipt = useSyncExternalStore(
    subscribeSosSendReceipt,
    () => readSosSendReceipt(receiptId, scope),
    () => null,
  );
  const scale = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.spring(scale, {
      toValue: 1, friction: 5, tension: 80, useNativeDriver: true,
    }).start();
  }, [scale]);
  useEffect(() => () => {
    if (typeof receiptId === 'string') clearSosSendReceipt(receiptId);
  }, [receiptId, scope]);
  const locationLabel = !receipt ? 'Location status unknown' : receipt.location === 'unavailable' ? 'Location unavailable'
    : receipt.location === 'gps' ? 'GPS location recorded'
      : receipt.location === 'last-known' ? 'Last-known location recorded' : 'Location coordinates recorded';
  const locationDetail = !receipt || receipt.location === 'unavailable'
    ? 'No coordinates were confirmed with this alert.'
    : receipt.capturedAt
      ? `Captured ${new Date(receipt.capturedAt).toLocaleString()}`
        + (receipt.accuracy !== undefined ? ` · accuracy ±${Math.round(receipt.accuracy)} m` : ' · accuracy unavailable')
      : 'Capture time and freshness are not confirmed. See emergency details.';

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      {/* Issue 1 — obvious "Back to Dashboard" control at the very top of the page.
          Replaces the previous nav-header breadcrumb which looked like static text. */}
      <View style={styles.backRow}>
        <TouchableOpacity
          testID="sos-back-dashboard"
          onPress={() => router.replace('/(tabs)/dashboard')}
          activeOpacity={0.85}
          style={styles.backBtn}
        >
          <Text style={styles.backBtnText}>← Back to Dashboard</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Animated.View style={[styles.iconWrap, { transform: [{ scale }] }]}>
          <Text style={styles.iconText}>🆘</Text>
        </Animated.View>

        <Text testID="sos-title" style={styles.title}>
          {receipt ? 'SOS Alert Recorded' : 'SOS Status Not Confirmed'}
        </Text>
        <Text style={styles.subtitle}>
          {receipt
            ? 'The server recorded your SOS. Notification delivery and emergency calls are not confirmed.'
            : 'No matching server receipt is available on this screen. Check Alerts or call 911 if you need help.'}
        </Text>

        <View style={styles.statusList}>
          <StatusRow
            icon="🔔"
            label={receipt?.notificationRequested ? 'Family notification requested' : 'Family notification status unknown'}
            sub="Delivery to family devices is not confirmed."
            pending
          />
          <StatusRow
            icon="📍"
            label={locationLabel}
            sub={locationDetail}
            pending={!receipt || receipt.location === 'unavailable'}
          />
          <StatusRow
            icon="🕐"
            label={receipt?.recordedAt ? 'Server receipt time' : 'Receipt time unavailable'}
            sub={receipt?.recordedAt ? new Date(receipt.recordedAt).toLocaleString() : 'No confirmed timestamp on this screen.'}
            pending={!receipt?.recordedAt}
          />
          <StatusRow
            icon="👀"
            label="Family response not confirmed here"
            sub="Check Alerts for acknowledgments and resolution."
            pending
          />
        </View>
      </ScrollView>

      <View style={styles.bottom}>
        <EmergencyCallAction key={`${scope}:${receiptId}`} initiallyOpened={receipt?.dialerOpened} />
        <TouchableOpacity
          testID="sos-done"
          onPress={() => router.replace('/(tabs)/dashboard')}
          activeOpacity={0.85}
          style={styles.cta}
        >
          <Text style={styles.ctaText}>Done</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

function StatusRow({
  icon, label, sub, pending = false,
}: { icon: string; label: string; sub: string; pending?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowIcon}>{icon}</Text>
      <View style={{ flex: 1 }}>
        <Text style={[styles.rowLabel, pending && styles.rowLabelPending]}>
          {label}
        </Text>
        <Text style={styles.rowSub}>{sub}</Text>
      </View>
      <Text style={[styles.rowCheck, pending && styles.rowCheckPending]}>
        {pending ? '…' : '✓'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: {
    // justifyContent removed — backRow + content(flex:1) + bottom handles spacing naturally.
    flex: 1, backgroundColor: Colors.background,
  },
  backRow: {
    paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4,
  },
  backBtn: {
    height: 52, backgroundColor: Colors.primary, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 20,
  },
  backBtnText: {
    color: '#FFFFFF', fontSize: 16, fontWeight: '800', letterSpacing: 0.2,
  },
  content: {
    flexGrow: 1, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 28, paddingVertical: 12,
  },
  iconWrap: {
    width: 130, height: 130, borderRadius: 65, backgroundColor: Colors.sos,
    alignItems: 'center', justifyContent: 'center',
    boxShadow: '0px 12px 24px rgba(220,38,38,0.35)' as any,
    ...Platform.select({ android: { elevation: 10 } }),
  },
  iconText: { fontSize: 64 },
  title: {
    fontSize: 26, fontWeight: '800', color: Colors.textPrimary,
    marginTop: 24, textAlign: 'center',
  },
  subtitle: {
    fontSize: 14, color: Colors.textSecondary, marginTop: 8,
    textAlign: 'center', lineHeight: 21,
  },
  statusList: {
    alignSelf: 'stretch', backgroundColor: Colors.surface, borderRadius: 16,
    borderWidth: 1, borderColor: Colors.border, padding: 8, marginTop: 20,
  },
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 12, paddingHorizontal: 8, gap: 12,
  },
  rowIcon: { fontSize: 22, width: 28, textAlign: 'center' },
  rowLabel: { fontSize: 14, fontWeight: '700', color: Colors.textPrimary },
  rowLabelPending: { color: Colors.textSecondary },
  rowSub: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  rowCheck: { fontSize: 17, color: Colors.primary, fontWeight: '800' },
  rowCheckPending: { color: Colors.textTertiary, fontWeight: '400' },
  bottom: { paddingHorizontal: 24, paddingBottom: 24, gap: 12 },
  cta: {
    height: 56, backgroundColor: Colors.primary, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
  },
  ctaText: { color: Colors.surface, fontSize: 16, fontWeight: '800' },
});
