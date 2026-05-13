import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Icon } from '../src/Icon';
import { Colors } from '../src/theme';
import { useAuth } from '../src/AuthContext';
import { APP_NAME, COMPANY_NAME } from '../src/legal';

export default function SettingsScreen() {
  const router = useRouter();
  const { user, logout } = useAuth();

  const confirmLogout = () => {
    Alert.alert('Sign out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: logout },
    ]);
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity
          testID="settings-back"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/dashboard'))}
          style={styles.backBtn}
          accessibilityLabel="Back"
        >
          <Icon name="arrow-back" size={22} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Settings</Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Account</Text>
          <View style={styles.card}>
            <Row label="Name" value={user?.full_name || '—'} />
            <Divider />
            <Row label="Email" value={user?.email || '—'} />
            <Divider />
            <Row label="Time zone" value={user?.timezone || 'UTC'} />
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Legal</Text>
          <View style={styles.card}>
            <NavRow
              testID="settings-privacy"
              icon="🛡️"
              label="Privacy Policy"
              onPress={() => router.push('/privacy-policy')}
            />
            <Divider />
            <NavRow
              testID="settings-terms"
              icon="📄"
              label="Terms of Service"
              onPress={() => router.push('/terms-of-service')}
            />
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Session</Text>
          <View style={styles.card}>
            <NavRow
              testID="settings-logout"
              icon="↩"
              label="Sign out"
              onPress={confirmLogout}
              danger
            />
          </View>
        </View>

        <Text style={styles.footer}>
          {APP_NAME} · © {new Date().getFullYear()} {COMPANY_NAME}
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function NavRow(props: { label: string; icon: string; onPress: () => void; testID?: string; danger?: boolean }) {
  return (
    <TouchableOpacity testID={props.testID} onPress={props.onPress} style={styles.navRow} activeOpacity={0.7}>
      <Text style={styles.navIcon}>{props.icon}</Text>
      <Text style={[styles.navLabel, props.danger && { color: Colors.error }]}>{props.label}</Text>
      <Text style={styles.chevron}>›</Text>
    </TouchableOpacity>
  );
}

function Divider() {
  return <View style={styles.divider} />;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 8,
    borderBottomWidth: 1, borderBottomColor: Colors.border, backgroundColor: Colors.surface,
  },
  backBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 17, fontWeight: '800', color: Colors.textPrimary, flex: 1, textAlign: 'center' },
  scroll: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 56 },
  section: { marginBottom: 24 },
  sectionLabel: {
    fontSize: 12, fontWeight: '800', color: Colors.textTertiary,
    letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 8,
  },
  card: {
    backgroundColor: Colors.surface, borderRadius: 14, borderWidth: 1, borderColor: Colors.border, overflow: 'hidden',
  },
  row: { paddingHorizontal: 16, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowLabel: { fontSize: 14, color: Colors.textSecondary, fontWeight: '600' },
  rowValue: { fontSize: 14, color: Colors.textPrimary, fontWeight: '700', maxWidth: '60%' },
  divider: { height: 1, backgroundColor: Colors.border, marginHorizontal: 16 },
  navRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 16, minHeight: 52 },
  navIcon: { fontSize: 18, marginRight: 12, width: 22, textAlign: 'center' },
  navLabel: { flex: 1, fontSize: 15, fontWeight: '700', color: Colors.textPrimary },
  chevron: { fontSize: 22, color: Colors.textTertiary },
  footer: { fontSize: 12, color: Colors.textTertiary, textAlign: 'center', marginTop: 18 },
});
