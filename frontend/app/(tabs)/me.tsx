/**
 * Build #54 — Me tab foundation.
 *
 * Personal (single-user) settings that used to live on the standalone
 * /settings screen now surface here as a primary tab.  Family-scoped
 * settings intentionally do NOT appear here — they remain under the
 * Family tab per Charles's mental model rule: "Me = me, Family = everyone."
 *
 * Sections (Build 54 initial cut):
 *   • Account          — read-only summary of the signed-in user
 *   • Security         — Change PIN
 *   • Notifications    — Quiet Hours
 *   • Privacy          — Location Sharing placeholder (Build 55 will
 *                        make it interactive)
 *   • Support          — App version + policy/terms links
 *   • Advanced         — Diagnostics
 *   • Sign out
 *
 * Change Password intentionally omitted — Kinnship is OTP-passwordless.
 */
import { useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Constants from 'expo-constants';
import { Icon } from '../../src/Icon';
import { Colors } from '../../src/theme';
import { useAuth } from '../../src/AuthContext';

function NavRow(props: {
  label: string;
  icon: string;
  onPress: () => void;
  testID?: string;
  secondary?: string | null;
  danger?: boolean;
  disabled?: boolean;
}) {
  const { label, icon, onPress, testID, secondary, danger, disabled } = props;
  return (
    <TouchableOpacity
      testID={testID}
      onPress={disabled ? undefined : onPress}
      style={[styles.row, disabled && styles.rowDisabled]}
      activeOpacity={disabled ? 1 : 0.75}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Text style={styles.rowIcon}>{icon}</Text>
      <View style={{ flex: 1 }}>
        <Text style={[styles.rowLabel, danger && styles.rowLabelDanger, disabled && styles.rowLabelDisabled]}>
          {label}
        </Text>
        {secondary ? <Text style={styles.rowSecondary}>{secondary}</Text> : null}
      </View>
      {!disabled ? <Icon name="chevron-forward" size={20} color={Colors.textTertiary} /> : null}
    </TouchableOpacity>
  );
}

function ReadRow(props: { label: string; value: string | null | undefined }) {
  const { label, value } = props;
  return (
    <View style={styles.readRow}>
      <Text style={styles.readLabel}>{label}</Text>
      <Text style={styles.readValue}>{value || '—'}</Text>
    </View>
  );
}

export default function MeScreen() {
  const router = useRouter();
  const { user, logout } = useAuth();

  const versionLine = useMemo(() => {
    // Prefer explicit versionCode from app.config.js, fall back to
    // Constants (both native builds and Expo Go).
    const version = (Constants.expoConfig as any)?.version || Constants.manifest2?.extra?.expoClient?.version || '—';
    const build = (Constants.expoConfig as any)?.android?.versionCode
      ?? (Constants.expoConfig as any)?.ios?.buildNumber
      ?? '—';
    return `Version ${version} · Build ${build}`;
  }, []);

  const onSignOut = () => {
    Alert.alert('Sign out?', 'You will need to sign back in with your email.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: async () => {
          try { await logout?.(); } catch { /* ignore */ }
          router.replace('/');
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.title}>Me</Text>

        {/* Account */}
        <Text style={styles.sectionLabel}>Account</Text>
        <View style={styles.card}>
          <ReadRow label="Name" value={(user as any)?.full_name || (user as any)?.name} />
          <ReadRow label="Email" value={user?.email as string} />
          <ReadRow label="Role" value={((user as any)?.role || 'member').replace(/^\w/, (c: string) => c.toUpperCase())} />
        </View>

        {/* Security */}
        <Text style={styles.sectionLabel}>Security</Text>
        <View style={styles.card}>
          <NavRow
            testID="me-change-pin"
            icon="🔒"
            label="Change PIN"
            secondary="4-digit unlock for the app"
            onPress={() => router.push('/(auth)/pin-setup' as any)}
          />
        </View>

        {/* Notifications */}
        <Text style={styles.sectionLabel}>Notifications</Text>
        <View style={styles.card}>
          <NavRow
            testID="me-quiet-hours"
            icon="🌙"
            label="Quiet Hours"
            secondary="Silence non-emergency alerts at night"
            onPress={() => router.push('/quiet-hours')}
          />
        </View>

        {/* Privacy — Location Sharing toggle arrives in Build 55 */}
        <Text style={styles.sectionLabel}>Privacy</Text>
        <View style={styles.card}>
          <NavRow
            testID="me-location-sharing"
            icon="📍"
            label="Location Sharing"
            secondary="Coming in the next build"
            disabled
            onPress={() => {}}
          />
        </View>

        {/* Support */}
        <Text style={styles.sectionLabel}>Support</Text>
        <View style={styles.card}>
          <View style={styles.readRow}>
            <Text style={styles.readLabel}>Version</Text>
            <Text style={styles.readValue}>{versionLine}</Text>
          </View>
          <NavRow
            testID="me-privacy-policy"
            icon="📄"
            label="Privacy Policy"
            onPress={() => router.push('/privacy-policy')}
          />
          <NavRow
            testID="me-terms"
            icon="📜"
            label="Terms of Service"
            onPress={() => router.push('/terms-of-service')}
          />
        </View>

        {/* Advanced — Diagnostics moved here from top-level Settings */}
        <Text style={styles.sectionLabel}>Advanced</Text>
        <View style={styles.card}>
          <NavRow
            testID="me-diagnostics"
            icon="🛠"
            label="Diagnostics"
            secondary="Developer tools — safe to explore"
            onPress={() => router.push('/diagnostics' as any)}
          />
        </View>

        {/* Sign out */}
        <TouchableOpacity
          testID="me-sign-out"
          style={styles.signOutBtn}
          onPress={onSignOut}
          activeOpacity={0.85}
        >
          <Icon name="log-out-outline" size={20} color={Colors.error} />
          <Text style={styles.signOutText}>Sign out</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  body: { paddingHorizontal: 20, paddingBottom: 60, paddingTop: 8 },
  title: { fontSize: 28, fontWeight: '800', color: Colors.text, marginTop: 4, marginBottom: 16 },
  sectionLabel: {
    fontSize: 12, fontWeight: '800', letterSpacing: 0.8, textTransform: 'uppercase',
    color: Colors.textSecondary, marginTop: 20, marginBottom: 8, paddingHorizontal: 4,
  },
  card: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  rowDisabled: { opacity: 0.55 },
  rowIcon: { fontSize: 18 },
  rowLabel: { fontSize: 15, fontWeight: '700', color: Colors.textPrimary },
  rowLabelDanger: { color: Colors.error },
  rowLabelDisabled: { color: Colors.textTertiary, fontWeight: '600' },
  rowSecondary: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  readRow: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  readLabel: { fontSize: 12, color: Colors.textTertiary, fontWeight: '700', letterSpacing: 0.3 },
  readValue: { fontSize: 15, color: Colors.textPrimary, fontWeight: '600', marginTop: 2 },
  signOutBtn: {
    marginTop: 28,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.error,
    backgroundColor: Colors.surface,
  },
  signOutText: { color: Colors.error, fontSize: 15, fontWeight: '800' },
});
