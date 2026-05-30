import { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Image,
  RefreshControl, Alert as RNAlert, Linking, ActivityIndicator, Modal, Platform,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { Icon } from '../../src/Icon';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import { Colors, StatusColor } from '../../src/theme';
import { api, Member, MemberSummary, getBillingStatus, BillingStatus } from '../../src/api';
import { useAuth } from '../../src/AuthContext';

export default function Dashboard() {
  const router = useRouter();
  const { user, logout } = useAuth();
  const [members, setMembers] = useState<Member[]>([]);
  const [summary, setSummary] = useState<MemberSummary[]>([]);
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // SOS confirmation modal — purposefully in-app (NOT Alert.alert) so:
  //   1. Cancel responds instantly with no system animation lag
  //   2. The dialer launch fires from a clean synchronous event handler,
  //      avoiding the Android activity-launch race that occurred when an
  //      Alert.alert's dismiss animation overlapped with Linking.openURL
  //   3. The styling matches the rest of the app (large finger-friendly
  //      buttons for senior users, high-contrast brand colors)
  const [sosConfirmOpen, setSosConfirmOpen] = useState(false);
  // 'idle' | 'dialing' — guards the "Yes, Call 911" button so multiple rapid
  // taps cannot race the Linking.openURL intent (was failing ~1/10 times).
  const [sosDialState, setSosDialState] = useState<'idle' | 'dialing'>('idle');
  // Ref-based mutex — state updates batch async, so a second tap inside the
  // same event loop tick can still see `sosDialState === 'idle'`. The ref is
  // checked synchronously and is bulletproof against double-tap races.
  const sosDialingRef = useRef(false);

  const load = async () => {
    try {
      const [m, s, b] = await Promise.all([
        api.get('/members'),
        api.get('/summary'),
        getBillingStatus().catch(() => null),
      ]);
      setMembers(m.data);
      setSummary(s.data.members || []);
      if (b) setBilling(b);
    } catch (_e) {}
  };

  useFocusEffect(useCallback(() => {
    // Stale-while-revalidate: only show the spinner on the VERY FIRST load
    // (when members is empty). Subsequent tab focuses revalidate silently in
    // the background to avoid the jarring spinner-flash that v6 testers
    // reported as a perceived perf regression.
    setLoading((prev) => members.length === 0 ? true : prev);
    load().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members.length]));

  useEffect(() => {
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted' && members.length > 0) {
          const pos = await Location.getCurrentPositionAsync({});
          await api.put(`/members/${members[0].id}/location`, {
            latitude: pos.coords.latitude, longitude: pos.coords.longitude,
          }).catch(() => {});
        }
      } catch (_e) {}
    })();
  }, [members.length]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  // Step 1 — user tapped the SOS button. Show the in-app confirmation modal.
  // This is intentionally light: no API calls, no GPS request, no permissions.
  // We want the modal to appear in <50ms so Cancel is instantly responsive.
  const triggerSOS = () => {
    setSosConfirmOpen(true);
  };

  // Step 2 — user confirmed in the modal.
  //
  // SOS reliability hardening (was ~1/10 fail rate on v6.2):
  //  • A useRef mutex blocks re-entry across render boundaries — fastest
  //    possible synchronous guard against double-tap and onPress-during-
  //    state-update races.
  //  • We retry Linking.openURL up to 3x with 150ms backoff. Android
  //    occasionally returns failure from the OS intent broker when an
  //    activity transition (e.g. our Modal animation) overlaps the
  //    ACTION_DIAL dispatch — a single retry resolves it nearly always.
  //  • The modal stays open with the button in a "Calling..." disabled
  //    state until the OS confirms the intent went through OR all retries
  //    fail. Closing the modal is the LAST thing we do so the user never
  //    sees a "modal closed but nothing happened" state.
  //  • Background work (GPS, /sos alert, push fan-out) runs in parallel
  //    and never blocks the dialer.
  const confirmSOS = useCallback(async () => {
    // Synchronous mutex — refs are NOT batched like state, so two taps
    // within the same React commit cycle are perfectly serialised.
    if (sosDialingRef.current) return;
    sosDialingRef.current = true;
    setSosDialState('dialing');

    // Kick off background work IMMEDIATELY in parallel — these calls do
    // not block the dialer. Family/SMS fanout, GPS, and the /sos alert
    // are best-effort; if they fail the user is still being dialed to 911.
    (async () => {
      try {
        let lat: number | undefined, lon: number | undefined;
        try {
          const { status } = await Location.requestForegroundPermissionsAsync();
          if (status === 'granted') {
            const pos = await Location.getCurrentPositionAsync({
              accuracy: Location.Accuracy.Balanced,
            });
            lat = pos.coords.latitude;
            lon = pos.coords.longitude;
          }
        } catch (_e) {}
        await api.post('/sos', { latitude: lat, longitude: lon });
        load().catch(() => {});
      } catch (_e) {}
    })();

    // Try the dialer up to 3 times. canOpenURL is intentionally NOT used —
    // some Android OEMs return false for tel: even when the OS will happily
    // launch the dialer, so we just trust openURL + retry.
    let opened = false;
    for (let attempt = 0; attempt < 3 && !opened; attempt++) {
      try {
        await Linking.openURL('tel:911');
        opened = true;
      } catch (_e) {
        if (attempt < 2) {
          // Tiny backoff lets the previous activity transition settle.
          await new Promise((r) => setTimeout(r, 150));
        }
      }
    }

    if (!opened) {
      // True hard failure (e.g. WiFi-only tablet with no dialer app).
      RNAlert.alert(
        '🆘 Call 911',
        "Your phone's dialer couldn't be opened. Please dial 911 manually right now.",
        [{ text: 'OK' }],
      );
    }

    // ALL of these reset operations happen AFTER the dialer succeeds so
    // the modal-close animation can never race the intent dispatch.
    setSosConfirmOpen(false);
    setSosDialState('idle');
    sosDialingRef.current = false;
  }, [load]);

  const quickCheckIn = (m: Member) => {
    // INSTANT: navigate immediately so the confirmation screen renders <1s.
    router.push({ pathname: '/check-in', params: { name: m.name } });
    // Backend work runs in the background.
    (async () => {
      try {
        let lat: number | undefined, lon: number | undefined, name: string | undefined;
        try {
          const { status } = await Location.requestForegroundPermissionsAsync();
          if (status === 'granted') {
            const pos = await Location.getCurrentPositionAsync({
              accuracy: Location.Accuracy.Balanced,
            });
            lat = pos.coords.latitude;
            lon = pos.coords.longitude;
            name = 'Current Location';
          }
        } catch (_e) {}
        await api.post('/checkins', { member_id: m.id, latitude: lat, longitude: lon, location_name: name });
        load().catch(() => {});
      } catch (_e) {
        // Silent failure on the network side; the user already saw the confirmation.
      }
    })();
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

  const seniors = members.filter(m => m.role === 'senior');
  const family = members.filter(m => m.role === 'family');
  const sumOf = (id: string) => summary.find(s => s.member_id === id);
  const totalMedMissed = summary.reduce((a, s) => a + s.medication_missed, 0);
  const totalCheckedIn = summary.filter(s => s.role === 'senior' && s.checked_in_today).length;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 130 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
      >
        <View style={styles.header}>
          <View>
            <Text style={styles.hello}>Hello,</Text>
            <Text style={styles.name}>{user?.full_name?.split(' ')[0] || 'there'} 👋</Text>
          </View>
          <View style={styles.headerActions}>
            <TouchableOpacity testID="dashboard-settings" onPress={() => router.push('/settings')} style={styles.iconBtn}>
              <Icon name="settings" size={20} color={Colors.textSecondary} />
            </TouchableOpacity>
            <TouchableOpacity testID="dashboard-logout" onPress={logout} style={styles.iconBtn}>
              <Icon name="log-out-outline" size={20} color={Colors.textSecondary} />
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.summaryCard}>
          <View style={styles.summaryItem}>
            <Text style={styles.summaryNum}>{members.length}</Text>
            <Text style={styles.summaryLbl}>Members</Text>
          </View>
          <View style={styles.summaryDivider} />
          <View style={styles.summaryItem}>
            <Text style={styles.summaryNum}>{totalCheckedIn}/{seniors.length}</Text>
            <Text style={styles.summaryLbl}>Checked in</Text>
          </View>
          <View style={styles.summaryDivider} />
          <View style={styles.summaryItem}>
            <Text style={[styles.summaryNum, totalMedMissed > 0 && { color: Colors.warning }]}>{totalMedMissed}</Text>
            <Text style={styles.summaryLbl}>Missed meds</Text>
          </View>
        </View>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Your Family</Text>
          <TouchableOpacity testID="add-member-btn" onPress={() => router.push('/add-member')} style={styles.addBtn}>
            <Icon name="add" size={16} color={Colors.primary} />
            <Text style={styles.addBtnText}>Add</Text>
          </TouchableOpacity>
        </View>

        {seniors.length > 0 && <Text style={styles.subSection}>👴 Seniors</Text>}
        {seniors.map(m => (
          <MemberCard key={m.id} member={m} sum={sumOf(m.id)} isSenior
            onPress={() => router.push(`/member/${m.id}`)}
            onCheckIn={() => quickCheckIn(m)}
          />
        ))}

        {family.length > 0 && <Text style={styles.subSection}>👨‍👩‍👧 Family</Text>}
        {family.map(m => (
          <MemberCard key={m.id} member={m} sum={sumOf(m.id)}
            onPress={() => router.push(`/member/${m.id}`)}
            onCheckIn={() => quickCheckIn(m)}
          />
        ))}

        {members.length === 0 && (
          <View style={styles.empty}>
            <Text style={{ fontSize: 36 }}>👨‍👩‍👧</Text>
            <Text style={styles.emptyText}>No family members yet. Tap "Add" to get started.</Text>
          </View>
        )}

        {billing && billing.plan === 'free' && members.length > 0 && (
          <TouchableOpacity
            testID="dashboard-upgrade-banner"
            activeOpacity={0.85}
            onPress={() => router.push('/upgrade')}
            style={styles.upgradeBanner}
          >
            <View style={styles.upgradeIconWrap}>
              <Text style={styles.upgradeIcon}>⭐</Text>
            </View>
            <View style={styles.upgradeTextBlock}>
              <Text style={styles.upgradeTitle} numberOfLines={2}>Upgrade to Family Plan</Text>
              <Text style={styles.upgradeSub} numberOfLines={2}>
                Add unlimited members for <Text style={styles.upgradePrice}>$9.99/mo</Text>
              </Text>
              {typeof billing.members_remaining === 'number' && billing.member_limit !== null ? (
                <Text style={styles.upgradeUsage} numberOfLines={1}>
                  {billing.members_remaining > 0
                    ? `${billing.members_remaining} of ${billing.member_limit} slots left`
                    : `All ${billing.member_limit} free slots used`}
                </Text>
              ) : null}
            </View>
            <View testID="dashboard-upgrade-cta" style={styles.upgradeCta}>
              <Text style={styles.upgradeCtaText}>Upgrade</Text>
            </View>
          </TouchableOpacity>
        )}
      </ScrollView>

      <TouchableOpacity testID="sos-button" onPress={triggerSOS} activeOpacity={0.85} style={styles.sosBtn}>
        <Text style={styles.sosEmoji}>🆘</Text>
        <Text style={styles.sosText}>SOS Emergency</Text>
      </TouchableOpacity>

      {/*
        In-app SOS confirmation modal. Replaces the previous Alert.alert
        approach so the dialer can fire from a clean synchronous event
        handler (no system-alert animation race with Linking.openURL).
        Buttons are oversized (60pt tall) for senior accessibility.
      */}
      <Modal
        visible={sosConfirmOpen}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => sosDialState === 'idle' && setSosConfirmOpen(false)}
      >
        <View style={styles.sosBackdrop}>
          <View style={styles.sosCard} testID="sos-confirm-modal">
            <Text style={styles.sosCardEmoji}>🆘</Text>
            <Text style={styles.sosCardTitle}>Are you sure?</Text>
            <Text style={styles.sosCardBody}>
              Your phone's dialer will open with 911 pre-filled and your family will be alerted with your location.
            </Text>

            <TouchableOpacity
              testID="sos-confirm-yes"
              style={[styles.sosCardConfirm, sosDialState === 'dialing' && styles.sosCardConfirmDisabled]}
              onPress={confirmSOS}
              activeOpacity={0.85}
              disabled={sosDialState === 'dialing'}
            >
              {sosDialState === 'dialing' ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <ActivityIndicator color={Colors.surface} />
                  <Text style={styles.sosCardConfirmText}>Calling 911...</Text>
                </View>
              ) : (
                <Text style={styles.sosCardConfirmText}>Yes, Call 911</Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              testID="sos-confirm-cancel"
              style={styles.sosCardCancel}
              onPress={() => sosDialState === 'idle' && setSosConfirmOpen(false)}
              activeOpacity={0.85}
              disabled={sosDialState === 'dialing'}
            >
              <Text style={[
                styles.sosCardCancelText,
                sosDialState === 'dialing' && { opacity: 0.4 },
              ]}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function MemberCard({ member, sum, isSenior, onPress, onCheckIn }: {
  member: Member; sum?: MemberSummary; isSenior?: boolean;
  onPress: () => void; onCheckIn: () => void;
}) {
  const initials = member.name.split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase();
  const dot = member.status === 'healthy' ? '🟢' : member.status === 'warning' ? '🟡' : '🔴';
  return (
    <View testID={`member-card-${member.id}`} style={styles.memberCard}>
      <TouchableOpacity onPress={onPress} activeOpacity={0.85} style={styles.memberMain}>
        <View style={styles.avatarWrap}>
          {member.avatar_url ? (
            <Image source={{ uri: member.avatar_url }} style={styles.avatar} />
          ) : (
            <View style={[styles.avatar, styles.avatarFallback]}>
              <Text style={styles.avatarText}>{initials}</Text>
            </View>
          )}
          <View style={[styles.statusDot, { backgroundColor: StatusColor(member.status) }]} />
        </View>
        <View style={{ flex: 1, marginLeft: 14 }}>
          <View style={styles.nameRow}>
            <Text style={styles.memberName}>{member.name}, {member.age}</Text>
            <Text style={styles.statusEmoji}>{dot}</Text>
          </View>
          <Text style={styles.memberMeta}>📍 {member.location_name || 'Unknown'}</Text>
          {isSenior && sum && (
            <View style={styles.medRow}>
              <View style={styles.medChip}>
                <Text style={styles.medChipEmoji}>💊</Text>
                <Text style={styles.medChipText}>
                  {sum.medication_taken}/{sum.medication_total} taken
                </Text>
              </View>
              {sum.medication_missed > 0 && (
                <View style={[styles.medChip, { backgroundColor: Colors.warningBg }]}>
                  <Text style={[styles.medChipText, { color: Colors.warning }]}>
                    {sum.medication_missed} missed
                  </Text>
                </View>
              )}
              {sum.weekly_compliance_percent != null && (
                <View testID={`compliance-chip-${member.id}`} style={[
                  styles.medChip,
                  { backgroundColor: sum.weekly_compliance_percent >= 80 ? Colors.successBg : Colors.warningBg }
                ]}>
                  <Text style={styles.medChipEmoji}>📊</Text>
                  <Text style={[styles.medChipText, {
                    color: sum.weekly_compliance_percent >= 80 ? Colors.success : Colors.warning,
                  }]}>
                    {sum.weekly_compliance_percent}% this week
                  </Text>
                </View>
              )}
              {sum.checked_in_today && (
                <View style={[styles.medChip, { backgroundColor: Colors.successBg }]}>
                  <Text style={[styles.medChipText, { color: Colors.success }]}>✅ Checked in</Text>
                </View>
              )}
            </View>
          )}
        </View>
      </TouchableOpacity>
      <TouchableOpacity
        testID={`member-checkin-${member.id}`}
        onPress={onCheckIn}
        activeOpacity={0.85}
        style={styles.checkinPill}
      >
        <Text style={styles.checkinPillText}>✅ Check In</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 24, paddingTop: 12, paddingBottom: 16 },
  hello: { fontSize: 16, color: Colors.textTertiary },
  name: { fontSize: 28, fontWeight: '800', color: Colors.textPrimary, marginTop: 2 },
  iconBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: Colors.border },
  headerActions: { flexDirection: 'row', gap: 10 },
  summaryCard: {
    marginHorizontal: 24, padding: 18, backgroundColor: Colors.surface, borderRadius: 20,
    flexDirection: 'row', alignItems: 'center',
    boxShadow: '0px 4px 12px rgba(27,94,53,0.06)', elevation: 2,
  },
  summaryItem: { flex: 1, alignItems: 'center' },
  summaryNum: { fontSize: 24, fontWeight: '800', color: Colors.primary },
  summaryLbl: { fontSize: 11, color: Colors.textTertiary, marginTop: 2, textTransform: 'uppercase', letterSpacing: 0.5, textAlign: 'center' },
  summaryDivider: { width: 1, height: 36, backgroundColor: Colors.border },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginHorizontal: 24, marginTop: 28, marginBottom: 8 },
  sectionTitle: { fontSize: 20, fontWeight: '700', color: Colors.textPrimary },
  addBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.tertiary, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, gap: 4 },
  addBtnText: { color: Colors.primary, fontWeight: '700' },
  subSection: { fontSize: 13, fontWeight: '700', color: Colors.textTertiary, marginHorizontal: 24, marginTop: 14, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.6 },
  memberCard: {
    marginHorizontal: 24, marginTop: 10, padding: 14, backgroundColor: Colors.surface, borderRadius: 18,
    boxShadow: '0px 3px 10px rgba(27,94,53,0.06)', elevation: 2,
  },
  memberMain: { flexDirection: 'row', alignItems: 'center' },
  avatarWrap: { position: 'relative' },
  avatar: { width: 56, height: 56, borderRadius: 28 },
  avatarFallback: { backgroundColor: Colors.tertiary, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: Colors.primary, fontWeight: '700' },
  statusDot: { position: 'absolute', right: -2, bottom: -2, width: 14, height: 14, borderRadius: 7, borderWidth: 2, borderColor: Colors.surface },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  memberName: { fontSize: 16, fontWeight: '700', color: Colors.textPrimary },
  statusEmoji: { fontSize: 12 },
  memberMeta: { fontSize: 13, color: Colors.textTertiary, marginTop: 2 },
  medRow: { flexDirection: 'row', gap: 6, marginTop: 8, flexWrap: 'wrap' },
  medChip: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: Colors.tertiary, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  medChipEmoji: { fontSize: 12 },
  medChipText: { fontSize: 12, fontWeight: '700', color: Colors.primary },
  checkinPill: {
    marginTop: 12, height: 42, borderRadius: 12, backgroundColor: Colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  checkinPillText: { color: Colors.surface, fontWeight: '700', fontSize: 14 },
  empty: { alignItems: 'center', padding: 24, marginHorizontal: 24, marginTop: 8 },
  emptyText: { color: Colors.textTertiary, marginTop: 8, textAlign: 'center' },
  sosBtn: {
    position: 'absolute', bottom: 24, left: 24, right: 24,
    height: 64, backgroundColor: Colors.sos, borderRadius: 20,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12,
    boxShadow: '0px 8px 16px rgba(220,38,38,0.4)', elevation: 8,
  },
  sosEmoji: { fontSize: 24 },
  sosText: { color: Colors.surface, fontSize: 18, fontWeight: '800', letterSpacing: 0.3 },
  upgradeBanner: {
    flexDirection: 'row', alignItems: 'center',
    marginHorizontal: 20, marginTop: 24, padding: 14,
    backgroundColor: Colors.surface, borderRadius: 16,
    borderWidth: 1, borderColor: Colors.tertiary,
    boxShadow: '0px 6px 16px rgba(27,94,53,0.10)' as any,
  },
  upgradeIconWrap: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: Colors.tertiary,
    alignItems: 'center', justifyContent: 'center',
  },
  upgradeIcon: { fontSize: 20 },
  upgradeTextBlock: { flex: 1, marginLeft: 12, marginRight: 8, minWidth: 0 },
  upgradeTitle: { fontSize: 14, fontWeight: '800', color: Colors.textPrimary, lineHeight: 18 },
  upgradeSub: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  upgradePrice: { fontWeight: '800', color: Colors.primary },
  upgradeUsage: { fontSize: 10.5, color: Colors.textTertiary, marginTop: 3, fontWeight: '600' },
  upgradeCta: {
    paddingHorizontal: 14, paddingVertical: 9,
    backgroundColor: Colors.primary, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  upgradeCtaText: { color: Colors.surface, fontSize: 13, fontWeight: '800' },
  upgradeCtaArrow: { color: Colors.surface, fontSize: 16, fontWeight: '700' },

  // In-app SOS confirmation modal — designed for senior accessibility:
  // oversized 60pt touch targets, ≥14:1 contrast, big readable type, urgent
  // red "Yes, Call 911" button anchored at the bottom of the modal so it
  // sits within thumb-reach.
  sosBackdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center', justifyContent: 'center', padding: 22,
  },
  sosCard: {
    width: '100%', maxWidth: 400, backgroundColor: Colors.surface,
    borderRadius: 22, padding: 24, alignItems: 'center',
    boxShadow: '0px 12px 32px rgba(0,0,0,0.35)' as any,
    ...Platform.select({ android: { elevation: 16 } }),
  },
  sosCardEmoji: { fontSize: 48, marginBottom: 4 },
  sosCardTitle: {
    fontSize: 24, fontWeight: '900', color: Colors.textPrimary,
    textAlign: 'center', marginTop: 4,
  },
  sosCardBody: {
    fontSize: 15.5, color: Colors.textSecondary,
    textAlign: 'center', marginTop: 12, lineHeight: 22,
  },
  sosCardConfirm: {
    marginTop: 22, alignSelf: 'stretch',
    height: 60, backgroundColor: Colors.sos, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
    boxShadow: '0px 6px 14px rgba(220,38,38,0.45)' as any,
    ...Platform.select({ android: { elevation: 6 } }),
  },
  sosCardConfirmDisabled: { opacity: 0.75 },
  sosCardConfirmText: {
    color: Colors.surface, fontSize: 17, fontWeight: '900', letterSpacing: 0.3,
  },
  sosCardCancel: {
    marginTop: 10, alignSelf: 'stretch',
    height: 56, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: Colors.surface,
    borderWidth: 2, borderColor: Colors.border,
  },
  sosCardCancelText: { color: Colors.textPrimary, fontSize: 16, fontWeight: '800' },
});
