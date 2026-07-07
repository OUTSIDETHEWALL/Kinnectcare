/**
 * Build #59 — "Add Family Member" is now an INVITATION form.
 *
 * Previous behaviour (Build #58 and earlier): tapping Add Family Member
 * silently created a local member row with no email, no invite, no
 * onboarding path.  Caregivers had no clear way to actually invite
 * anyone — this was the #1 P1 blocker reported for the Closed Beta.
 *
 * New behaviour (Build #59, per user spec):
 *   1. Enter Name, Email, Relationship, and pick Family / Senior.
 *   2. Tap "Send Invitation".
 *   3. Backend generates a single-use INV-XXXXXX token, saves the
 *      pending invite, and delivers a senior-friendly email with a
 *      big "Accept Invitation" button (deep link into the app) plus
 *      a Play Store install fallback.
 *   4. Caregiver returns to Dashboard where the pending invite now
 *      shows as "🟡 Invitation Pending" until accepted.
 *
 * Manual code-typing is preserved as a fallback ONLY — the primary
 * onboarding path is one tap.
 */
import { useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, ScrollView,
  KeyboardAvoidingView, Platform, ActivityIndicator, Modal,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Icon } from '../src/Icon';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors } from '../src/theme';
import { sendFamilyInvite, isPaywall } from '../src/api';

type Role = 'family' | 'senior';

export default function AddFamilyMember() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [relationship, setRelationship] = useState('');
  const [role, setRole] = useState<Role>('family');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paywallMsg, setPaywallMsg] = useState<string | null>(null);
  const [successOpen, setSuccessOpen] = useState(false);
  const [sentInfo, setSentInfo] = useState<{ name: string; email: string; delivered: boolean; token: string } | null>(null);

  const emailValid = /\S+@\S+\.\S+/.test(email.trim());
  const canSubmit = !!name.trim() && emailValid && !loading;

  const onSubmit = async () => {
    setError(null);
    const n = name.trim();
    const e = email.trim().toLowerCase();
    if (n.length < 2) { setError('Please enter their name.'); return; }
    if (!emailValid) { setError('Please enter a valid email address.'); return; }
    setLoading(true);
    try {
      const r = await sendFamilyInvite({
        name: n,
        email: e,
        relationship: relationship.trim() || undefined,
        role,
      });
      setSentInfo({
        name: n,
        email: e,
        delivered: !!r.delivered,
        token: r.invite?.token || '',
      });
      setSuccessOpen(true);
    } catch (err: any) {
      const pw = isPaywall(err);
      if (pw) {
        setPaywallMsg(pw.message);
      } else {
        setError(
          err?.response?.data?.detail
          || err?.message
          || 'Something went wrong. Please try again.'
        );
      }
    } finally {
      setLoading(false);
    }
  };

  const onDoneAndClose = () => {
    setSuccessOpen(false);
    router.back();
  };

  const relationshipSuggestions = ['Mom', 'Dad', 'Spouse', 'Son', 'Daughter', 'Sibling'];

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <View style={styles.header}>
          <TouchableOpacity testID="invite-back" onPress={() => router.back()} style={styles.iconBtn}>
            <Icon name="close" size={26} color={Colors.textPrimary} />
          </TouchableOpacity>
          <Text style={styles.title}>Invite Family Member</Text>
          <View style={{ width: 44 }} />
        </View>

        <ScrollView contentContainerStyle={{ padding: 24, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
          <View style={styles.heroBanner}>
            <Text style={styles.heroEmoji}>✉️</Text>
            <Text style={styles.heroTitle}>Send them an invitation</Text>
            <Text style={styles.heroSub}>
              We&apos;ll email a one-tap join link. They open the email, tap
              <Text style={{ fontWeight: '800' }}> Accept Invitation</Text>,
              and join your family automatically.
            </Text>
          </View>

          <Field label="Their full name" testID="invite-name">
            <TextInput
              testID="invite-name-input"
              value={name}
              onChangeText={setName}
              placeholder="e.g. Joyce Miller"
              placeholderTextColor={Colors.textTertiary}
              style={styles.input}
              autoCapitalize="words"
              autoCorrect={false}
            />
          </Field>

          <Field label="Their email address" testID="invite-email">
            <TextInput
              testID="invite-email-input"
              value={email}
              onChangeText={setEmail}
              placeholder="e.g. joyce@example.com"
              placeholderTextColor={Colors.textTertiary}
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
            />
          </Field>

          <Field label="Relationship (optional)" testID="invite-relationship">
            <TextInput
              testID="invite-relationship-input"
              value={relationship}
              onChangeText={setRelationship}
              placeholder="e.g. Mom, Dad, Spouse"
              placeholderTextColor={Colors.textTertiary}
              style={styles.input}
              autoCapitalize="words"
              autoCorrect={false}
            />
            <View style={styles.suggestionRow}>
              {relationshipSuggestions.map(s => (
                <TouchableOpacity
                  key={s}
                  testID={`rel-suggest-${s.toLowerCase()}`}
                  style={[
                    styles.suggestionPill,
                    relationship.toLowerCase() === s.toLowerCase() && styles.suggestionPillActive,
                  ]}
                  onPress={() => setRelationship(s)}
                  activeOpacity={0.85}
                >
                  <Text style={[
                    styles.suggestionText,
                    relationship.toLowerCase() === s.toLowerCase() && styles.suggestionTextActive,
                  ]}>{s}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </Field>

          <Text style={styles.label}>Who are they?</Text>
          <View style={styles.roleRow}>
            <RoleCard
              testID="role-family"
              active={role === 'family'}
              onPress={() => setRole('family')}
              emoji="👨‍👩‍👧"
              title="Family Member"
              subtitle="Adult caregiver — receives alerts about seniors."
            />
            <RoleCard
              testID="role-senior"
              active={role === 'senior'}
              onPress={() => setRole('senior')}
              emoji="👴"
              title="Senior"
              subtitle="Loved one being cared for — check-ins & meds."
            />
          </View>

          {error ? (
            <View style={styles.errorBox} testID="invite-error">
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <TouchableOpacity
            testID="invite-submit"
            onPress={onSubmit}
            activeOpacity={0.85}
            style={[styles.cta, !canSubmit && styles.ctaDisabled]}
            disabled={!canSubmit}
          >
            {loading
              ? <ActivityIndicator color={Colors.surface} />
              : <Text style={styles.ctaText}>✉️  Send Invitation</Text>}
          </TouchableOpacity>

          <Text style={styles.footnote}>
            The invitation expires in 7 days. No account is created
            until they accept. You can cancel or resend from the
            dashboard at any time.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Paywall modal */}
      <Modal
        visible={!!paywallMsg}
        transparent
        animationType="fade"
        onRequestClose={() => setPaywallMsg(null)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard} testID="paywall-modal">
            <Text style={styles.modalEmoji}>⭐</Text>
            <Text style={styles.modalTitle}>Upgrade to invite more members</Text>
            <Text style={styles.modalBody}>
              {paywallMsg || "You've reached the free plan limit. Upgrade to the Family Plan for unlimited members."}
            </Text>
            <TouchableOpacity
              testID="paywall-see-plans"
              style={styles.modalPrimary}
              onPress={() => { setPaywallMsg(null); router.push('/upgrade'); }}
              activeOpacity={0.85}
            >
              <Text style={styles.modalPrimaryText}>See Plans</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="paywall-dismiss"
              style={styles.modalSecondary}
              onPress={() => setPaywallMsg(null)}
              activeOpacity={0.7}
            >
              <Text style={styles.modalSecondaryText}>Maybe later</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Success modal */}
      <Modal
        visible={successOpen}
        transparent
        animationType="fade"
        onRequestClose={onDoneAndClose}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard} testID="invite-success-modal">
            <Text style={styles.modalEmoji}>✅</Text>
            <Text style={styles.modalTitle}>Invitation sent!</Text>
            {sentInfo?.delivered ? (
              <Text style={styles.modalBody}>
                We emailed <Text style={{ fontWeight: '700' }}>{sentInfo.name}</Text>{'\n'}
                at <Text style={{ fontWeight: '700' }}>{sentInfo.email}</Text>.{'\n\n'}
                Ask them to open the email and tap the big green
                <Text style={{ fontWeight: '800' }}> Accept Invitation </Text>
                button — they&apos;ll join automatically.
              </Text>
            ) : (
              <Text style={styles.modalBody}>
                We saved the invitation, but couldn&apos;t deliver the email
                right now.{'\n\n'}Share this backup code with{' '}
                <Text style={{ fontWeight: '700' }}>{sentInfo?.name}</Text>{' '}
                so they can enter it manually during sign-up:{'\n\n'}
                <Text style={styles.tokenCode}>{sentInfo?.token}</Text>
              </Text>
            )}
            <TouchableOpacity
              testID="invite-success-done"
              style={styles.modalPrimary}
              onPress={onDoneAndClose}
              activeOpacity={0.85}
            >
              <Text style={styles.modalPrimaryText}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function Field({ label, testID, children }: any) {
  return (
    <View testID={testID} style={{ marginTop: 20 }}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
}

function RoleCard(props: {
  testID: string; active: boolean; onPress: () => void;
  emoji: string; title: string; subtitle: string;
}) {
  return (
    <TouchableOpacity
      testID={props.testID}
      onPress={props.onPress}
      activeOpacity={0.85}
      style={[styles.roleCard, props.active && styles.roleCardActive]}
    >
      <Text style={styles.roleEmoji}>{props.emoji}</Text>
      <Text style={[styles.roleTitle, props.active && { color: Colors.primary }]}>{props.title}</Text>
      <Text style={styles.roleSub}>{props.subtitle}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8,
  },
  iconBtn: {
    width: 52, height: 52, borderRadius: 26,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: Colors.surface,
    borderWidth: 1, borderColor: Colors.border,
  },
  title: { fontSize: 18, fontWeight: '700', color: Colors.textPrimary },

  heroBanner: {
    backgroundColor: '#F1F8E9',
    borderRadius: 16, padding: 20,
    borderWidth: 1, borderColor: '#C5E1A5',
    marginBottom: 8,
  },
  heroEmoji: { fontSize: 30 },
  heroTitle: {
    fontSize: 18, fontWeight: '800', color: Colors.primary,
    marginTop: 8,
  },
  heroSub: {
    fontSize: 14, color: Colors.textSecondary,
    marginTop: 6, lineHeight: 20,
  },

  label: {
    fontSize: 13, fontWeight: '700',
    color: Colors.textSecondary, marginBottom: 10, marginTop: 8,
    textTransform: 'uppercase', letterSpacing: 0.6,
  },
  input: {
    backgroundColor: Colors.surface, borderRadius: 14, padding: 16,
    fontSize: 16, color: Colors.textPrimary,
    borderWidth: 1, borderColor: Colors.border,
  },

  suggestionRow: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 8,
    marginTop: 10,
  },
  suggestionPill: {
    paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: 20, borderWidth: 1,
    borderColor: Colors.border, backgroundColor: Colors.surface,
  },
  suggestionPillActive: {
    backgroundColor: Colors.primary, borderColor: Colors.primary,
  },
  suggestionText: { fontSize: 13, color: Colors.textSecondary, fontWeight: '600' },
  suggestionTextActive: { color: Colors.surface, fontWeight: '700' },

  roleRow: { flexDirection: 'row', gap: 12 },
  roleCard: {
    flex: 1, padding: 16, borderRadius: 16,
    borderWidth: 2, borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  roleCardActive: {
    borderColor: Colors.primary,
    backgroundColor: '#F1F8E9',
  },
  roleEmoji: { fontSize: 30 },
  roleTitle: {
    fontSize: 15, fontWeight: '800',
    color: Colors.textPrimary, marginTop: 6,
  },
  roleSub: {
    fontSize: 12, color: Colors.textSecondary,
    marginTop: 4, lineHeight: 16,
  },

  errorBox: {
    marginTop: 20, padding: 14, borderRadius: 12,
    backgroundColor: '#fdecea', borderWidth: 1, borderColor: '#f5c6cb',
  },
  errorText: { color: '#b00020', fontSize: 14, fontWeight: '600' },

  cta: {
    marginTop: 28, height: 62, backgroundColor: Colors.primary,
    borderRadius: 18, alignItems: 'center', justifyContent: 'center',
    shadowColor: Colors.primary, shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.24, shadowRadius: 10, elevation: 4,
  },
  ctaDisabled: { opacity: 0.5, shadowOpacity: 0 },
  ctaText: { color: Colors.surface, fontSize: 18, fontWeight: '800', letterSpacing: 0.3 },

  footnote: {
    marginTop: 18, textAlign: 'center',
    fontSize: 12, color: Colors.textTertiary, lineHeight: 18,
  },

  modalBackdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center', justifyContent: 'center', padding: 24,
  },
  modalCard: {
    width: '100%', maxWidth: 380, backgroundColor: Colors.surface,
    borderRadius: 20, padding: 24, alignItems: 'center',
  },
  modalEmoji: { fontSize: 44, marginBottom: 6 },
  modalTitle: {
    fontSize: 20, fontWeight: '800',
    color: Colors.textPrimary, textAlign: 'center',
  },
  modalBody: {
    fontSize: 15, color: Colors.textSecondary, textAlign: 'center',
    marginTop: 10, marginBottom: 22, lineHeight: 22,
  },
  tokenCode: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontSize: 20, fontWeight: '800', color: Colors.primary,
    letterSpacing: 2,
  },
  modalPrimary: {
    height: 52, alignSelf: 'stretch', backgroundColor: Colors.primary,
    borderRadius: 14, alignItems: 'center', justifyContent: 'center',
  },
  modalPrimaryText: { color: Colors.surface, fontSize: 16, fontWeight: '800' },
  modalSecondary: {
    marginTop: 10, alignSelf: 'stretch',
    alignItems: 'center', paddingVertical: 12,
  },
  modalSecondaryText: { color: Colors.textSecondary, fontSize: 15, fontWeight: '600' },
});
