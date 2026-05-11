import { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Image,
  ActivityIndicator, Alert, Linking,
} from 'react-native';
import { useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
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
  const mapLat = member.latitude ?? 37.7749;
  const mapLon = member.longitude ?? -122.4194;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity testID="member-back" onPress={() => router.back()} style={styles.iconBtn}>
          <Ionicons name="arrow-back" size={22} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Member</Text>
        <TouchableOpacity testID="member-call" onPress={() => Linking.openURL(`tel:${member.phone}`)} style={styles.iconBtn}>
          <Ionicons name="call" size={20} color={Colors.primary} />
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
            <Ionicons name="call-outline" size={14} color={Colors.textTertiary} />
            <Text style={styles.phoneText}>{member.phone}</Text>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Location</Text>
          <View style={styles.mapCard}>
            <Image
              source={{ uri: `https://staticmap.openstreetmap.de/staticmap.php?center=${mapLat},${mapLon}&zoom=14&size=600x300&markers=${mapLat},${mapLon},lightblue` }}
              style={styles.mapImg}
            />
            <View style={styles.mapOverlay}>
              <Ionicons name="location" size={18} color={Colors.surface} />
              <Text style={styles.mapText}>{member.location_name || 'Unknown'}</Text>
            </View>
          </View>
          <View style={styles.lastSeen}>
            <Ionicons name="time-outline" size={16} color={Colors.textTertiary} />
            <Text style={styles.lastSeenText}>Last seen recently</Text>
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
                  <Ionicons name="medical" size={18} color={Colors.primary} />
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
          <Ionicons name="trash-outline" size={18} color={Colors.error} />
          <Text style={styles.deleteText}>Remove member</Text>
        </TouchableOpacity>
      </ScrollView>

      <TouchableOpacity testID="member-checkin" onPress={checkIn} activeOpacity={0.85} style={styles.checkinBtn}>
        <Ionicons name="checkmark-circle" size={24} color={Colors.surface} />
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
