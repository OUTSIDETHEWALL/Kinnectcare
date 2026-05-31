import { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl, ActivityIndicator, Linking, Platform } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Icon } from '../../src/Icon';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors } from '../../src/theme';
import { api, Alert } from '../../src/api';
import { formatRelativeLocal } from '../../src/timeFormat';
import MemberMap from '../../src/MemberMap';

function alertIcon(type: string) {
  if (type === 'missed_checkin') return 'time-outline';
  if (type === 'low_battery') return 'battery-dead-outline';
  if (type === 'medication') return 'medical-outline';
  if (type === 'sos') return 'warning-outline';
  return 'alert-circle-outline';
}

// SOS alerts (including fall-detection ones — they roll through /api/sos
// so they're stored with type='sos' + a `fall_detected` flag in the
// message) get an embedded mini-map. Medication / routine / missed-checkin
// alerts do NOT — they're not location-sensitive.
function shouldShowMap(a: Alert): boolean {
  return a.type === 'sos' && typeof a.latitude === 'number' && typeof a.longitude === 'number';
}

// Heuristic to tell fall-detection apart from manual SOS for label only.
// Backend stores fall events as type='sos' with "Fall detected" prefix in
// the message; we just check the message string.
function isFallAlert(a: Alert): boolean {
  return a.type === 'sos' && /fall detected/i.test(a.message || '');
}

// Open the device's native maps app for turn-by-turn navigation.
function openInMaps(lat: number, lon: number, label: string) {
  const q = `${lat},${lon}`;
  const url = Platform.select({
    ios: `https://maps.apple.com/?q=${encodeURIComponent(label)}&ll=${q}`,
    android: `geo:${q}?q=${q}(${encodeURIComponent(label)})`,
    default: `https://www.google.com/maps/search/?api=1&query=${q}`,
  }) as string;
  // Fallback to Google Maps web URL if the native scheme can't be opened.
  Linking.openURL(url).catch(() => {
    Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${q}`);
  });
}

function severityTheme(sev: string) {
  if (sev === 'critical') return { bg: Colors.errorBg, fg: Colors.error };
  if (sev === 'warning') return { bg: Colors.warningBg, fg: Colors.warning };
  return { bg: Colors.tertiary, fg: Colors.primary };
}

export default function Alerts() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    try {
      const r = await api.get('/alerts');
      setAlerts(r.data);
    } catch (_e) {}
  };

  useFocusEffect(useCallback(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
    // Poll briefly after focus to catch in-flight SOS background fanout
    // and other late-arriving alerts (Bug 3 — SOS not appearing in Alerts).
    // The /sos endpoint inserts the alert row synchronously BEFORE the
    // push fanout, so within ~1s of dialer dismiss the row exists.
    const t1 = setTimeout(() => { load(); }, 1500);
    const t2 = setTimeout(() => { load(); }, 4000);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []));

  const ack = async (id: string) => {
    await api.post(`/alerts/${id}/ack`).catch(() => {});
    load();
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator color={Colors.primary} size="large" />
        </View>
      </SafeAreaView>
    );
  }

  const active = alerts.filter(a => !a.acknowledged);
  const cleared = alerts.filter(a => a.acknowledged);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>Alerts</Text>
        <Text style={styles.sub}>{active.length} active · {cleared.length} cleared</Text>
      </View>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
      >
        {active.length === 0 && (
          <View style={styles.empty}>
            <Icon name="checkmark-circle" size={48} color={Colors.success} />
            <Text style={styles.emptyTitle}>All clear!</Text>
            <Text style={styles.emptyMsg}>No active alerts right now.</Text>
          </View>
        )}

        {active.length > 0 && <Text style={styles.section}>Active</Text>}
        {active.map(a => {
          const t = severityTheme(a.severity);
          return (
            <View key={a.id} testID={`alert-${a.id}`} style={[styles.alertCard, { backgroundColor: t.bg }]}>
              <View style={[styles.iconBubble, { backgroundColor: Colors.surface }]}>
                <Icon name={alertIcon(a.type) as any} size={22} color={t.fg} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.alertTitle, { color: t.fg }]}>{a.title}</Text>
                <Text style={styles.alertMsg}>{a.message}</Text>
                {shouldShowMap(a) && (
                  <TouchableOpacity
                    testID={`alert-map-${a.id}`}
                    style={styles.mapTouch}
                    onPress={() => openInMaps(a.latitude as number, a.longitude as number, a.member_name)}
                    activeOpacity={0.85}
                    accessibilityRole="button"
                    accessibilityLabel={`Open ${a.member_name}'s location in Maps`}
                  >
                    <MemberMap
                      latitude={a.latitude as number}
                      longitude={a.longitude as number}
                      memberName={a.member_name}
                      locationName={a.title}
                      height={170}
                    />
                    <View style={styles.mapHint}>
                      <Text style={styles.mapHintText}>
                        {isFallAlert(a) ? '🚨 Fall location' : '🆘 SOS location'} · {(a.latitude as number).toFixed(4)}°, {(a.longitude as number).toFixed(4)}° · Tap for directions
                      </Text>
                    </View>
                  </TouchableOpacity>
                )}
                <Text style={styles.alertMeta}>{a.member_name} · {formatRelativeLocal(a.created_at)}</Text>
                <TouchableOpacity
                  testID={`alert-ack-${a.id}`}
                  onPress={() => ack(a.id)}
                  style={[styles.ackBtn, { borderColor: t.fg }]}
                >
                  <Text style={[styles.ackText, { color: t.fg }]}>Acknowledge</Text>
                </TouchableOpacity>
              </View>
            </View>
          );
        })}

        {cleared.length > 0 && <Text style={styles.section}>Cleared</Text>}
        {cleared.slice(0, 10).map(a => (
          <View key={a.id} style={styles.clearedCard}>
            <Icon name="checkmark-circle" size={18} color={Colors.success} />
            <View style={{ flex: 1, marginLeft: 10 }}>
              <Text style={styles.clearedTitle}>{a.title}</Text>
              <Text style={styles.clearedMsg}>{a.member_name}</Text>
            </View>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  header: { paddingHorizontal: 24, paddingTop: 12, paddingBottom: 12 },
  title: { fontSize: 28, fontWeight: '800', color: Colors.textPrimary },
  sub: { fontSize: 14, color: Colors.textTertiary, marginTop: 4 },
  section: { fontSize: 13, fontWeight: '700', color: Colors.textTertiary, marginHorizontal: 24, marginTop: 14, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.6 },
  alertCard: {
    marginHorizontal: 24, marginTop: 10, padding: 16, borderRadius: 18,
    flexDirection: 'row', alignItems: 'flex-start',
  },
  iconBubble: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  alertTitle: { fontSize: 16, fontWeight: '700' },
  alertMsg: { fontSize: 14, color: Colors.textSecondary, marginTop: 4, lineHeight: 20 },
  mapTouch: { marginTop: 10, borderRadius: 14, overflow: 'hidden' },
  mapHint: {
    backgroundColor: 'rgba(27, 94, 53, 0.92)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginTop: -28,            // overlay onto bottom of map
    marginHorizontal: 8,
    marginBottom: 2,
    borderRadius: 8,
    alignSelf: 'flex-start',
  },
  mapHintText: { color: '#FFFFFF', fontSize: 11, fontWeight: '700' },
  alertMeta: { fontSize: 12, color: Colors.textTertiary, marginTop: 6 },
  ackBtn: { marginTop: 10, alignSelf: 'flex-start', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, backgroundColor: Colors.surface },
  ackText: { fontWeight: '700', fontSize: 13 },
  clearedCard: {
    marginHorizontal: 24, marginTop: 8, padding: 14, borderRadius: 14,
    flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border,
  },
  clearedTitle: { fontSize: 14, fontWeight: '600', color: Colors.textSecondary },
  clearedMsg: { fontSize: 12, color: Colors.textTertiary, marginTop: 2 },
  empty: { alignItems: 'center', marginTop: 60, paddingHorizontal: 32 },
  emptyTitle: { fontSize: 20, fontWeight: '700', color: Colors.textPrimary, marginTop: 12 },
  emptyMsg: { fontSize: 15, color: Colors.textSecondary, marginTop: 6, textAlign: 'center' },
});
