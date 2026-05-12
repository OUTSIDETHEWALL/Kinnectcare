import { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Image,
  ActivityIndicator, Alert, Linking, Platform,
} from 'react-native';
import { useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Icon } from '../../src/Icon';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import { Colors, StatusColor } from '../../src/theme';
import { api, Member, Reminder } from '../../src/api';

export default function MemberDetail() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [member, setMember] = useState<Member | null>(null);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);

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
      Alert.alert('Failed', 'Could not check in. Try again.');
    }
  };

  const onDelete = () => {
    Alert.alert('Remove member?', `Are you sure you want to remove ${member?.name}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          await api.delete(`/members/${id}`).catch(() => {});
          router.back();
        },
      },
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
    : 'Coordinates not available yet';

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
    Linking.openURL(url).catch(() => {
      Alert.alert('Unable to open maps', 'No map application found on this device.');
    });
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity testID="member-back" onPress={() => router.back()} style={styles.iconBtn}>
          <Icon name="arrow-back" size={22} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Member</Text>
        <TouchableOpacity testID="member-call" onPress={() => Linking.openURL(`tel:${member.phone}`)} style={styles.iconBtn}>
          <Icon name="call" size={20} color={Colors.primary} />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 120 }}>
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
          <Text style={styles.name}>{member.name}</Text>
          <Text style={styles.meta}>{member.age} years · {member.gender} · {member.role === 'senior' ? 'Senior' : 'Family'}</Text>
          <View style={styles.phoneRow}>
            <Icon name="call-outline" size={14} color={Colors.textTertiary} />
            <Text style={styles.phoneText}>{member.phone}</Text>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Location</Text>
          <View style={styles.locationCard}>
            <View style={styles.locRow}>
              <View style={styles.locPinBubble}>
                <Text style={styles.locPinEmoji}>📍</Text>
              </View>
              <View style={{ flex: 1, marginLeft: 14 }}>
                <View style={styles.locNameRow}>
                  <Text style={styles.locName}>{member.name}</Text>
                  <View style={[styles.locStatusDot, { backgroundColor: StatusColor(member.status) }]} />
                </View>
                <Text style={styles.locPlace}>{member.location_name || 'Unknown location'}</Text>
              </View>
            </View>

            <View style={styles.locDivider} />

            <View style={styles.locMetaRow}>
              <Text style={styles.locMetaLabel}>Coordinates</Text>
              <Text style={styles.locMetaValue}>{coordsLabel}</Text>
            </View>
            <View style={styles.locMetaRow}>
              <Text style={styles.locMetaLabel}>Last seen</Text>
              <Text style={styles.locMetaValue}>🕐 Recently</Text>
            </View>

            <TouchableOpacity
              testID="member-get-directions"
              onPress={openDirections}
              activeOpacity={0.85}
              style={styles.directionsBtn}
            >
              <Text style={styles.directionsEmoji}>🗺</Text>
              <Text style={styles.directionsText}>Get Directions</Text>
            </TouchableOpacity>

            <Text style={styles.mapNote}>Live map view coming soon</Text>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Care Reminders</Text>
          {reminders.length === 0 ? (
            <Text style={styles.emptyText}>No reminders yet.</Text>
          ) : (
            reminders.map(r => (
              <View key={r.id} testID={`member-reminder-${r.id}`} style={styles.reminderCard}>
                <View style={styles.reminderIcon}>
                  <Icon name="medical" size={18} color={Colors.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.reminderTitle}>{r.title}</Text>
                  <Text style={styles.reminderTime}>{r.time}</Text>
                </View>
                <View style={[styles.reminderPill, r.taken ? styles.pillTaken : styles.pillPending]}>
                  <Text style={[styles.pillText, { color: r.taken ? Colors.success : Colors.warning }]}>
                    {r.taken ? 'Taken' : 'Pending'}
                  </Text>
                </View>
              </View>
            ))
          )}
        </View>

        <TouchableOpacity testID="member-delete" onPress={onDelete} style={styles.deleteBtn}>
          <Icon name="trash-outline" size={18} color={Colors.error} />
          <Text style={styles.deleteText}>Remove member</Text>
        </TouchableOpacity>
      </ScrollView>

      <TouchableOpacity testID="member-checkin" onPress={checkIn} activeOpacity={0.85} style={styles.checkinBtn}>
        <Icon name="checkmark-circle" size={24} color={Colors.surface} />
        <Text style={styles.checkinText}>Check in {member.name}</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 8 },
  iconBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border },
  headerTitle: { fontSize: 17, fontWeight: '700', color: Colors.textPrimary },
  profile: { alignItems: 'center', paddingHorizontal: 24, paddingTop: 8, paddingBottom: 16 },
  avatarWrap: { position: 'relative' },
  avatar: { width: 120, height: 120, borderRadius: 60 },
  avatarFallback: { backgroundColor: Colors.tertiary, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 36, color: Colors.primary, fontWeight: '800' },
  statusDot: { position: 'absolute', right: 6, bottom: 6, width: 22, height: 22, borderRadius: 11, borderWidth: 3, borderColor: Colors.background },
  name: { fontSize: 28, fontWeight: '800', color: Colors.textPrimary, marginTop: 14 },
  meta: { fontSize: 15, color: Colors.textSecondary, marginTop: 4 },
  phoneRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  phoneText: { fontSize: 14, color: Colors.textTertiary },
  section: { marginHorizontal: 24, marginTop: 16 },
  sectionTitle: { fontSize: 18, fontWeight: '700', color: Colors.textPrimary, marginBottom: 12 },
  mapCard: { borderRadius: 18, overflow: 'hidden', backgroundColor: Colors.surface, height: 180, position: 'relative' },
  mapImg: { width: '100%', height: '100%' },
  mapOverlay: {
    position: 'absolute', bottom: 12, left: 12,
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: Colors.primary, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999,
  },
  mapText: { color: Colors.surface, fontWeight: '700', fontSize: 13 },
  lastSeen: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
  lastSeenText: { fontSize: 14, color: Colors.textTertiary },
  locationCard: {
    backgroundColor: Colors.surface, borderRadius: 20, padding: 18,
    borderWidth: 1, borderColor: Colors.border,
    shadowColor: Colors.primary, shadowOpacity: 0.06, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 2,
  },
  locRow: { flexDirection: 'row', alignItems: 'center' },
  locPinBubble: {
    width: 52, height: 52, borderRadius: 26, backgroundColor: Colors.tertiary,
    alignItems: 'center', justifyContent: 'center',
  },
  locPinEmoji: { fontSize: 26 },
  locNameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  locName: { fontSize: 17, fontWeight: '700', color: Colors.textPrimary },
  locStatusDot: { width: 10, height: 10, borderRadius: 5 },
  locPlace: { fontSize: 15, color: Colors.secondary, fontWeight: '600', marginTop: 2 },
  locDivider: { height: 1, backgroundColor: Colors.border, marginVertical: 14 },
  locMetaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6 },
  locMetaLabel: { fontSize: 13, fontWeight: '600', color: Colors.textTertiary, textTransform: 'uppercase', letterSpacing: 0.5 },
  locMetaValue: { fontSize: 14, color: Colors.textPrimary, fontWeight: '600' },
  directionsBtn: {
    marginTop: 14, height: 52, borderRadius: 14, backgroundColor: Colors.primary,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
  },
  directionsEmoji: { fontSize: 18 },
  directionsText: { color: Colors.surface, fontSize: 16, fontWeight: '700' },
  mapNote: { fontSize: 12, color: Colors.textTertiary, textAlign: 'center', marginTop: 10, fontStyle: 'italic' },
  reminderCard: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.surface,
    padding: 14, borderRadius: 14, marginTop: 8, borderWidth: 1, borderColor: Colors.border,
  },
  reminderIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: Colors.tertiary, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  reminderTitle: { fontSize: 15, fontWeight: '700', color: Colors.textPrimary },
  reminderTime: { fontSize: 13, color: Colors.textTertiary, marginTop: 2 },
  reminderPill: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999 },
  pillTaken: { backgroundColor: Colors.successBg },
  pillPending: { backgroundColor: Colors.warningBg },
  pillText: { fontSize: 12, fontWeight: '700' },
  emptyText: { color: Colors.textTertiary, fontSize: 14, fontStyle: 'italic' },
  deleteBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 28, paddingVertical: 12 },
  deleteText: { color: Colors.error, fontWeight: '700' },
  checkinBtn: {
    position: 'absolute', bottom: 24, left: 24, right: 24,
    height: 60, backgroundColor: Colors.primary, borderRadius: 18,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    shadowColor: Colors.primary, shadowOpacity: 0.3, shadowRadius: 14, shadowOffset: { width: 0, height: 8 }, elevation: 8,
  },
  checkinText: { color: Colors.surface, fontSize: 17, fontWeight: '700' },
});
