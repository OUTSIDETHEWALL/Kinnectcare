import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert, Modal, TextInput, ActivityIndicator } from 'react-native';
import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Icon } from '../src/Icon';
import { Colors } from '../src/theme';
import { useAuth } from '../src/AuthContext';
import { APP_NAME, COMPANY_NAME } from '../src/legal';
import { getBillingStatus, BillingStatus, api } from '../src/api';

export default function SettingsScreen() {
  const router = useRouter();
  const { user, logout } = useAuth();
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try { setBilling(await getBillingStatus()); } catch {}
    })();
  }, []);

  const planLabel = billing?.plan === 'family_plan' ? 'Family Plan' : 'Free Plan';
  const limitLine = billing
    ? billing.member_limit === null
      ? `${billing.member_count} members · unlimited`
      : `${billing.member_count} of ${billing.member_limit} members used`
    : '—';

  const confirmLogout = () => {
    Alert.alert('Sign out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: logout },
    ]);
  };

  const openDelete = () => {
    setDeleteConfirmText('');
    setDeleteError(null);
    setDeleteOpen(true);
  };

  const performDelete = async () => {
    if (deleting) return;
    if (deleteConfirmText.trim().toUpperCase() !== 'DELETE') {
      setDeleteError('Please type DELETE exactly to confirm.');
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.delete('/auth/account', { data: { confirm: 'DELETE' } });
      setDeleteOpen(false);
      // Clear the local session and redirect to welcome.
      await logout();
      router.replace('/');
    } catch (e: any) {
      setDeleteError(e?.response?.data?.detail || e?.message || 'Failed to delete account. Please try again.');
    } finally {
      setDeleting(false);
    }
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
          <Text style={styles.sectionLabel}>Plan</Text>
          <View style={[styles.planCard, billing?.plan === 'family_plan' && styles.planCardPaid]}>
            <View style={styles.planTop}>
              <View style={{ flex: 1 }}>
                <View style={styles.planNameRow}>
                  <Text style={styles.planName}>{planLabel}</Text>
                  <View style={[styles.planBadge, billing?.plan === 'family_plan' && styles.planBadgePaid]}>
                    <Text style={[styles.planBadgeText, billing?.plan === 'family_plan' && { color: Colors.surface }]}>
                      {billing?.plan === 'family_plan' ? '⭐ Active' : 'Free Tier'}
                    </Text>
                  </View>
                </View>
                <Text style={styles.planLimit}>{limitLine}</Text>
                {billing?.plan === 'family_plan' && billing?.current_period_end ? (
                  <Text style={styles.planRenewal}>
                    Renews {new Date(billing.current_period_end).toLocaleDateString()}
                  </Text>
                ) : null}
              </View>
            </View>

            {billing?.plan !== 'family_plan' ? (
              <>
                <Text style={styles.planPitch}>
                  Unlock unlimited family members, weekly compliance charts, and priority SOS push for just $9.99/month.
                </Text>
                <TouchableOpacity
                  testID="settings-view-plans"
                  style={styles.planCtaPrimary}
                  onPress={() => router.push('/upgrade')}
                  activeOpacity={0.85}
                >
                  <Text style={styles.planCtaPrimaryText}>View Plans & Upgrade</Text>
                  <Text style={styles.planCtaPrimaryArrow}>›</Text>
                </TouchableOpacity>
              </>
            ) : (
              <TouchableOpacity
                testID="settings-manage-plan"
                style={styles.planCtaSecondary}
                onPress={() => router.push('/upgrade')}
                activeOpacity={0.85}
              >
                <Text style={styles.planCtaSecondaryText}>Manage Subscription ›</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

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

        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: Colors.error }]}>Danger Zone</Text>
          <View style={[styles.card, { borderColor: '#F2C3C0' }]}>
            <NavRow
              testID="settings-delete-account"
              icon="🗑"
              label="Delete Account"
              onPress={openDelete}
              danger
            />
          </View>
          <Text style={styles.dangerHint}>
            Permanently delete your account and all associated data. This cannot be undone.
          </Text>
        </View>

        <Text style={styles.footer}>
          {APP_NAME} · © {new Date().getFullYear()} {COMPANY_NAME}
        </Text>
      </ScrollView>

      <Modal
        visible={deleteOpen}
        transparent
        animationType="fade"
        onRequestClose={() => !deleting && setDeleteOpen(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard} testID="delete-account-modal">
            <Text style={styles.modalEmoji}>⚠️</Text>
            <Text style={styles.modalTitle}>Delete your account?</Text>
            <Text style={styles.modalBody}>
              This will permanently delete your KinnectCare account and all related data:
              {'\n'}• family member profiles
              {'\n'}• medications, routines, and check-ins
              {'\n'}• alerts and SOS history
              {'\n'}• any active subscription (will be canceled)
              {'\n\n'}
              This action cannot be undone.
            </Text>
            <Text style={styles.modalConfirmLabel}>Type DELETE to confirm</Text>
            <TextInput
              testID="delete-confirm-input"
              value={deleteConfirmText}
              onChangeText={(t) => { setDeleteConfirmText(t); setDeleteError(null); }}
              autoCapitalize="characters"
              autoCorrect={false}
              placeholder="DELETE"
              placeholderTextColor={Colors.textTertiary}
              editable={!deleting}
              style={styles.modalInput}
            />
            {deleteError ? (
              <Text style={styles.modalError}>{deleteError}</Text>
            ) : null}
            <TouchableOpacity
              testID="delete-account-confirm"
              style={[
                styles.modalDanger,
                (deleteConfirmText.trim().toUpperCase() !== 'DELETE' || deleting) && { opacity: 0.5 },
              ]}
              onPress={performDelete}
              disabled={deleting || deleteConfirmText.trim().toUpperCase() !== 'DELETE'}
              activeOpacity={0.85}
            >
              {deleting ? (
                <ActivityIndicator color={Colors.surface} />
              ) : (
                <Text style={styles.modalDangerText}>Permanently delete account</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              testID="delete-account-cancel"
              style={styles.modalSecondary}
              onPress={() => !deleting && setDeleteOpen(false)}
              disabled={deleting}
              activeOpacity={0.7}
            >
              <Text style={styles.modalSecondaryText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
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
  planCard: {
    backgroundColor: Colors.surface, borderRadius: 14, padding: 16,
    borderWidth: 1, borderColor: Colors.border,
    boxShadow: '0px 4px 12px rgba(27,94,53,0.08)' as any,
  },
  planTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  planName: { fontSize: 16, fontWeight: '800', color: Colors.textPrimary },
  planLimit: { fontSize: 13, color: Colors.textSecondary, marginTop: 2 },
  planBadge: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 10, backgroundColor: Colors.tertiary },
  planBadgePaid: { backgroundColor: Colors.primary },
  planBadgeText: { fontSize: 12, fontWeight: '800', color: Colors.primary },
  planCta: { marginTop: 10, fontSize: 13, fontWeight: '700', color: Colors.primary },
  planCardPaid: { borderColor: Colors.primary, borderWidth: 2 },
  planNameRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 4 },
  planRenewal: { fontSize: 12, color: Colors.textTertiary, marginTop: 4, fontWeight: '600' },
  planPitch: {
    marginTop: 14, fontSize: 13, color: Colors.textSecondary,
    lineHeight: 19, paddingRight: 4,
  },
  planCtaPrimary: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    marginTop: 14, height: 50, borderRadius: 14, backgroundColor: Colors.primary,
    boxShadow: '0px 6px 12px rgba(27,94,53,0.2)' as any,
  },
  planCtaPrimaryText: { color: Colors.surface, fontSize: 15, fontWeight: '800' },
  planCtaPrimaryArrow: { color: Colors.surface, fontSize: 20, fontWeight: '700' },
  planCtaSecondary: {
    marginTop: 14, height: 46, borderRadius: 12, borderWidth: 2, borderColor: Colors.primary,
    alignItems: 'center', justifyContent: 'center', backgroundColor: 'transparent',
  },
  planCtaSecondaryText: { color: Colors.primary, fontSize: 14, fontWeight: '800' },
  dangerHint: {
    marginTop: 8, paddingHorizontal: 4,
    fontSize: 12, color: Colors.textTertiary, lineHeight: 18,
  },
  modalBackdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center', justifyContent: 'center', padding: 22,
  },
  modalCard: {
    width: '100%', maxWidth: 380, backgroundColor: Colors.surface,
    borderRadius: 18, padding: 22,
    boxShadow: '0px 12px 28px rgba(0,0,0,0.25)' as any,
  },
  modalEmoji: { fontSize: 36, textAlign: 'center', marginBottom: 4 },
  modalTitle: {
    fontSize: 19, fontWeight: '800', color: Colors.textPrimary, textAlign: 'center',
  },
  modalBody: {
    fontSize: 14, color: Colors.textSecondary, marginTop: 10,
    marginBottom: 14, lineHeight: 20,
  },
  modalConfirmLabel: {
    fontSize: 12, fontWeight: '800', color: Colors.textSecondary,
    letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 6,
  },
  modalInput: {
    backgroundColor: Colors.background, borderRadius: 12, padding: 14,
    fontSize: 16, fontWeight: '700', color: Colors.textPrimary,
    borderWidth: 1, borderColor: Colors.border, letterSpacing: 1,
  },
  modalError: { color: Colors.error, fontSize: 13, marginTop: 8, fontWeight: '600' },
  modalDanger: {
    marginTop: 14, height: 52, backgroundColor: Colors.error,
    borderRadius: 14, alignItems: 'center', justifyContent: 'center',
  },
  modalDangerText: { color: Colors.surface, fontSize: 16, fontWeight: '800' },
  modalSecondary: {
    marginTop: 10, alignItems: 'center', paddingVertical: 12,
  },
  modalSecondaryText: { color: Colors.textSecondary, fontSize: 15, fontWeight: '600' },
});
