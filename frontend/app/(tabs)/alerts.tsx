import { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl, ActivityIndicator, Linking, Platform, Alert as RNAlert } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Icon } from '../../src/Icon';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors } from '../../src/theme';
import { api, Alert } from '../../src/api';
import { formatRelativeLocal } from '../../src/timeFormat';
import MemberMap from '../../src/MemberMap';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from '../../src/AuthContext';

function alertIcon(type: string) {
  if (type === 'missed_checkin') return 'time-outline';
  if (type === 'low_battery') return 'battery-dead-outline';
  if (type === 'medication') return 'medical-outline';
  if (type === 'sos') return 'warning-outline';
  return 'alert-circle-outline';
}

// SOS alerts get an embedded mini-map. Medication / routine / missed-checkin
// alerts do NOT — they're not location-sensitive.
function shouldShowMap(a: Alert): boolean {
  return a.type === 'sos' && typeof a.latitude === 'number' && typeof a.longitude === 'number';
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
  const { user } = useAuth();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const load = async () => {
    try {
      const r = await api.get('/alerts');
      const fresh = r.data as Alert[];
      setAlerts(fresh);
      // Clear any previous error only once the fetch succeeds — keeps the error
      // card visible during a retry rather than flashing "All clear!" while the
      // request is in flight.
      setLoadError(false);
      // Persist the fresh list so it survives a force-kill restart.
      if (user?.id) {
        try {
          await AsyncStorage.setItem(`@kinnship/alerts_v1_${user.id}`, JSON.stringify(fresh));
        } catch (_e) {}
      }
    } catch (_e) {
      // On failure preserve the existing state (cache or last successful fetch)
      // rather than blanking the list — the user should see stale alerts
      // rather than a misleading empty screen.
      setLoadError(true);
    }
  };

  useFocusEffect(useCallback(() => {
    let cancelled = false;

    const hydrateAndRefresh = async () => {
      // Step 1 — Read the AsyncStorage cache synchronously before starting the
      // network fetch.  If a cached list exists, populate state immediately and
      // dismiss the full-screen spinner so caregivers see their alerts right
      // away after a force-kill restart, even while the network request is
      // still in flight.
      let hasCached = false;
      if (user?.id) {
        try {
          const cached = await AsyncStorage.getItem(`@kinnship/alerts_v1_${user.id}`);
          if (cached && !cancelled) {
            setAlerts(JSON.parse(cached) as Alert[]);
            hasCached = true;
          }
        } catch (_e) {}
      }

      // Step 2 — Only keep the full-screen spinner up when there is genuinely
      // nothing to show yet (no cache, no prior in-memory data).  When cached
      // data exists, the spinner is dismissed so the list is visible while the
      // background refresh completes.
      if (!hasCached && !cancelled) {
        setLoading(true);
      } else if (!cancelled) {
        setLoading(false);
      }

      // Step 3 — Network refresh (non-blocking when cache exists).
      await load();
      if (!cancelled) setLoading(false);
    };

    hydrateAndRefresh();

    // Poll briefly after focus to catch in-flight SOS background fanout
    // and other late-arriving alerts (Bug 3 — SOS not appearing in Alerts).
    // The /sos endpoint inserts the alert row synchronously BEFORE the
    // push fanout, so within ~1s of dialer dismiss the row exists.
    const t1 = setTimeout(() => { if (!cancelled) load(); }, 1500);
    const t2 = setTimeout(() => { if (!cancelled) load(); }, 4000);
    return () => {
      cancelled = true;
      clearTimeout(t1);
      clearTimeout(t2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]));

  const ack = async (id: string) => {
    try {
      await api.post(`/alerts/${id}/ack`);
      load();
    } catch (_e) {
      RNAlert.alert('Could not acknowledge', 'Please check your connection and try again.');
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  // Clear All — deletes every alert in the user's family group via
  // the new DELETE /api/alerts endpoint. Confirmed via a native
  // Alert.alert so an accidental tap can't wipe the history (these
  // are safety-relevant records the user may want to keep).
  const clearAll = () => {
    if (alerts.length === 0) return;
    RNAlert.alert(
      'Clear all alerts?',
      `This will permanently delete all ${alerts.length} alert${alerts.length === 1 ? '' : 's'} in your family group — including SOS, medication and check-in history. This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear all',
          style: 'destructive',
          onPress: async () => {
            try {
              await api.delete('/alerts');
              setAlerts([]);
              // Invalidate the cache so a force-kill restart after a clear-all
              // doesn't restore stale alerts from a prior session.
              if (user?.id) {
                try {
                  await AsyncStorage.removeItem(`@kinnship/alerts_v1_${user.id}`);
                } catch (_e) {}
              }
            } catch (_e) {
              RNAlert.alert('Could not clear', 'Please check your connection and try again.');
            }
          },
        },
      ],
    );
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
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Alerts</Text>
          <Text style={styles.sub}>{active.length} active · {cleared.length} cleared</Text>
        </View>
        {alerts.length > 0 && (
          <TouchableOpacity
            testID="alerts-clear-all"
            style={styles.clearAllBtn}
            onPress={clearAll}
            activeOpacity={0.7}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityLabel="Clear all alerts"
          >
            <Icon name="trash-outline" size={16} color={Colors.error} />
            <Text style={styles.clearAllText}>Clear All</Text>
          </TouchableOpacity>
        )}
      </View>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
      >
        {/* When a fetch fails but we have cached/previous alerts, show a compact
            offline banner so the caregiver can see the cached list rather than
            a blank screen.  Only show the full error card when we have no data
            at all — i.e. first launch with no connectivity and no prior cache. */}
        {loadError && alerts.length > 0 && (
          <View style={styles.offlineBanner}>
            <Icon name="cloud-offline-outline" size={18} color={Colors.error} />
            <Text style={styles.offlineBannerText}>Showing cached alerts · couldn't refresh</Text>
            <TouchableOpacity
              testID="alerts-retry"
              onPress={load}
              activeOpacity={0.8}
              style={styles.offlineRetryBtn}
            >
              <Text style={styles.offlineRetryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        )}

        {loadError && alerts.length === 0 && (
          <View style={styles.errorCard}>
            <Icon name="cloud-offline-outline" size={40} color={Colors.error} />
            <Text style={styles.errorTitle}>Couldn't load alerts.</Text>
            <Text style={styles.errorMsg}>Please check your connection.</Text>
            <TouchableOpacity
              testID="alerts-retry"
              onPress={load}
              activeOpacity={0.8}
              style={styles.retryBtn}
            >
              <Text style={styles.retryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        )}

        {!loadError && active.length === 0 && (
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
                        🆘 SOS location · {(a.latitude as number).toFixed(4)}°, {(a.longitude as number).toFixed(4)}° · Tap for directions
                      </Text>
                    </View>
                  </TouchableOpacity>
                )}
                <Text style={styles.alertMeta}>{a.member_name} · {formatRelativeLocal(a.created_at)}</Text>
                <View style={styles.actionRow}>
                  {a.type === 'low_battery' && !!a.member_phone && (
                    <TouchableOpacity
                      testID={`alert-call-${a.id}`}
                      onPress={() => Linking.openURL(`tel:${a.member_phone}`)}
                      style={[styles.callBtn, { borderColor: t.fg, backgroundColor: t.bg }]}
                      accessibilityLabel={`Call ${a.member_name}`}
                      accessibilityRole="button"
                    >
                      <Icon name="call-outline" size={14} color={t.fg} />
                      <Text style={[styles.callText, { color: t.fg }]}>Call {a.member_name.split(' ')[0]}</Text>
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity
                    testID={`alert-ack-${a.id}`}
                    onPress={() => ack(a.id)}
                    style={[styles.ackBtn, { borderColor: t.fg }]}
                  >
                    <Text style={[styles.ackText, { color: t.fg }]}>Acknowledge</Text>
                  </TouchableOpacity>
                </View>
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
  header: { paddingHorizontal: 24, paddingTop: 12, paddingBottom: 12, flexDirection: 'row', alignItems: 'flex-end' },
  clearAllBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: Colors.errorBg || '#FEE2E2',
    borderWidth: 1,
    borderColor: Colors.error,
  },
  clearAllText: { color: Colors.error, fontSize: 13, fontWeight: '800' },
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
  actionRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  callBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1,
  },
  callText: { fontWeight: '700', fontSize: 13 },
  ackBtn: { alignSelf: 'flex-start', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, backgroundColor: Colors.surface },
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
  errorCard: {
    alignItems: 'center', marginTop: 60, marginHorizontal: 32,
    backgroundColor: Colors.errorBg || '#FEE2E2', borderRadius: 20,
    padding: 28, borderWidth: 1, borderColor: Colors.error,
  },
  errorTitle: { fontSize: 18, fontWeight: '700', color: Colors.error, marginTop: 14, textAlign: 'center' },
  errorMsg: { fontSize: 14, color: Colors.textSecondary, marginTop: 6, textAlign: 'center' },
  retryBtn: {
    marginTop: 18, paddingHorizontal: 28, paddingVertical: 12,
    backgroundColor: Colors.error, borderRadius: 999,
  },
  retryText: { color: Colors.surface, fontWeight: '700', fontSize: 15 },
  // Compact offline banner shown when a refresh fails but cached alerts exist.
  // Keeps the list visible rather than replacing it with the full error card.
  offlineBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 24,
    marginTop: 10,
    marginBottom: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: Colors.errorBg || '#FEE2E2',
    borderWidth: 1,
    borderColor: Colors.error,
  },
  offlineBannerText: { flex: 1, fontSize: 13, color: Colors.error, fontWeight: '600' },
  offlineRetryBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: Colors.error,
    borderRadius: 999,
  },
  offlineRetryText: { color: Colors.surface, fontWeight: '700', fontSize: 12 },
});
