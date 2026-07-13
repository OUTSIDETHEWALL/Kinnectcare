/**
 * signup.tsx — passwordless email-OTP sign-up.
 *
 * Collects name + email + optional invite code, then sends a 6-digit
 * verification code to the email. The account is actually CREATED
 * on the backend only after the user successfully types the OTP on
 * the next screen — so an unverified email can never become an
 * account. (See /api/auth/verify-otp.)
 */
import { useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, KeyboardAvoidingView,
  Platform, ScrollView, ActivityIndicator, Alert,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Icon } from '../../src/Icon';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors } from '../../src/theme';
import { useAuth } from '../../src/AuthContext';

export default function Signup() {
  const router = useRouter();
  const { requestOtp } = useAuth();
  // Pre-fill from join-family.tsx pre-account invite flow (Fix #2 v1.2).
  // The user has already validated their INV-/KINN- code against the
  // public /verify-invite endpoint by the time they land here, so we
  // bake the code into the form (and pre-fill the email for per-invite
  // INV codes that carry the address they were issued to).
  const params = useLocalSearchParams<{
    invite_token?: string;
    email?: string;
    family_name?: string;
    inviter_name?: string;
  }>();
  const [name, setName] = useState('');
  const [email, setEmail] = useState(String(params?.email || ''));
  const [inviteCode, setInviteCode] = useState(String(params?.invite_token || ''));
  const [loading, setLoading] = useState(false);

  // Invite-flow detection.  When the user arrives from join-family.tsx
  // (after previewing the family card) we know:
  //   • invite_token — the code, already verified against the backend
  //   • email        — pre-filled for per-recipient INV- codes; empty
  //                    for family-wide KINN- codes
  //   • family_name  — the target family's display name
  //   • inviter_name — who sent the invite (optional)
  //
  // In invite-flow mode we:
  //   1. Streamline the title / subtitle to carry family context.
  //   2. Hide the invite-code field (already confirmed, passed silently).
  //   3. Hide the email field when it's pre-filled (INV- codes).
  //   4. Hide the "Already have an account?" link (wrong audience).
  const isInviteFlow = !!(params?.invite_token || '').trim();
  const emailPreFilled = !!(params?.email || '').trim();
  const familyName = String(params?.family_name || '');
  const inviterName = String(params?.inviter_name || '');

  const onSubmit = async () => {
    const nameTrim = (name || '').trim();
    const emailTrim = (email || '').trim().toLowerCase();
    if (!nameTrim) {
      Alert.alert('Name needed', 'Please enter your name so your family knows who you are.');
      return;
    }
    if (!emailTrim || !/^\S+@\S+\.\S+$/.test(emailTrim)) {
      Alert.alert('Email needed', "Please enter a valid email address — we'll send your verification code there.");
      return;
    }
    setLoading(true);
    try {
      await requestOtp({
        email: emailTrim,
        purpose: 'signup',
        fullName: nameTrim,
        inviteCode: inviteCode.trim() || undefined,
      });
      router.push({
        pathname: '/(auth)/otp-verify',
        params: {
          email: emailTrim,
          purpose: 'signup',
          fullName: nameTrim,
          inviteCode: inviteCode.trim() || '',
        },
      } as any);
    } catch (e: any) {
      const status = e?.response?.status;
      const detail = e?.response?.data?.detail || '';
      const code = e?.code || '';
      if (status === 410) {
        Alert.alert('Update required', detail);
      } else if (status === 429) {
        Alert.alert('Please wait', detail || 'You requested a code recently. Try again in a few seconds.');
      } else if (code === 'ECONNABORTED' || /timeout/i.test(String(e?.message || ''))) {
        Alert.alert(
          'Network timeout',
          "We couldn't reach the Kinnship servers. Please check your Wi-Fi or cellular signal and try again.",
        );
      } else if (!status) {
        Alert.alert(
          'No connection',
          `We couldn't reach the Kinnship servers (${e?.message || 'unknown error'}). Please check your connection and try again.`,
        );
      } else {
        Alert.alert('Could not create account', detail || `Server returned ${status}. Please try again.`);
      }
    } finally {
      setLoading(false);
    }
  };

  // ── Invite-flow: full-screen redesign ──────────────────────────────────
  // The person who sent the invite already provided the trust context —
  // the app does not need to sell itself.  It needs to help them succeed.
  if (isInviteFlow) {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={{ flex: 1 }}
        >
          <ScrollView
            contentContainerStyle={styles.inviteScroll}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {/* Hero — family context is the first thing they read.
                Copy reads like a real person sent this, not a system. */}
            <View style={styles.inviteHero}>
              <Text style={styles.inviteEmoji}>💚</Text>
              <Text style={styles.inviteByLine}>
                {inviterName
                  ? `${inviterName} invited you to join`
                  : "You've been invited to join"}
              </Text>
              <Text style={styles.inviteHeadline}>
                <Text style={styles.inviteFamilyName}>
                  {familyName || 'your family'}
                </Text>
              </Text>
            </View>

            {/* Single field — name only (email pre-filled for INV- codes) */}
            <View style={styles.inviteForm}>
              <Text style={styles.inviteFieldLabel}>What should we call you?</Text>
              <TextInput
                testID="signup-name"
                style={styles.inviteInput}
                value={name}
                onChangeText={setName}
                placeholder="Your name"
                placeholderTextColor={Colors.textTertiary}
                autoCapitalize="words"
                autoFocus
                returnKeyType="done"
                onSubmitEditing={onSubmit}
              />

              {/* Email field shown only when not pre-filled (KINN- codes) */}
              {!emailPreFilled && (
                <>
                  <Text style={[styles.inviteFieldLabel, { marginTop: 16 }]}>Email address</Text>
                  <TextInput
                    testID="signup-email"
                    style={styles.inviteInput}
                    value={email}
                    onChangeText={setEmail}
                    placeholder="you@example.com"
                    placeholderTextColor={Colors.textTertiary}
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoCorrect={false}
                    textContentType="emailAddress"
                    autoComplete="email"
                  />
                </>
              )}

              <TouchableOpacity
                testID="signup-submit"
                style={styles.inviteCta}
                onPress={onSubmit}
                disabled={loading}
                activeOpacity={0.85}
              >
                {loading
                  ? <ActivityIndicator color={Colors.surface} />
                  : <Text style={styles.inviteCtaText}>Send me a verification code</Text>}
              </TouchableOpacity>

              <Text style={styles.agreement}>
                By joining, you agree to our{' '}
                <Text
                  testID="signup-to-terms"
                  style={styles.agreementLink}
                  onPress={() => router.push('/terms-of-service')}
                >
                  Terms of Service
                </Text>
                {' '}and{' '}
                <Text
                  testID="signup-to-privacy"
                  style={styles.agreementLink}
                  onPress={() => router.push('/privacy-policy')}
                >
                  Privacy Policy
                </Text>
                .
              </Text>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  // ── Standard sign-up flow (non-invite) ─────────────────────────────────
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <TouchableOpacity testID="signup-back" onPress={() => router.back()} style={styles.back}>
            <Icon name="arrow-back" size={28} color={Colors.textPrimary} />
          </TouchableOpacity>
          <Text style={styles.title}>Create your account</Text>
          <Text style={styles.subtitle}>
            No password to remember — we'll email you a 6-digit code instead.
          </Text>

          <Field
            label="Your name"
            value={name}
            onChangeText={setName}
            placeholder="Jane Smith"
            testID="signup-name"
            autoCapitalize="words"
          />

          <Field
            label="Email"
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            textContentType="emailAddress"
            autoComplete="email"
            testID="signup-email"
          />

          <Field
            label="Family invite code (optional)"
            value={inviteCode}
            onChangeText={(v: string) => setInviteCode(v.toUpperCase())}
            placeholder="KINN-XXXXXX"
            autoCapitalize="characters"
            testID="signup-invite-code"
          />
          {inviteCode.trim() ? (
            <Text style={styles.inviteHint}>
              👨‍👩‍👧 You'll join an existing family and see their members & alerts immediately.
            </Text>
          ) : null}

          <TouchableOpacity
            testID="signup-submit"
            style={styles.cta}
            onPress={onSubmit}
            disabled={loading}
            activeOpacity={0.85}
          >
            {loading
              ? <ActivityIndicator color={Colors.surface} />
              : <Text style={styles.ctaText}>Email me a code</Text>}
          </TouchableOpacity>

          <Text style={styles.agreement}>
            By creating an account, you agree to our{' '}
            <Text testID="signup-to-terms" style={styles.agreementLink} onPress={() => router.push('/terms-of-service')}>
              Terms of Service
            </Text>{' '}
            and{' '}
            <Text testID="signup-to-privacy" style={styles.agreementLink} onPress={() => router.push('/privacy-policy')}>
              Privacy Policy
            </Text>
            .
          </Text>

          <TouchableOpacity
            testID="signup-to-login"
            onPress={() => router.replace('/(auth)/login')}
            style={{ marginTop: 18, alignItems: 'center' }}
          >
            <Text style={styles.link}>
              Already have an account?{' '}
              <Text style={{ fontWeight: '700', color: Colors.primary }}>Sign in</Text>
            </Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Field(props: any) {
  return (
    <View style={{ marginTop: 16 }}>
      <Text style={styles.label}>{props.label}</Text>
      <TextInput
        {...props}
        style={styles.input}
        placeholderTextColor={Colors.textTertiary}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  scroll: { padding: 24, paddingBottom: 48 },
  back: { width: 52, height: 52, justifyContent: 'center' },
  title: { fontSize: 28, fontWeight: '800', color: Colors.textPrimary, marginTop: 8 },
  subtitle: { fontSize: 16, color: Colors.textSecondary, marginTop: 6, marginBottom: 8, lineHeight: 22 },
  label: {
    fontSize: 13, fontWeight: '700', color: Colors.textSecondary,
    marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5,
  },
  input: {
    backgroundColor: Colors.surface, borderRadius: 14, padding: 16, fontSize: 16,
    color: Colors.textPrimary, borderWidth: 1, borderColor: Colors.border,
  },
  cta: {
    marginTop: 28, height: 58, borderRadius: 16, backgroundColor: Colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  ctaText: { color: Colors.surface, fontSize: 17, fontWeight: '700' },
  link: { color: Colors.textSecondary, fontSize: 15 },
  agreement: {
    fontSize: 12, color: Colors.textTertiary, textAlign: 'center',
    marginTop: 14, paddingHorizontal: 6, lineHeight: 18,
  },
  agreementLink: { color: Colors.primary, fontWeight: '700', textDecorationLine: 'underline' },
  inviteHint: { fontSize: 12, color: Colors.success, marginTop: 8, lineHeight: 18 },
  // ── Invite-flow styles ────────────────────────────────────────────────
  inviteScroll: {
    flexGrow: 1,
    paddingBottom: 40,
  },
  inviteHero: {
    alignItems: 'center',
    paddingTop: 48,
    paddingHorizontal: 28,
    paddingBottom: 32,
    backgroundColor: Colors.tertiary,
  },
  inviteEmoji: {
    fontSize: 64,
    marginBottom: 12,
  },
  inviteByLine: {
    fontSize: 16,
    fontWeight: '600',
    color: Colors.textSecondary,
    textAlign: 'center',
    marginBottom: 4,
  },
  inviteHeadline: {
    fontSize: 26,
    fontWeight: '700',
    color: Colors.textPrimary,
    textAlign: 'center',
    lineHeight: 34,
  },
  inviteFamilyName: {
    fontSize: 30,
    fontWeight: '800',
    color: Colors.primary,
  },
  inviteForm: {
    paddingHorizontal: 24,
    paddingTop: 28,
  },
  inviteFieldLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.textSecondary,
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  inviteInput: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    padding: 16,
    fontSize: 18,
    color: Colors.textPrimary,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  inviteCta: {
    marginTop: 28,
    height: 60,
    borderRadius: 18,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.24,
    shadowRadius: 10,
    elevation: 4,
  },
  inviteCtaText: {
    color: Colors.surface,
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
  // ── Legacy invite-flow styles (kept for compatibility) ────────────────
  familyBanner: {
    marginTop: 12,
    marginBottom: 4,
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderRadius: 14,
    backgroundColor: Colors.tertiary,
    alignItems: 'center',
  },
  familyBannerLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  familyBannerName: {
    fontSize: 22,
    fontWeight: '800',
    color: Colors.primary,
    marginTop: 4,
  },
  familyBannerInviter: {
    fontSize: 14,
    color: Colors.textSecondary,
    marginTop: 4,
  },
});
