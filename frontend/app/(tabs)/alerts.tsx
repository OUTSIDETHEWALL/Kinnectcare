import { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl, ActivityIndicator } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Icon } from '../../src/Icon';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors } from '../../src/theme';
import { api, Alert } from '../../src/api';

function alertIcon(type: string) {
  if (type === 'missed_checkin') return 'time-outline';
  if (type === 'low_battery') return 'battery-dead-outline';
  if (type === 'medication') return 'medical-outline';
  if (type === 'sos') return 'warning-outline';
  return 'alert-circle-outline';
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
                {a.type === 'sos' && a.latitude != null && a.longitude != null && (
                  <Text style={styles.coordsLine}>📍 {a.latitude.toFixed(4)}°, {a.longitude.toFixed(4)}°</Text>
                )}
                <Text style={styles.alertMeta}>{a.member_name} · {new Date(a.created_at).toLocaleString()}</Text>
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
  coordsLine: { fontSize: 13, color: Colors.error, fontWeight: '700', marginTop: 6 },
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
