import { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Image,
  ActivityIndicator, Alert, Linking, Platform, RefreshControl,
} from 'react-native';
import { useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Icon } from '../../src/Icon';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import { Colors, StatusColor } from '../../src/theme';
import { api, Member, Reminder } from '../../src/api';

const TIME_PRESETS = ['08:00', '09:00', '10:00', '12:00', '18:00', '20:00', '21:00'];

export default function MemberDetail() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [member, setMember] = useState<Member | null>(null);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showCheckinSettings, setShowCheckinSettings] = useState(false);

  const load = async () => {
    try {
      const [m, r] = await Promise.all([
        api.get(`/members/${id}`),
        api.get(`/reminders/member/${id}`),
      ]);
      setMember(m.data);
      setReminders(r.data);
    } catch (_e) {}
  };

  useFocusEffect(useCallback(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [id]));

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const markReminder = async (rid: string, status: 'taken' | 'missed') => {
    try {
      await api.post(`/reminders/${rid}/mark`, { status });
      load();
    } catch (_e) {
      Alert.alert('Failed', 'Could not update reminder.');
    }
  };

  const deleteReminder = (rid: string, title: string) => {
    Alert.alert('Remove?', `Remove "${title}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: async () => {
          await api.delete(`/reminders/${rid}`).catch(() => {});
          load();
        } },
    ]);
  };

  const checkIn = async () => {
    try {
      let lat: number | undefined, lon: number | undefined, loc_name: string | undefined;
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          const pos = await Location.getCurrentPositionAsync({});
          lat = pos.coords.latitude;
          lon = pos.coords.longitude;
          loc_name = 'Current Location';
        }
      } catch (_e) {}
      await api.post('/checkins', { member_id: id, latitude: lat, longitude: lon, location_name: loc_name });
      router.push({ pathname: '/check-in', params: { name: member?.name } });
    } catch (_e) {
      Alert.alert('Failed', 'Could not check in.');
    }
  };

  const setCheckinTime = async (t: string | null) => {
    try {
      const r = await api.put(`/members/${id}/checkin-settings`, { daily_checkin_time: t });
      setMember(r.data);
      setShowCheckinSettings(false);
    } catch (_e) {
      Alert.alert('Failed', 'Could not update.');
    }
  };

  const onDelete = () => {
    Alert.alert('Remove member?', `Are you sure you want to remove ${member?.name}?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: async () => {
          await api.delete(`/members/${id}`).catch(() => {});
          router.back();
        } },
    ]);
  };

  if (loading || !member) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator color={Colors.primary} size="large" />
        </View>
      </SafeAreaView>
    );
  }

  const initials = member.name.split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase();
  const hasCoords = member.latitude != null && member.longitude != null;
  const coordsLabel = hasCoords
    ? `${member.latitude!.toFixed(4)}°, ${member.longitude!.toFixed(4)}°`
    : 'Not available yet';
  const dot = member.status === 'healthy' ? '🟢' : member.status === 'warning' ? '🟡' : '🔴';

  const meds = reminders.filter(r => r.category === 'medication');
  const routines = reminders.filter(r => r.category === 'routine');
  const medsTaken = meds.filter(r => r.status === 'taken').length;
  const routinesDone = routines.filter(r => r.status === 'taken').length;

  const openDirections = () => {
    const label = encodeURIComponent(member.location_name || member.name);
    let url: string;
    if (hasCoords) {
      const latlon = `${member.latitude},${member.longitude}`;
      url = Platform.select({
        ios: `maps:0,0?q=${label}@${latlon}`,
        android: `geo:0,0?q=${latlon}(${label})`,
        default: `https://www.google.com/maps/search/?api=1&query=${latlon}`,
      })!;
    } else {
      url = `https://www.google.com/maps/search/?api=1&query=${label}`;
    }
    Linking.openURL(url).catch(() => Alert.alert('Unable to open maps'));
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity testID="member-back" onPress={() => router.back()} style={styles.iconBtn}>
          <Icon name="arrow-back" size={22} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Member</Text>
        <TouchableOpacity testID="member-call" onPress={() => Linking.openURL(`tel:${member.phone}`)} style={styles.iconBtn}>
          <Text style={{ fontSize: 18 }}>📞</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: 120 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
      >
        <View style={styles.profile}>
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
          <Text style={styles.name}>{member.name} {dot}</Text>
          <Text style={styles.meta}>{member.age} years · {member.gender} · {member.role === 'senior' ? '👴 Senior' : '👨‍👩‍👧 Family'}</Text>
          <Text style={styles.phoneText}>📞 {member.phone}</Text>
        </View>

        {/* Location Card */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Location</Text>
          <View style={styles.locationCard}>
            <View style={styles.locRow}>
              <View style={styles.locPinBubble}><Text style={styles.locPinEmoji}>📍</Text></View>
              <View style={{ flex: 1, marginLeft: 14 }}>
                <Text style={styles.locName}>{member.location_name || 'Unknown location'}</Text>
                <Text style={styles.locSub}>Last seen 🕐 recently</Text>
              </View>
            </View>
            <View style={styles.locDivider} />
            <View style={styles.locMetaRow}>
              <Text style={styles.locMetaLabel}>Coordinates</Text>
              <Text style={styles.locMetaValue}>{coordsLabel}</Text>
            </View>
            <TouchableOpacity testID="member-get-directions" onPress={openDirections} activeOpacity={0.85} style={styles.directionsBtn}>
              <Text style={styles.directionsEmoji}>🗺</Text>
              <Text style={styles.directionsText}>Get Directions</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Check-in Settings */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Daily Check-in</Text>
            <TouchableOpacity testID="checkin-settings-toggle" onPress={() => setShowCheckinSettings(v => !v)}>
              <Text style={styles.linkText}>{showCheckinSettings ? 'Done' : 'Edit'}</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.settingCard}>
            <Text style={styles.settingLabel}>Expected check-in time (UTC)</Text>
            <Text style={styles.settingValue}>
              {member.daily_checkin_time ? `🕐 ${member.daily_checkin_time}` : '— Not set'}
            </Text>
            {showCheckinSettings && (
              <View style={styles.timeRow}>
                {TIME_PRESETS.map(t => (
                  <TouchableOpacity
                    key={t}
                    testID={`checkin-time-${t}`}
                    onPress={() => setCheckinTime(t)}
                    style={[styles.timePill, member.daily_checkin_time === t && styles.timePillActive]}
                  >
                    <Text style={[styles.timePillText, member.daily_checkin_time === t && styles.timePillTextActive]}>{t}</Text>
                  </TouchableOpacity>
                ))}
                <TouchableOpacity
                  testID="checkin-time-clear"
                  onPress={() => setCheckinTime(null)}
                  style={[styles.timePill, { backgroundColor: Colors.errorBg }]}
                >
                  <Text style={[styles.timePillText, { color: Colors.error }]}>Disable</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        </View>

        {/* Medications */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>💊 Medications ({medsTaken}/{meds.length})</Text>
            <TouchableOpacity
              testID="add-medication-btn"
              onPress={() => router.push(`/add-medication/${id}`)}
              style={styles.addBtnSmall}
            >
              <Text style={styles.addBtnSmallText}>➕ Add</Text>
            </TouchableOpacity>
          </View>
          {meds.length === 0 ? (
            <Text style={styles.emptyText}>No medications yet. Tap Add to create one.</Text>
          ) : meds.map(r => (
            <ReminderRow key={r.id} reminder={r} onMark={markReminder} onDelete={deleteReminder} />
          ))}
        </View>

        {/* Daily Routine */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>🌿 Daily Routine ({routinesDone}/{routines.length})</Text>
            <TouchableOpacity
              testID="add-routine-btn"
              onPress={() => router.push(`/add-routine/${id}`)}
              style={styles.addBtnSmall}
            >
              <Text style={styles.addBtnSmallText}>➕ Add</Text>
            </TouchableOpacity>
          </View>
          {routines.length === 0 ? (
            <Text style={styles.emptyText}>No routine items yet.</Text>
          ) : routines.map(r => (
            <ReminderRow key={r.id} reminder={r} onMark={markReminder} onDelete={deleteReminder} />
          ))}
        </View>

        <TouchableOpacity testID="member-delete" onPress={onDelete} style={styles.deleteBtn}>
          <Text style={{ fontSize: 14 }}>🗑</Text>
          <Text style={styles.deleteText}>Remove member</Text>
        </TouchableOpacity>
      </ScrollView>

      <TouchableOpacity testID="member-checkin" onPress={checkIn} activeOpacity={0.85} style={styles.checkinBtn}>
        <Text style={styles.checkinEmoji}>✅</Text>
        <Text style={styles.checkinText}>Check in {member.name}</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

function ReminderRow({ reminder, onMark, onDelete }: {
  reminder: Reminder;
  onMark: (id: string, s: 'taken' | 'missed') => void;
  onDelete: (id: string, title: string) => void;
}) {
  const isTaken = reminder.status === 'taken';
  const isMissed = reminder.status === 'missed';
  return (
    <View testID={`reminder-${reminder.id}`} style={styles.reminderCard}>
      <View style={{ flex: 1 }}>
        <View style={styles.reminderTitleRow}>
          <Text style={styles.reminderEmoji}>{reminder.category === 'medication' ? '💊' : '🌿'}</Text>
          <Text style={styles.reminderTitle}>{reminder.title}</Text>
        </View>
        {reminder.dosage ? <Text style={styles.reminderSub}>{reminder.dosage}</Text> : null}
        <Text style={styles.reminderTime}>
          🕐 {(reminder.times && reminder.times.length > 0 ? reminder.times : [reminder.time]).filter(Boolean).join(' · ')}
        </Text>
        {isMissed && <Text style={styles.missedTag}>⚠ Missed — family alerted</Text>}
      </View>
      <View style={styles.reminderActions}>
        <TouchableOpacity
          testID={`mark-taken-${reminder.id}`}
          onPress={() => onMark(reminder.id, 'taken')}
          style={[styles.markBtn, isTaken && styles.markBtnTakenActive]}
        >
          <Text style={[styles.markBtnText, isTaken && { color: Colors.surface }]}>✅</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID={`mark-missed-${reminder.id}`}
          onPress={() => onMark(reminder.id, 'missed')}
          style={[styles.markBtn, isMissed && styles.markBtnMissedActive]}
        >
          <Text style={[styles.markBtnText, isMissed && { color: Colors.surface }]}>✕</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID={`delete-reminder-${reminder.id}`}
          onPress={() => onDelete(reminder.id, reminder.title)}
          style={styles.deleteBtnSmall}
        >
          <Text style={{ fontSize: 14, color: Colors.textTertiary }}>🗑</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 8 },
  iconBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border },
  headerTitle: { fontSize: 17, fontWeight: '700', color: Colors.textPrimary },
  profile: { alignItems: 'center', paddingHorizontal: 24, paddingTop: 8, paddingBottom: 16 },
  avatarWrap: { position: 'relative' },
  avatar: { width: 110, height: 110, borderRadius: 55 },
  avatarFallback: { backgroundColor: Colors.tertiary, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 32, color: Colors.primary, fontWeight: '800' },
  statusDot: { position: 'absolute', right: 6, bottom: 6, width: 22, height: 22, borderRadius: 11, borderWidth: 3, borderColor: Colors.background },
  name: { fontSize: 26, fontWeight: '800', color: Colors.textPrimary, marginTop: 12 },
  meta: { fontSize: 14, color: Colors.textSecondary, marginTop: 4 },
  phoneText: { fontSize: 14, color: Colors.textTertiary, marginTop: 4 },
  section: { marginHorizontal: 24, marginTop: 18 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  sectionTitle: { fontSize: 17, fontWeight: '700', color: Colors.textPrimary },
  linkText: { color: Colors.primary, fontWeight: '700', fontSize: 14 },
  addBtnSmall: { backgroundColor: Colors.tertiary, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999 },
  addBtnSmallText: { color: Colors.primary, fontWeight: '700', fontSize: 13 },
  // Location card
  locationCard: { backgroundColor: Colors.surface, borderRadius: 18, padding: 16, borderWidth: 1, borderColor: Colors.border },
  locRow: { flexDirection: 'row', alignItems: 'center' },
  locPinBubble: { width: 48, height: 48, borderRadius: 24, backgroundColor: Colors.tertiary, alignItems: 'center', justifyContent: 'center' },
  locPinEmoji: { fontSize: 22 },
  locName: { fontSize: 16, fontWeight: '700', color: Colors.textPrimary },
  locSub: { fontSize: 13, color: Colors.textTertiary, marginTop: 2 },
  locDivider: { height: 1, backgroundColor: Colors.border, marginVertical: 12 },
  locMetaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4 },
  locMetaLabel: { fontSize: 12, fontWeight: '700', color: Colors.textTertiary, textTransform: 'uppercase', letterSpacing: 0.5 },
  locMetaValue: { fontSize: 13, color: Colors.textPrimary, fontWeight: '600' },
  directionsBtn: { marginTop: 12, height: 48, borderRadius: 14, backgroundColor: Colors.primary, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  directionsEmoji: { fontSize: 16 },
  directionsText: { color: Colors.surface, fontSize: 15, fontWeight: '700' },
  // Settings card
  settingCard: { backgroundColor: Colors.surface, borderRadius: 16, padding: 14, borderWidth: 1, borderColor: Colors.border },
  settingLabel: { fontSize: 12, fontWeight: '700', color: Colors.textTertiary, textTransform: 'uppercase', letterSpacing: 0.5 },
  settingValue: { fontSize: 16, color: Colors.textPrimary, fontWeight: '700', marginTop: 4 },
  timeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  timePill: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border },
  timePillActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  timePillText: { fontWeight: '700', color: Colors.textSecondary, fontSize: 13 },
  timePillTextActive: { color: Colors.surface },
  // Reminder row
  reminderCard: { flexDirection: 'row', backgroundColor: Colors.surface, padding: 12, borderRadius: 14, marginTop: 8, borderWidth: 1, borderColor: Colors.border, alignItems: 'center' },
  reminderTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  reminderEmoji: { fontSize: 16 },
  reminderTitle: { fontSize: 15, fontWeight: '700', color: Colors.textPrimary },
  reminderSub: { fontSize: 13, color: Colors.textSecondary, marginTop: 2, marginLeft: 24 },
  reminderTime: { fontSize: 12, color: Colors.textTertiary, marginTop: 2, marginLeft: 24 },
  missedTag: { fontSize: 12, color: Colors.warning, fontWeight: '700', marginTop: 4, marginLeft: 24 },
  reminderActions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  markBtn: { width: 36, height: 36, borderRadius: 12, backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border, alignItems: 'center', justifyContent: 'center' },
  markBtnTakenActive: { backgroundColor: Colors.success, borderColor: Colors.success },
  markBtnMissedActive: { backgroundColor: Colors.error, borderColor: Colors.error },
  markBtnText: { fontSize: 14, color: Colors.textSecondary, fontWeight: '700' },
  deleteBtnSmall: { width: 28, height: 36, alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: Colors.textTertiary, fontSize: 13, fontStyle: 'italic', paddingVertical: 8 },
  deleteBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 28, paddingVertical: 12 },
  deleteText: { color: Colors.error, fontWeight: '700' },
  checkinBtn: {
    position: 'absolute', bottom: 24, left: 24, right: 24,
    height: 60, backgroundColor: Colors.primary, borderRadius: 18,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    shadowColor: Colors.primary, shadowOpacity: 0.3, shadowRadius: 14, shadowOffset: { width: 0, height: 8 }, elevation: 8,
  },
  checkinEmoji: { fontSize: 22 },
  checkinText: { color: Colors.surface, fontSize: 17, fontWeight: '700' },
});
