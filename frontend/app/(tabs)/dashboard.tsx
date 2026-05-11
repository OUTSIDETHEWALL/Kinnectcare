import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Image,
  RefreshControl, Alert as RNAlert, Linking, ActivityIndicator,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import { Colors, StatusColor } from '../../src/theme';
import { api, Member, Reminder } from '../../src/api';
import { useAuth } from '../../src/AuthContext';

export default function Dashboard() {
  const router = useRouter();
  const { user, logout } = useAuth();
  const [members, setMembers] = useState<Member[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    try {
      const [m, r] = await Promise.all([api.get('/members'), api.get('/reminders')]);
      setMembers(m.data);
      setReminders(r.data);
    } catch (_e) {
      // silent
    }
  };

  useFocusEffect(useCallback(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, []));

  useEffect(() => {
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          const pos = await Location.getCurrentPositionAsync({});
          // optionally update first family-self member; non-blocking
          if (members.length > 0) {
            await api.put(`/members/${members[0].id}/location`, {
              latitude: pos.coords.latitude,
              longitude: pos.coords.longitude,
            }).catch(() => {});
          }
        }
      } catch (_e) {}
    })();
  }, [members.length]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const triggerSOS = () => {
    RNAlert.alert(
      '🚨 Emergency SOS',
      'Are you sure? This will alert your family and call emergency services (911).',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Yes, Send SOS',
          style: 'destructive',
          onPress: async () => {
            try {
              await api.post('/sos', {});
              Linking.openURL('tel:911').catch(() => {});
              RNAlert.alert('SOS Sent', 'Your family has been notified.');
              load();
            } catch (_e) {
              RNAlert.alert('SOS Failed', 'Please try again.');
            }
          },
        },
      ]
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

  const seniors = members.filter(m => m.role === 'senior');
  const family = members.filter(m => m.role === 'family');
  const pendingReminders = reminders.filter(r => !r.taken);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 120 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
      >
        <View style={styles.header}>
          <View>
            <Text style={styles.hello}>Hello,</Text>
            <Text style={styles.name}>{user?.full_name?.split(' ')[0] || 'there'} 👋</Text>
          </View>
          <TouchableOpacity testID="dashboard-logout" onPress={logout} style={styles.iconBtn}>
            <Ionicons name="log-out-outline" size={22} color={Colors.textSecondary} />
          </TouchableOpacity>
        </View>

        <View style={styles.summaryCard}>
          <View style={styles.summaryItem}>
            <Text style={styles.summaryNum}>{members.length}</Text>
            <Text style={styles.summaryLbl}>Members</Text>
          </View>
          <View style={styles.summaryDivider} />
          <View style={styles.summaryItem}>
            <Text style={styles.summaryNum}>{seniors.length}</Text>
            <Text style={styles.summaryLbl}>Seniors</Text>
          </View>
          <View style={styles.summaryDivider} />
          <View style={styles.summaryItem}>
            <Text style={styles.summaryNum}>{pendingReminders.length}</Text>
            <Text style={styles.summaryLbl}>Reminders</Text>
          </View>
        </View>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Your Family</Text>
          <TouchableOpacity testID="add-member-btn" onPress={() => router.push('/add-member')} style={styles.addBtn}>
            <Ionicons name="add" size={18} color={Colors.primary} />
            <Text style={styles.addBtnText}>Add</Text>
          </TouchableOpacity>
        </View>

        {seniors.length > 0 && (
          <>
            <Text style={styles.subSection}>Seniors</Text>
            {seniors.map(m => <MemberCard key={m.id} member={m} onPress={() => router.push(`/member/${m.id}`)} />)}
          </>
        )}

        {family.length > 0 && (
          <>
            <Text style={styles.subSection}>Family</Text>
            {family.map(m => <MemberCard key={m.id} member={m} onPress={() => router.push(`/member/${m.id}`)} />)}
          </>
        )}

        {members.length === 0 && (
          <View style={styles.empty}>
            <Ionicons name="people-outline" size={40} color={Colors.textTertiary} />
            <Text style={styles.emptyText}>No family members yet. Tap "Add" to get started.</Text>
          </View>
        )}

        <Text style={[styles.sectionTitle, { marginHorizontal: 24, marginTop: 28, marginBottom: 12 }]}>Medication Reminders</Text>
        {pendingReminders.length === 0 ? (
          <View style={styles.reminderEmpty}>
            <Ionicons name="checkmark-circle" size={28} color={Colors.success} />
            <Text style={styles.reminderEmptyText}>All caught up!</Text>
          </View>
        ) : (
          pendingReminders.slice(0, 4).map(r => (
            <ReminderRow key={r.id} reminder={r} onToggle={async () => {
              await api.post(`/reminders/${r.id}/toggle`);
              load();
            }} />
          ))
        )}
      </ScrollView>

      <TouchableOpacity testID="sos-button" onPress={triggerSOS} activeOpacity={0.85} style={styles.sosBtn}>
        <Ionicons name="warning" size={26} color={Colors.surface} />
        <Text style={styles.sosText}>SOS Emergency</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

function MemberCard({ member, onPress }: { member: Member; onPress: () => void }) {
  const initials = member.name.split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase();
  return (
    <TouchableOpacity testID={`member-card-${member.id}`} onPress={onPress} activeOpacity={0.85} style={styles.memberCard}>
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
        <Text style={styles.memberName}>{member.name}, {member.age}</Text>
        <Text style={styles.memberMeta}>
          <Ionicons name="location-outline" size={12} color={Colors.textTertiary} /> {member.location_name || 'Unknown'}
        </Text>
        <Text style={styles.memberMeta}>Last seen recently</Text>
      </View>
      <Ionicons name="chevron-forward" size={20} color={Colors.textTertiary} />
    </TouchableOpacity>
  );
}

function ReminderRow({ reminder, onToggle }: { reminder: Reminder; onToggle: () => void }) {
  return (
    <TouchableOpacity testID={`reminder-${reminder.id}`} onPress={onToggle} activeOpacity={0.85} style={styles.reminderCard}>
      <View style={styles.reminderIcon}>
        <Ionicons name="medical" size={20} color={Colors.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.reminderTitle}>{reminder.title}</Text>
        <Text style={styles.reminderSub}>For {reminder.member_name} · {reminder.time}</Text>
      </View>
      <View style={styles.checkBox}>
        {reminder.taken && <Ionicons name="checkmark" size={18} color={Colors.surface} />}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 24, paddingTop: 12, paddingBottom: 16 },
  hello: { fontSize: 16, color: Colors.textTertiary },
  name: { fontSize: 28, fontWeight: '800', color: Colors.textPrimary, marginTop: 2 },
  iconBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: Colors.border },
  summaryCard: {
    marginHorizontal: 24, padding: 18, backgroundColor: Colors.surface, borderRadius: 20,
    flexDirection: 'row', alignItems: 'center',
    shadowColor: Colors.primary, shadowOpacity: 0.06, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 2,
  },
  summaryItem: { flex: 1, alignItems: 'center' },
  summaryNum: { fontSize: 24, fontWeight: '800', color: Colors.primary },
  summaryLbl: { fontSize: 12, color: Colors.textTertiary, marginTop: 2, textTransform: 'uppercase', letterSpacing: 0.5 },
  summaryDivider: { width: 1, height: 36, backgroundColor: Colors.border },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginHorizontal: 24, marginTop: 28, marginBottom: 8 },
  sectionTitle: { fontSize: 20, fontWeight: '700', color: Colors.textPrimary },
  addBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.tertiary, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999 },
  addBtnText: { color: Colors.primary, fontWeight: '700', marginLeft: 4 },
  subSection: { fontSize: 13, fontWeight: '700', color: Colors.textTertiary, marginHorizontal: 24, marginTop: 14, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.6 },
  memberCard: {
    marginHorizontal: 24, marginTop: 10, padding: 14, backgroundColor: Colors.surface, borderRadius: 18,
    flexDirection: 'row', alignItems: 'center',
    shadowColor: Colors.primary, shadowOpacity: 0.06, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 2,
  },
  avatarWrap: { position: 'relative' },
  avatar: { width: 56, height: 56, borderRadius: 28 },
  avatarFallback: { backgroundColor: Colors.tertiary, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: Colors.primary, fontWeight: '700' },
  statusDot: { position: 'absolute', right: -2, bottom: -2, width: 14, height: 14, borderRadius: 7, borderWidth: 2, borderColor: Colors.surface },
  memberName: { fontSize: 16, fontWeight: '700', color: Colors.textPrimary },
  memberMeta: { fontSize: 13, color: Colors.textTertiary, marginTop: 2 },
  empty: { alignItems: 'center', padding: 24, marginHorizontal: 24, marginTop: 8 },
  emptyText: { color: Colors.textTertiary, marginTop: 8, textAlign: 'center' },
  reminderCard: {
    marginHorizontal: 24, marginTop: 10, padding: 14, backgroundColor: Colors.surface, borderRadius: 16,
    flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: Colors.border,
  },
  reminderIcon: { width: 40, height: 40, borderRadius: 12, backgroundColor: Colors.tertiary, alignItems: 'center', justifyContent: 'center' },
  reminderTitle: { fontSize: 15, fontWeight: '700', color: Colors.textPrimary, marginLeft: 12 },
  reminderSub: { fontSize: 13, color: Colors.textTertiary, marginLeft: 12, marginTop: 2 },
  checkBox: { width: 28, height: 28, borderRadius: 14, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center' },
  reminderEmpty: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', padding: 16, marginHorizontal: 24, gap: 8, backgroundColor: Colors.successBg, borderRadius: 16 },
  reminderEmptyText: { color: Colors.success, fontWeight: '700' },
  sosBtn: {
    position: 'absolute', bottom: 24, left: 24, right: 24,
    height: 64, backgroundColor: Colors.sos, borderRadius: 20,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12,
    shadowColor: Colors.sos, shadowOpacity: 0.4, shadowRadius: 16, shadowOffset: { width: 0, height: 8 }, elevation: 8,
  },
  sosText: { color: Colors.surface, fontSize: 18, fontWeight: '800', letterSpacing: 0.3 },
});
